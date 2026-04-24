/**
 * Stop action — tear down a deployed lab.
 *
 * "Stop" is the user-facing name; under the hood we run
 * `containerlab destroy --cleanup -t <topology>` because that's
 * what the CLI calls it. We deliberately don't expose "destroy"
 * vocabulary to the user — it implies permanence that doesn't
 * match the actual semantics:
 *
 *   - Topology file: untouched (still in workspace)
 *   - clab-* directories: untouched (any captured configs preserved)
 *   - git-tracked content: untouched
 *   - Container instances: gone
 *   - Network namespaces / bridges: cleaned up by --cleanup
 *
 * A subsequent Start will redeploy from the same topology, and if
 * Save was run first (or "Save and Stop" was chosen), the captured
 * configs in the clab- directories will be picked up automatically
 * by containerlab. So functionally: "Stop with saved configs" is
 * fully resumable.
 *
 * Flow:
 *   1. Resolve workspace root (bail if none open).
 *   2. inspectDeployedLabs() — fresh read, not cached state. Mutating
 *      actions need ground truth: "operate on exactly the right live
 *      lab" matters most here.
 *      Zero deployed → toast "No labs running" (UI button disable
 *      handles this case in practice).
 *      One deployed  → use it silently.
 *      2+ deployed   → showQuickPick.
 *   3. Modal with three options:
 *        - Cancel (default-ish — ESC, X, etc. all map here)
 *        - Save and Stop  → runContainerlabSaveBeforeStop, then destroy
 *        - Stop without Saving → straight to destroy
 *   4. If "Save and Stop": runContainerlabSaveBeforeStop blocks until
 *      configs are captured. If save fails, surface the error and
 *      DO NOT proceed to destroy — the user wanted their configs.
 *      If save succeeds but destroy then fails, surface the partial:
 *      "Saved configs to <path>, but stop failed: <err>. Lab is
 *      still running."
 *   5. Spawn `sudo -n containerlab destroy --cleanup -t <topology>`
 *      with line-streamed progress (same pattern as Start/Save).
 *   6. On success: trigger sandboxDashboard.refresh for fast UI
 *      update (lab disappears from dashboard within ~1s instead of
 *      waiting up to 30s for the next poll), info toast.
 *
 * Why --cleanup is the default (not optional):
 *   Without --cleanup, destroyed labs leave behind network bridges
 *   and namespaces that accumulate over a session and eventually
 *   cause resource exhaustion. The "clean teardown" semantics map
 *   to what users expect from "Stop" — a fresh slate to deploy
 *   into next time.
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';

import { inspectDeployedLabs, RunningLab } from './_helpers';

export async function runStop(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: stop');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Stop operates on labs in the current workspace.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // ── Identify the lab to stop ───────────────────────────────────────────
    const deployed = await inspectDeployedLabs(output);
    if (deployed.length === 0) {
        vscode.window.showInformationMessage(
            'No lab is currently deployed. Nothing to stop.',
        );
        return;
    }

    let lab: RunningLab;
    if (deployed.length === 1) {
        lab = deployed[0];
    } else {
        const items = deployed.map((d) => ({
            label: d.name,
            description: `${d.nodeCount} node${d.nodeCount === 1 ? '' : 's'} · ${d.topologyPath}`,
            lab: d,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: 'Pick a lab to stop',
            placeHolder: 'Which deployed lab do you want to stop?',
            matchOnDescription: true,
        });
        if (!picked) {
            output.appendLine('[sandboxDashboard] stop cancelled by user (no lab picked)');
            return;
        }
        lab = picked.lab;
    }
    output.appendLine(`[sandboxDashboard] stop: lab "${lab.name}" (topology ${lab.topologyPath})`);

    // ── Confirmation modal ─────────────────────────────────────────────────
    // Three options. Modal so the user MUST make a choice; can't be
    // dismissed accidentally by clicking outside.
    //
    // Order of buttons in showWarningMessage: VS Code shows them right-to-
    // left in macOS-native style on Mac, left-to-right on Windows/Linux.
    // Putting "Save and Stop" first means it's the highlighted/default
    // option in most layouts — the safer choice gets the easier path.
    const choice = await vscode.window.showWarningMessage(
        `Stop lab "${lab.name}"?`,
        {
            modal: true,
            detail:
                'Containers will be torn down and network state cleaned up. ' +
                'The topology file and any saved configs in clab-* directories will remain in your workspace, ' +
                'so you can Start again later.\n\n' +
                'If you want to capture the running configs before stopping, choose "Save and Stop".',
        },
        'Save and Stop',
        'Stop without Saving',
    );

    if (!choice) {
        output.appendLine('[sandboxDashboard] stop cancelled by user (modal dismissed)');
        return;
    }

    // ── Save-before-stop branch ────────────────────────────────────────────
    if (choice === 'Save and Stop') {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Capturing configs from ${lab.name}…`,
                    cancellable: false,
                },
                (progress) => runContainerlabSave(lab.topologyPath, workspaceRoot, output, progress),
            );
        } catch (err) {
            // Save failed → DO NOT proceed to destroy. The user wanted
            // their configs preserved; if we can't preserve them, they
            // need to know before anything else happens.
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`[sandboxDashboard] save-before-stop failed: ${msg}`);

            const isSudoAuth =
                /a password is required/i.test(msg) ||
                /sudo:.*required/i.test(msg) ||
                /no tty present/i.test(msg);
            const display = isSudoAuth
                ? 'Save-before-stop failed: passwordless sudo is not configured for containerlab. ' +
                  'Lab was NOT stopped. Ask a lab admin to set up NOPASSWD sudo, or use "Stop without Saving" instead.'
                : `Save-before-stop failed: ${msg}. Lab was NOT stopped.`;

            const action = await vscode.window.showErrorMessage(display, 'View Log');
            if (action === 'View Log') output.show();
            return;
        }
        output.appendLine('[sandboxDashboard] save-before-stop succeeded; proceeding to destroy');
    }

    // ── Destroy ────────────────────────────────────────────────────────────
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Stopping ${lab.name}…`,
                cancellable: false,
            },
            (progress) => runContainerlabDestroy(lab.topologyPath, workspaceRoot, output, progress),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] destroy failed: ${msg}`);

        const isSudoAuth =
            /a password is required/i.test(msg) ||
            /sudo:.*required/i.test(msg) ||
            /no tty present/i.test(msg);

        let display: string;
        if (isSudoAuth) {
            display = 'Stop failed: passwordless sudo is not configured for containerlab. ' +
                     'Ask a lab admin to set up NOPASSWD sudo for the containerlab binary.';
        } else if (choice === 'Save and Stop') {
            // Save succeeded but destroy didn't — partial-success path.
            display = `Configs were saved successfully, but stop failed: ${msg}. The lab is still running.`;
        } else {
            display = `Stop failed: ${msg}`;
        }

        const action = await vscode.window.showErrorMessage(display, 'View Log');
        if (action === 'View Log') output.show();
        return;
    }

    // ── Success ────────────────────────────────────────────────────────────
    output.appendLine(`[sandboxDashboard] stop complete: ${lab.name}`);
    await vscode.commands.executeCommand('sandboxDashboard.refresh');

    const successMsg = choice === 'Save and Stop'
        ? `Stopped ${lab.name} (configs saved to clab-${lab.name}/).`
        : `Stopped ${lab.name}.`;
    vscode.window.showInformationMessage(successMsg);
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn `sudo -n containerlab save -t <topology>` and stream its
 * output. Same pattern as the Save action's identically-named helper
 * (kept local rather than shared because the duplication is
 * ~20 lines and lifting them out would create a "spawn helpers"
 * file with one caller besides this).
 */
