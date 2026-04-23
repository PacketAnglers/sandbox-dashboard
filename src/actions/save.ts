/**
 * Save action — capture the currently-deployed lab's running configs
 * via `containerlab save`, then bundle the entire workspace (including
 * the newly-written config files) as a .tar.gz.
 *
 * Save exists so a user who has labbed, configured, and validated
 * something live can produce a single artefact that captures that
 * *exact* state — topology + running configs — for sharing,
 * archiving, or later reimport.
 *
 * Flow:
 *   1. Resolve workspace root (bail if none open).
 *   2. Require a deployed lab. If zero labs are running, toast an
 *      explainer — Save needs something to save from. The button's
 *      enablement filters this case at the UI level too.
 *   3. If multiple labs are deployed, showQuickPick. One deployed
 *      lab → use it silently.
 *   4. Spawn `sudo -n containerlab save -t <topology-path>`.
 *      containerlab walks each running node and writes its current
 *      running config to a file under clab-<labname>/<nodename>/.
 *      The -n flag keeps sudo non-interactive: passwordless sudo
 *      required, fails fast otherwise.
 *   5. If save succeeds, show a save dialog defaulting to
 *        <workspace-name>-saved-YYYY-MM-DD-HHMM.tar.gz
 *      and bundle the whole workspace via runTar() — but with a
 *      SHORTER exclude list (DEFAULT_SAVE_EXCLUDES) that keeps
 *      clab-* directories, since they now contain the captured
 *      configs that are the whole point of this action.
 *   6. Success/failure UX mirrors Export's: "Reveal in File Explorer"
 *      action on success, "View Log" on failure, quiet exit on cancel.
 *
 * Why not just bundle without running containerlab save first?
 *   Because stale clab-* directories from earlier deploys may not
 *   reflect the current runtime state. containerlab save FORCES a
 *   fresh snapshot. Without it, Save would silently ship
 *   possibly-outdated configs — the worst kind of sharing artefact,
 *   one that looks current but isn't.
 *
 * Why both a save dialog AND `containerlab save`?
 *   Two independent "save" concepts that share a name. `containerlab
 *   save` writes configs into the workspace; the VS Code save dialog
 *   picks where the TARBALL goes. Keeping both steps makes the action
 *   a single click from the user's perspective while preserving both
 *   semantics.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

import {
    DEFAULT_SAVE_EXCLUDES,
    getDefaultDir,
    runTar,
    timestamp,
} from './export';

export async function runSave(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: save');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Save bundles the workspace, so there has to be one.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;
    const workspaceName = path.basename(workspaceRoot);

    // ── Identify the lab to save ───────────────────────────────────────────
    // We ask containerlab directly rather than reading StateRefresher's
    // cache. The refresher's view could be stale by up to 30s, and Save is
    // the one action where "ship-exactly-the-right-lab" hygiene matters
    // most — we don't want to save configs against a topology the user
    // destroyed 20 seconds ago.
    const deployed = await inspectDeployedLabs(output);
    if (deployed.length === 0) {
        vscode.window.showInformationMessage(
            'No lab is currently deployed. Start a lab first (or use Export to bundle without capturing configs).',
        );
        return;
    }

    let topologyPath: string;
    let labName: string;
    if (deployed.length === 1) {
        topologyPath = deployed[0].topologyPath;
        labName = deployed[0].name;
    } else {
        const items = deployed.map((d) => ({
            label: d.name,
            description: `${d.nodeCount} node${d.nodeCount === 1 ? '' : 's'} · ${d.topologyPath}`,
            lab: d,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: 'Pick a lab to save',
            placeHolder: 'Which deployed lab do you want to save?',
            matchOnDescription: true,
        });
        if (!picked) {
            output.appendLine('[sandboxDashboard] save cancelled by user (no lab picked)');
            return;
        }
        topologyPath = picked.lab.topologyPath;
        labName = picked.lab.name;
    }
    output.appendLine(`[sandboxDashboard] save: lab "${labName}" (topology ${topologyPath})`);

    // The topology path as reported by containerlab may be relative to wherever
    // containerlab was invoked. For `containerlab save -t`, containerlab is
    // tolerant of either absolute or workspace-relative paths, so we pass
    // whatever it gave us back verbatim. If that ever bites us, we can
    // resolve against workspaceRoot here.

    // ── Capture running configs ────────────────────────────────────────────
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Capturing configs from ${labName}…`,
                cancellable: false,
            },
            (progress) => runContainerlabSave(topologyPath, workspaceRoot, output, progress),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] containerlab save failed: ${msg}`);

        const isSudoAuth =
            /a password is required/i.test(msg) ||
            /sudo:.*required/i.test(msg) ||
            /no tty present/i.test(msg);
        const display = isSudoAuth
            ? 'Save failed: passwordless sudo is not configured for containerlab. ' +
              'Ask a lab admin to set up NOPASSWD sudo for the containerlab binary.'
            : `Save failed (containerlab save): ${msg}`;

        const action = await vscode.window.showErrorMessage(display, 'View Log');
        if (action === 'View Log') output.show();
        return;
    }

    // ── Pick tarball destination ───────────────────────────────────────────
    const defaultName = `${workspaceName}-saved-${timestamp()}.tar.gz`;
    const defaultUri = vscode.Uri.file(path.join(getDefaultDir(), defaultName));
    const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'Tarball': ['tar.gz', 'tgz'] },
        title: `Save lab "${labName}" as tarball`,
        saveLabel: 'Save',
    });

    if (!targetUri) {
        // User captured configs but declined to bundle. That's fine — configs
        // are on disk and they can Export later. Quiet exit.
        output.appendLine('[sandboxDashboard] save: configs captured, tarball skipped (user cancelled save dialog)');
        vscode.window.showInformationMessage(
            `Configs captured for ${labName}. Tarball skipped — you can Export the workspace anytime.`,
        );
        return;
    }
    const targetPath = targetUri.fsPath;

    // ── Bundle with the save-specific exclude list (keeps clab-*) ──────────
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Bundling saved lab…',
                cancellable: false,
            },
            () => runTar(workspaceRoot, targetPath, DEFAULT_SAVE_EXCLUDES, output),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] save tarball failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Save succeeded but bundling failed: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') output.show();
        return;
    }

    // ── Success ────────────────────────────────────────────────────────────
    output.appendLine(`[sandboxDashboard] save complete: ${targetPath}`);
    const action = await vscode.window.showInformationMessage(
        `Saved ${labName} → ${path.basename(targetPath)}`,
        'Reveal in File Explorer',
    );
    if (action === 'Reveal in File Explorer') {
        await vscode.commands.executeCommand('revealFileInOS', targetUri);
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Minimal record of a currently-deployed lab, for the picker.
 * This intentionally doesn't reuse the DeployedLab type from types.ts —
 * keeping Save self-contained makes it trivially obvious what fields
 * it needs, and the type is tiny.
 */
