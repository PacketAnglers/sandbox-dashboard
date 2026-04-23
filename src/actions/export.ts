/**
 * Export action — bundle the current workspace as a .tar.gz tarball.
 *
 * Flow:
 *   1. Resolve workspace root (bail with info message if none open).
 *   2. Show save dialog with a sensible default filename:
 *        <lab-folder>-YYYY-MM-DD-HHMM.tar.gz
 *   3. Spawn `tar -czf <target> --exclude ... -C <root> .`
 *        - Uses spawn + argv array (no shell), so paths with spaces or
 *          shell metachars in them are safe without quoting.
 *   4. On success: info toast with "Reveal in Finder/Files" follow-up.
 *   5. On failure: error toast with stderr excerpt + "View Log" button.
 *
 * Exclusions — what to leave OUT of the tarball:
 *   - .git (version history, not state)
 *   - node_modules (dep cache, not state)
 *   - clab-<labname> directories (containerlab runtime state — recreated
 *     on next deploy, and including them would leak node data that the
 *     user may want scrubbed before sharing)
 *
 * What's deliberately INCLUDED (even though tempting to exclude):
 *   - .vscode/  — sandbox labs ship tasks/launch configs here
 *   - .devcontainer/ — sandbox labs ship the lab infrastructure here
 *   - *.log files — troubleshooting artifacts often matter for sharing
 *
 * Users who want finer control can post-edit the tarball externally;
 * this action is intentionally opinionated and non-configurable for M3.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Default tar exclude patterns for Export. Patterns are tar's glob
 * syntax, not shell globs.
 *
 * Exported so Save (M3.5) can construct its own exclude list — Save
 * wants to include clab-* (that's where `containerlab save` writes
 * running configs), so it uses a shorter subset.
 */
export const DEFAULT_EXPORT_EXCLUDES = [
    './.git',
    './node_modules',
    './clab-*',
];

/**
 * Tar exclude patterns for Save. Same as Export but KEEPS clab-*
 * directories, since those hold the captured running configs that
 * are the whole point of Save.
 */
export const DEFAULT_SAVE_EXCLUDES = [
    './.git',
    './node_modules',
];

export async function runExport(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: export');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Export bundles the workspace, so there has to be one.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;
    const workspaceName = path.basename(workspaceRoot);

    // ── Build default filename ─────────────────────────────────────────────
    // <workspace-name>-YYYY-MM-DD-HHMM.tar.gz. Timestamp included so repeated
    // exports to the same directory don't clobber each other.
    const defaultName = `${workspaceName}-${timestamp()}.tar.gz`;

    // ── Save dialog ────────────────────────────────────────────────────────
    // defaultUri points at $HOME/<defaultName> on most platforms — a sensible
    // starting place the user can redirect from. We don't try to be clever
    // about /tmp vs /home; VS Code's dialog remembers the last location.
    const defaultUri = vscode.Uri.file(path.join(getDefaultDir(), defaultName));
    const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'Tarball': ['tar.gz', 'tgz'] },
        title: 'Export workspace as tarball',
        saveLabel: 'Export',
    });

    if (!targetUri) {
        // User cancelled. Quiet exit — no error, no toast.
        output.appendLine('[sandboxDashboard] export cancelled by user');
        return;
    }

    const targetPath = targetUri.fsPath;
    output.appendLine(
        `[sandboxDashboard] exporting ${workspaceRoot} → ${targetPath}`,
    );

    // ── Run tar ────────────────────────────────────────────────────────────
    // With withProgress so the user sees something happening. Export is
    // usually fast (seconds), but large topologies with many cEOS logs can
    // push into tens of seconds.
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Exporting workspace…',
                cancellable: false,
            },
            () => runTar(workspaceRoot, targetPath, DEFAULT_EXPORT_EXCLUDES, output),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] export failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Export failed: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') {
            output.show();
        }
        return;
    }

    // ── Success toast ──────────────────────────────────────────────────────
    output.appendLine(`[sandboxDashboard] export complete: ${targetPath}`);
    const action = await vscode.window.showInformationMessage(
        `Exported to ${path.basename(targetPath)}`,
        'Reveal in File Explorer',
    );
    if (action === 'Reveal in File Explorer') {
        // VS Code's built-in reveal command opens the containing folder and
        // selects the file. Works on Mac (Finder), Windows (Explorer), and
        // most Linux file managers via xdg-open.
        await vscode.commands.executeCommand('revealFileInOS', targetUri);
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Spawn `tar` to bundle a workspace into a gzipped tarball.
 *
 * Parameters:
 *   workspaceRoot — absolute path to the directory to bundle. tar `cd`s
 *                   into this with `-C`, so the tarball is rooted here.
 *   targetPath    — absolute path where the .tar.gz should be written.
 *   excludes      — tar glob patterns (not shell globs). See the
 *                   DEFAULT_EXPORT_EXCLUDES / DEFAULT_SAVE_EXCLUDES
 *                   constants for the two in-tree call sites.
 *   output        — channel for the command echo and stderr dump.
 *
 * Resolves on exit code 0, rejects with a stderr-derived message
 * otherwise. Uses argv (not shell) so paths with metachars are safe
 * without quoting.
 *
 * Exported so Save (M3.5) can reuse it with a shorter exclude list —
 * Save needs clab-* directories included because that's where
 * `containerlab save` writes running configs.
 */
export function runTar(
    workspaceRoot: string,
    targetPath: string,
    excludes: readonly string[],
    output: vscode.OutputChannel,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args: string[] = ['-czf', targetPath];
        for (const ex of excludes) {
            args.push(`--exclude=${ex}`);
        }
        // -C <root> tells tar to cd into the workspace first, then '.' means
        // "everything in there". This keeps the tarball rooted at the
        // workspace instead of including the absolute path prefix.
        args.push('-C', workspaceRoot, '.');

        output.appendLine(`[sandboxDashboard] tar ${args.join(' ')}`);

        const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        // Collect stderr for error messages; tar writes warnings here too
        // (e.g., "file changed as we read it"), which we log but don't treat
        // as fatal — tar's exit code is the truth.
        let stderrBuf = '';
        child.stderr.on('data', (chunk) => {
            stderrBuf += chunk.toString();
        });

        child.on('error', (err) => {
            // This fires when the binary can't be spawned (e.g., 'tar' not
            // on PATH). Distinct from non-zero exit — resolves never fire.
            reject(new Error(`could not spawn tar: ${err.message}`));
        });

        child.on('close', (code) => {
            if (stderrBuf.trim()) {
                // Log stderr regardless of exit code — tar can emit warnings
                // on a successful run ("file changed as we read it") that
                // are worth having in the log but not worth failing on.
                output.appendLine(`[sandboxDashboard] tar stderr:\n${stderrBuf.trim()}`);
            }
            if (code === 0) {
                resolve();
            } else {
                // Take the last non-empty line of stderr as the headline
                // — usually tar's one-line error message.
                const headline = stderrBuf.trim().split('\n').pop() || `exit ${code}`;
                reject(new Error(headline));
            }
        });
    });
}

/** ISO-ish timestamp suitable for filenames: YYYY-MM-DD-HHMM. Exported for Save. */
export function timestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Best-effort default directory for the save dialog's initial location.
 * On Linux (including our sandbox container), $HOME is universally
 * available. Falls back to workspace root if something's weird.
 *
 * Exported for Save.
 */
export function getDefaultDir(): string {
    return process.env.HOME || process.env.USERPROFILE || process.cwd();
}
