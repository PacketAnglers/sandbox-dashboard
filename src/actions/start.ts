/**
 * Start action — deploy the workspace's topology via `containerlab deploy`.
 *
 * Flow:
 *   1. Resolve workspace root (bail if none open).
 *   2. Discover *.clab.y{a,}ml files in the workspace (same globs M2
 *      uses for the Topologies section).
 *        0 topologies → info toast ("Add a *.clab.yml first").
 *        1 topology   → use it.
 *        2+           → showQuickPick with the topology paths.
 *   3. Run `sudo -n containerlab deploy -t <topology-path>`.
 *      The `-n` flag means non-interactive: sudo fails fast with a
 *      clear error if a password would be required. Prevents the
 *      process from hanging forever waiting on stdin we can't provide.
 *   4. Stream stdout/stderr to the output channel AND to the progress
 *      notification's message line (last non-empty line wins). Users
 *      see "Creating container clab-foo-bar" etc. as containerlab
 *      progresses. Not cancellable — killing a deploy mid-flight
 *      leaves partial state that requires `containerlab destroy` to
 *      clean up, which is beyond this action's scope.
 *   5. On success:
 *        - info toast "Lab deployed: <name>"
 *        - trigger immediate dashboard refresh via the
 *          sandboxDashboard.refresh command (picks up new lab
 *          within a second, rather than waiting up to 30s for the
 *          next containerlab poll tick).
 *   6. On failure: error toast with "View Log" → output.show().
 *      Special-case sudo-auth failure with a more pointed message.
 *
 * Non-goals for M3.4:
 *   - Destroy action (separate milestone / future feature).
 *   - Lab-is-already-deployed detection before firing deploy.
 *     containerlab handles this itself (returns a clear error on
 *     duplicate deploy); proactive detection would need us to hold
 *     StateRefresher's state, which we don't. The error toast
 *     surfaces the message faithfully.
 *   - Custom deploy flags (--reconfigure, --max-workers, etc.).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

const CLAB_GLOBS = ['**/*.clab.yml', '**/*.clab.yaml'];

/**
 * Session-scoped memory of the user's manually-picked topology file.
 *
 * This is a module-level variable, not VS Code state, deliberately:
 *   - It persists for the extension's lifetime, which matches the lab's
 *     lifetime (extension reactivates on lab restart → fresh variable).
 *   - It survives dashboard close+reopen within the same session, because
 *     the extension host keeps running.
 *   - It does NOT persist across lab restarts, matching the rest of the
 *     dashboard's "honest ephemerality" posture.
 *
 * The memory is cleared if the file stops existing on disk (detected at
 * Start time) — handles the case where the user deletes or renames their
 * topology file mid-session.
 *
 * Keyed by workspace root path so switching between workspaces in a
 * multi-root setup picks the right remembered file.
 */
const rememberedTopology = new Map<string, string>();