interface SavableLab {
    name: string;
    topologyPath: string;
    nodeCount: number;
}

/**
 * Ask containerlab for the list of currently-deployed labs.
 * Uses `sudo -n containerlab inspect --all --format json`.
 *
 * Returns [] if containerlab is unavailable, if no labs are deployed,
 * or if anything goes wrong — Save treats all three cases the same
 * (no lab to save, show the explainer toast). The output channel logs
 * the reason for diagnosability.
 */
async function inspectDeployedLabs(output: vscode.OutputChannel): Promise<SavableLab[]> {
    return new Promise((resolve) => {
        // No -n here — `containerlab inspect` is sometimes available to the
        // user without sudo, and if it needs sudo we'd rather the failure
        // mode be "no lab found" than "save bails on password prompt". The
        // Start action uses sudo -n because deploy always needs root; inspect
        // is more forgiving in practice.
        const child = spawn('containerlab', ['inspect', '--all', '--format', 'json'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        child.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
        child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

        child.on('error', (err) => {
            output.appendLine(`[sandboxDashboard] inspect spawn error: ${err.message}`);
            resolve([]);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                output.appendLine(`[sandboxDashboard] inspect exit ${code}: ${stderrBuf.trim()}`);
                resolve([]);
                return;
            }
            const trimmed = stdoutBuf.trim();
            if (!trimmed) { resolve([]); return; }

            let parsed: unknown;
            try { parsed = JSON.parse(trimmed); } catch (err) {
                output.appendLine(`[sandboxDashboard] inspect JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
                resolve([]);
                return;
            }
            resolve(extractLabs(parsed));
        });
    });
}

/**
 * Extract SavableLab records from containerlab's inspect output.
 *
 * Mirrors the shape-recognition logic in src/containerlab.ts (supports
 * bare array, { containers: [] }, keyed-by-lab, empty object) but
 * returns the lightweight SavableLab struct instead of the fuller
 * DeployedLab. Kept local so Save doesn't import the state module
 * and create a circular-ish dependency between actions and state
 * computation.
 */
function extractLabs(parsed: unknown): SavableLab[] {
    let containers: unknown[] = [];
    if (Array.isArray(parsed)) {
        containers = parsed;
    } else if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.containers)) {
            containers = obj.containers;
        } else {
            // keyed-by-lab shape: flatten all values that are arrays.
            for (const v of Object.values(obj)) {
                if (Array.isArray(v)) containers.push(...v);
            }
        }
    }

    const byLab = new Map<string, SavableLab>();
    for (const entry of containers) {
        if (entry === null || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const labName = typeof rec.lab_name === 'string' ? rec.lab_name
            : typeof rec.labName === 'string' ? rec.labName : undefined;
        if (!labName) continue;
        const topologyPath = typeof rec.labPath === 'string' ? rec.labPath
            : typeof rec.lab_path === 'string' ? rec.lab_path : '';
        const existing = byLab.get(labName);
        if (existing) {
            existing.nodeCount += 1;
        } else {
            byLab.set(labName, { name: labName, topologyPath, nodeCount: 1 });
        }
    }
    return Array.from(byLab.values());
}

/**
 * Spawn `sudo -n containerlab save -t <topology>`.
 *
 * Streams output to the channel and surfaces the latest line as the
 * progress message — same pattern Start uses. Resolves on exit 0.
 */
function runContainerlabSave(
    topologyPath: string,
    workspaceRoot: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = ['-n', 'containerlab', 'save', '-t', topologyPath];
        output.appendLine(`[sandboxDashboard] sudo ${args.join(' ')}`);

        // Run from the workspace root so any relative paths in the topology
        // resolve the same way they did at deploy time.
        const child = spawn('sudo', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: workspaceRoot,
        });

        let stderrBuf = '';
        let lineBuffer = '';

        const onChunk = (chunk: Buffer, isStderr: boolean) => {
            const text = chunk.toString();
            if (isStderr) stderrBuf += text;

            lineBuffer += text;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trimEnd();
                if (!line) continue;
                output.appendLine(`[clab] ${line}`);
                progress.report({ message: truncate(line, 80) });
            }
        };

        child.stdout.on('data', (c) => onChunk(c, false));
        child.stderr.on('data', (c) => onChunk(c, true));

        child.on('error', (err) => {
            reject(new Error(`could not spawn sudo: ${err.message}`));
        });

        child.on('close', (code) => {
            if (lineBuffer.trim()) {
                output.appendLine(`[clab] ${lineBuffer.trim()}`);
            }
            if (code === 0) {
                resolve();
            } else {
                const stderrLines = stderrBuf
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0);
                const headline = stderrLines.pop() || `exit ${code}`;
                reject(new Error(headline));
            }
        });
    });
}

/** Truncate a string to max length, adding ellipsis if trimmed. */
function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