function runContainerlabSave(
    topologyPath: string,
    workspaceRoot: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
    return spawnAndStream(
        ['sudo', ['-n', 'containerlab', 'save', '-t', topologyPath]],
        { cwd: workspaceRoot, output, progress },
    );
}

/**
 * Spawn `sudo -n containerlab destroy --cleanup -t <topology>` and
 * stream its output.
 *
 * --cleanup ensures bridges and namespaces are torn down too, not
 * just the containers. Without it, a session of repeated Start/Stop
 * cycles accumulates dead network state until something fails.
 */
function runContainerlabDestroy(
    topologyPath: string,
    workspaceRoot: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
    return spawnAndStream(
        ['sudo', ['-n', 'containerlab', 'destroy', '--cleanup', '-t', topologyPath]],
        { cwd: workspaceRoot, output, progress },
    );
}

/**
 * Generic spawn-with-line-streaming. Same pattern Start.runDeploy and
 * Save.runContainerlabSave use, lifted into a helper because we now
 * have three call sites.
 *
 * Resolves on exit code 0; rejects with a stderr-derived message
 * (or "exit N") otherwise. Streams stdout AND stderr line-by-line
 * to the output channel and progress notification.
 */
function spawnAndStream(
    cmd: [string, string[]],
    opts: {
        cwd: string;
        output: vscode.OutputChannel;
        progress: vscode.Progress<{ message?: string; increment?: number }>;
    },
): Promise<void> {
    const [bin, args] = cmd;
    const { cwd, output, progress } = opts;

    return new Promise((resolve, reject) => {
        output.appendLine(`[sandboxDashboard] ${bin} ${args.join(' ')}`);

        const child = spawn(bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd,
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
            reject(new Error(`could not spawn ${bin}: ${err.message}`));
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