export async function runStart(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: start');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Start deploys the workspace\'s topology.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;
    const wsFolder = folders[0];

    // ── Resolve topology (three steps, short-circuit at the first match) ──
    //
    // Step 1: Session memory. If the user picked a non-standard topology
    //         earlier this session, use it — unless the file has since been
    //         deleted, in which case silently clear the memory and fall
    //         through to normal discovery.
    //
    // Step 2: Glob discovery. Look for *.clab.yml / *.clab.yaml files in the
    //         workspace. This is the "convention over configuration" path
    //         that covers 90%+ of real labs. Zero files → step 3. One file
    //         → use silently. Multiple → QuickPick.
    //
    // Step 3: Fallback file picker. No files match the convention — offer
    //         the user a dialog to pick any .yml/.yaml file as their
    //         topology. Remember the pick for subsequent Start clicks in
    //         this session.
    //
    // Once a topologyPath is resolved, rememberedTopology[workspaceRoot] is
    // updated so subsequent Start clicks reuse it without re-prompting.
    let topologyPath: string | undefined;

    // ── Step 1: check session memory ───────────────────────────────────────
    const remembered = rememberedTopology.get(workspaceRoot);
    if (remembered) {
        if (fs.existsSync(remembered)) {
            output.appendLine(`[sandboxDashboard] start: using remembered topology ${remembered}`);
            topologyPath = remembered;
        } else {
            output.appendLine(
                `[sandboxDashboard] remembered topology ${remembered} no longer exists; clearing`,
            );
            rememberedTopology.delete(workspaceRoot);
            // Fall through to discovery.
        }
    }

    // ── Step 2: glob discovery ─────────────────────────────────────────────
    if (!topologyPath) {
        const topologyUris: vscode.Uri[] = [];
        const seen = new Set<string>();
        for (const glob of CLAB_GLOBS) {
            const found = await vscode.workspace.findFiles(
                new vscode.RelativePattern(wsFolder, glob),
                null,
            );
            for (const uri of found) {
                if (!seen.has(uri.fsPath)) {
                    seen.add(uri.fsPath);
                    topologyUris.push(uri);
                }
            }
        }

        if (topologyUris.length === 1) {
            topologyPath = topologyUris[0].fsPath;
        } else if (topologyUris.length > 1) {
            const items = topologyUris.map((uri) => ({
                label: path.basename(uri.fsPath),
                description: path.relative(workspaceRoot, uri.fsPath),
                uri,
            }));
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Pick a topology to deploy',
                placeHolder: 'Which .clab.yml do you want to start?',
                matchOnDescription: true,
            });
            if (!picked) {
                output.appendLine('[sandboxDashboard] start cancelled by user (no topology picked)');
                return;
            }
            topologyPath = picked.uri.fsPath;
        }
        // topologyUris.length === 0 → fall through to step 3.
    }

    // ── Step 3: fallback file picker ───────────────────────────────────────
    //
    // No *.clab.yml / *.clab.yaml files matched. Offer the user a picker
    // for any .yml / .yaml file as an escape hatch. We don't try to
    // validate that the picked file is actually a containerlab topology
    // here — if it isn't, `containerlab deploy` will reject it with a
    // clear error message, which is already surfaced by runDeploy's
    // failure toast.
    if (!topologyPath) {
        output.appendLine(
            '[sandboxDashboard] no *.clab.yml found; prompting for manual file pick',
        );

        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(workspaceRoot),
            filters: { 'Topology file': ['yml', 'yaml'] },
            title: 'Pick a topology file to deploy',
            openLabel: 'Use as Topology',
        });

        if (!picked || picked.length === 0) {
            output.appendLine('[sandboxDashboard] start cancelled by user (no file picked)');
            return;
        }
        topologyPath = picked[0].fsPath;
    }

    // ── Remember for this session ──────────────────────────────────────────
    // Whether we arrived via glob discovery (standard or multi-file picker)
    // or the fallback dialog, record the pick so subsequent Start clicks
    // reuse it without re-asking. Cleared on next lab restart by module
    // re-init.
    rememberedTopology.set(workspaceRoot, topologyPath);
    output.appendLine(`[sandboxDashboard] start: using topology ${topologyPath}`);

    // ── Deploy with progress ───────────────────────────────────────────────
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Deploying ${path.basename(topologyPath)}…`,
                cancellable: false,
            },
            (progress) => runDeploy(topologyPath, output, progress),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] deploy failed: ${msg}`);

        // Helpful pointed message for the common sudo misconfig case.
        const isSudoAuth =
            /a password is required/i.test(msg) ||
            /sudo:.*required/i.test(msg) ||
            /no tty present/i.test(msg);
        const display = isSudoAuth
            ? 'Deploy failed: passwordless sudo is not configured for containerlab. ' +
              'Ask a lab admin to set up NOPASSWD sudo for the containerlab binary.'
            : `Deploy failed: ${msg}`;

        const action = await vscode.window.showErrorMessage(display, 'View Log');
        if (action === 'View Log') {
            output.show();
        }
        return;
    }

    // ── Success — trigger immediate dashboard refresh ──────────────────────
    // M2's 30s containerlab poll would eventually pick up the new lab, but
    // we can do better: a manual schedule call surfaces the change within a
    // second. The refresh command is registered in extension.ts and is a
    // no-op if the dashboard panel isn't open.
    output.appendLine('[sandboxDashboard] deploy succeeded; triggering refresh');
    await vscode.commands.executeCommand('sandboxDashboard.refresh');

    vscode.window.showInformationMessage(
        `Lab deployed: ${path.basename(topologyPath)}`,
    );
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Run `sudo -n containerlab deploy -t <topology>`.
 *
 * Streams stdout and stderr to the output channel line-by-line, and
 * surfaces the latest non-empty line as the withProgress notification's
 * message so the user can watch containerlab's own progress indicators.
 *
 * Resolves on exit code 0, rejects with a message derived from stderr
 * (or exit code) otherwise.
 */
function runDeploy(
    topologyPath: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = ['-n', 'containerlab', 'deploy', '-t', topologyPath];
        output.appendLine(`[sandboxDashboard] sudo ${args.join(' ')}`);

        const child = spawn('sudo', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderrBuf = '';
        // Both stdout and stderr feed the same line-accumulator — containerlab
        // writes its progress to stderr but operational results to stdout.
        // We want the user to see all of it in the log, with the most recent
        // useful line reflected in the progress toast.
        let lineBuffer = '';

        const onChunk = (chunk: Buffer, isStderr: boolean) => {
            const text = chunk.toString();
            if (isStderr) stderrBuf += text;

            lineBuffer += text;
            const lines = lineBuffer.split('\n');
            // Last element is partial (no trailing newline yet); keep it buffered.
            lineBuffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trimEnd();
                if (!line) continue;
                output.appendLine(`[clab] ${line}`);
                // Surface the last non-empty line as the progress message.
                // containerlab's own lines are concise ("Creating container
                // clab-foo-bar"), which reads well in the small toast.
                progress.report({ message: truncate(line, 80) });
            }
        };

        child.stdout.on('data', (c) => onChunk(c, false));
        child.stderr.on('data', (c) => onChunk(c, true));

        child.on('error', (err) => {
            reject(new Error(`could not spawn sudo: ${err.message}`));
        });

        child.on('close', (code) => {
            // Flush any trailing partial line.
            if (lineBuffer.trim()) {
                output.appendLine(`[clab] ${lineBuffer.trim()}`);
            }
            if (code === 0) {
                resolve();
            } else {
                // Extract the most informative stderr line for the error toast.
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
