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
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';

import { rememberedTopology, resolveTopology } from './_topology-resolver';

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

    // ── Resolve topology ───────────────────────────────────────────────────
    // Three-step resolution (session memory → glob discovery → fallback file
    // picker) lives in _topology-resolver.ts so Open Topology File can share
    // it. The resolver also handles all session-memory bookkeeping.
    let topologyPath = await resolveTopology(workspaceRoot, wsFolder, output, 'deploy');
    if (!topologyPath) {
        output.appendLine('[sandboxDashboard] start cancelled at topology resolution');
        return;
    }

    // ── Ecosystem-compatibility rename gate ────────────────────────────────
    //
    // srl-labs.vscode-containerlab's tree view discovers labs via files
    // matching *.clab.yml or *.clab.yaml. Labs deployed from non-conforming
    // filenames (lab.yml, topology.yaml, etc.) are invisible to that tree,
    // which means features like Topology View can't find the lab and bail
    // with confusing errors.
    //
    // Best fix is to rename BEFORE deploy: rename-after-deploy creates a
    // broken state because containerlab's metadata is stamped with the
    // original filename. So we offer the rename here, while the file is
    // just sitting on disk and renaming is cheap and reversible.
    //
    // Three outcomes:
    //   - 'Rename and Start' → fs.rename, update remembered topology, deploy
    //   - 'Start without Renaming' → deploy as-is; Topology View will be
    //                                 disabled for this lab in the dashboard
    //   - 'Cancel' / dismiss → don't deploy at all
    //
    // The convention check uses the same regex as containerlab.ts so
    // there's a single source of truth for "what counts as conforming."
    if (!/\.clab\.ya?ml$/i.test(topologyPath)) {
        const maybeRenamed = await offerEcosystemRename(topologyPath, output);
        if (maybeRenamed === undefined) {
            // User chose Cancel, or collision check failed unrecoverably.
            output.appendLine('[sandboxDashboard] start cancelled at rename gate');
            return;
        }
        if (maybeRenamed !== topologyPath) {
            // Rename succeeded — track the new path everywhere.
            topologyPath = maybeRenamed;
            rememberedTopology.set(workspaceRoot, topologyPath);
            output.appendLine(`[sandboxDashboard] start: renamed to ${topologyPath}`);
        }
        // Else: user chose 'Start without Renaming' — proceed with original path.
    }

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
/**
 * Three-button modal: offer to rename a non-conforming topology file
 * to *.clab.yml so srl-labs ecosystem features (Topology View, etc.)
 * work against it.
 *
 * Returns:
 *   - The new path (string ending in .clab.yml/.clab.yaml) if renamed
 *   - The original path unchanged if user picked 'Start without Renaming'
 *   - undefined if user cancelled OR if a collision was unrecoverable
 *
 * Collision handling: if the target name already exists, we offer a
 * follow-up "delete and rename / cancel" choice rather than silently
 * blowing away the existing file. fs.rename would unconditionally
 * overwrite on POSIX and that's not the user-expected default.
 *
 * Naming derivation: replace the existing extension with .clab.yml.
 * `lab.yml` → `lab.clab.yml`, `topology.yaml` → `topology.clab.yaml`.
 * Preserves yaml-vs-yml choice from the source (some users have strong
 * opinions about that). If the file has no extension at all (unusual),
 * we append .clab.yml.
 */
async function offerEcosystemRename(
    originalPath: string,
    output: vscode.OutputChannel,
): Promise<string | undefined> {
    const originalDir = path.dirname(originalPath);
    const originalBase = path.basename(originalPath);
    const originalExt = path.extname(originalBase); // includes the dot
    const stem = originalExt
        ? originalBase.slice(0, -originalExt.length)
        : originalBase;
    // Preserve .yaml-vs-.yml from source; default to .yml if neither.
    const targetExt = /\.yaml$/i.test(originalExt) ? '.clab.yaml' : '.clab.yml';
    const targetBase = stem + targetExt;
    const targetPath = path.join(originalDir, targetBase);

    output.appendLine(
        `[sandboxDashboard] rename gate: ${originalBase} → ${targetBase} candidate`,
    );

    const choice = await vscode.window.showWarningMessage(
        `Rename "${originalBase}" to "${targetBase}" before starting?`,
        {
            modal: true,
            detail:
                'Sandbox Dashboard can deploy any topology file, but features like ' +
                'Topology View (provided by the Containerlab extension) require the ' +
                '*.clab.yml naming convention. Renaming now enables full ecosystem ' +
                'compatibility.\n\n' +
                'This rename will modify your workspace. If the file is git-tracked, ' +
                "you'll see this as a deletion plus an addition until you commit.",
        },
        'Rename and Start',
        'Start without Renaming',
    );

    if (!choice) {
        // ESC / X / Cancel → abort the whole Start.
        return undefined;
    }

    if (choice === 'Start without Renaming') {
        output.appendLine('[sandboxDashboard] rename gate: user declined rename');
        return originalPath;
    }

    // 'Rename and Start' → check for collision before doing anything.
    if (fs.existsSync(targetPath)) {
        output.appendLine(
            `[sandboxDashboard] rename gate: collision — ${targetBase} already exists`,
        );
        const collisionChoice = await vscode.window.showWarningMessage(
            `"${targetBase}" already exists in this directory.`,
            {
                modal: true,
                detail:
                    `Renaming "${originalBase}" would overwrite "${targetBase}".\n\n` +
                    'Choose how to proceed:\n' +
                    `• Delete existing & rename: removes "${targetBase}", then renames "${originalBase}" → "${targetBase}".\n` +
                    '• Cancel: don\'t rename, return to the rename prompt (you can choose "Start without Renaming" there).',
            },
            'Delete existing & rename',
            'Cancel',
        );
        if (collisionChoice !== 'Delete existing & rename') {
            output.appendLine('[sandboxDashboard] rename gate: collision cancel');
            return undefined; // Abort whole Start; user can retry and pick a different option.
        }
        try {
            await fsp.unlink(targetPath);
            output.appendLine(`[sandboxDashboard] rename gate: removed existing ${targetBase}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`[sandboxDashboard] rename gate: unlink failed: ${msg}`);
            const action = await vscode.window.showErrorMessage(
                `Couldn't remove existing "${targetBase}": ${msg}`,
                'View Log',
            );
            if (action === 'View Log') output.show();
            return undefined;
        }
    }

    // Perform the rename.
    try {
        await fsp.rename(originalPath, targetPath);
        output.appendLine(
            `[sandboxDashboard] rename gate: ${originalBase} → ${targetBase} OK`,
        );
        return targetPath;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] rename gate: rename failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Couldn't rename "${originalBase}": ${msg}. Lab was NOT started.`,
            'View Log',
        );
        if (action === 'View Log') output.show();
        return undefined;
    }
}

/**
 * Run `sudo -n containerlab deploy -t <topology>`.
 *
 * Streams stdout/stderr line-by-line to the output channel, and surfaces
 * the most recent line as the progress notification's message. Resolves
 * on exit code 0; rejects with the most useful stderr line otherwise.
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
