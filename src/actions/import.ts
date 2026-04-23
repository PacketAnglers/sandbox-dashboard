/**
 * Import action — extract a previously-exported .tar.gz tarball into
 * the current workspace.
 *
 * Flow:
 *   1. Resolve workspace root (bail if none open).
 *   2. Show open dialog filtered to .tar.gz / .tgz.
 *   3. List the tarball's top-level entries via `tar -tzf` (read-only,
 *      no extraction). Compare against what's already in the workspace
 *      to surface collisions.
 *   4. If any collisions: modal warning listing them, with
 *      Overwrite / Cancel. Overwrite proceeds; Cancel exits quietly.
 *      If no collisions: extract without confirmation.
 *   5. Spawn `tar -xzf <tarball> -C <workspaceRoot>`.
 *       - spawn + argv (no shell), same safety as Export.
 *       - tar's default behaviour merges: existing files get overwritten,
 *         extra files already in the workspace are left alone. We
 *         surface this in the collision modal so the user isn't
 *         surprised.
 *   6. Success toast; file watchers pick up new topologies automatically
 *      and the dashboard refreshes without any explicit signal from us.
 *   7. Failure toast with View Log follow-up.
 *
 * Not in scope for M3.3:
 *   - Renaming-on-collision ("put it in ./imported-<timestamp>/").
 *     Users who want that can extract to a subfolder manually.
 *   - Dry-run preview mode. Collision list is the preview.
 *   - Verifying tarball provenance / integrity. Out of scope for a
 *     user-driven import action.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export async function runImport(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: import');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Import extracts into the workspace, so there has to be one.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // ── Pick tarball ───────────────────────────────────────────────────────
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Tarball': ['tar.gz', 'tgz'] },
        title: 'Import lab from tarball',
        openLabel: 'Import',
    });

    if (!picked || picked.length === 0) {
        output.appendLine('[sandboxDashboard] import cancelled by user (no file picked)');
        return;
    }
    const tarPath = picked[0].fsPath;
    output.appendLine(`[sandboxDashboard] import source: ${tarPath}`);

    // ── Inspect tarball contents for collision detection ───────────────────
    let tarEntries: string[];
    try {
        tarEntries = await listTarContents(tarPath, output);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] tar listing failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Couldn't read tarball contents: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') {
            output.show();
        }
        return;
    }

    // Derive top-level entries (first path segment after any leading './').
    const topLevelInTar = collectTopLevel(tarEntries);
    output.appendLine(
        `[sandboxDashboard] tarball top-level entries (${topLevelInTar.size}): ${Array.from(topLevelInTar).join(', ')}`,
    );

    // Check which top-level entries collide with what's already in the workspace.
    const collisions: string[] = [];
    for (const name of topLevelInTar) {
        const targetPath = path.join(workspaceRoot, name);
        if (fs.existsSync(targetPath)) {
            collisions.push(name);
        }
    }

    if (collisions.length > 0) {
        const listed = collisions.slice(0, 5).join(', ') +
            (collisions.length > 5 ? `, … (+${collisions.length - 5} more)` : '');
        const proceed = await vscode.window.showWarningMessage(
            `This tarball will overwrite existing workspace entries: ${listed}. ` +
                'Files already in the workspace but not in the tarball will be preserved. Continue?',
            { modal: true },
            'Overwrite',
        );
        if (proceed !== 'Overwrite') {
            output.appendLine('[sandboxDashboard] import cancelled by user (collision)');
            return;
        }
    }

    // ── Extract ────────────────────────────────────────────────────────────
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Importing tarball…',
                cancellable: false,
            },
            () => extractTar(tarPath, workspaceRoot, output),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] import failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Import failed: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') {
            output.show();
        }
        return;
    }

    // ── Success ────────────────────────────────────────────────────────────
    // The file watchers in M2's StateRefresher will pick up any new
    // *.clab.yml within ~300ms of extraction completing, so the dashboard
    // updates itself without an explicit refresh call here.
    output.appendLine(
        `[sandboxDashboard] import complete: ${topLevelInTar.size} top-level entries`,
    );
    vscode.window.showInformationMessage(
        `Imported ${topLevelInTar.size} ${topLevelInTar.size === 1 ? 'entry' : 'entries'} from ${path.basename(tarPath)}.`,
    );
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * List a tarball's contents (paths only) without extracting.
 * Uses `tar -tzf <path>`.
 */
function listTarContents(
    tarPath: string,
    output: vscode.OutputChannel,
): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = spawn('tar', ['-tzf', tarPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        child.on('error', (err) => {
            reject(new Error(`could not spawn tar: ${err.message}`));
        });

        child.on('close', (code) => {
            if (stderrBuf.trim()) {
                output.appendLine(`[sandboxDashboard] tar -tzf stderr:\n${stderrBuf.trim()}`);
            }
            if (code !== 0) {
                const headline = stderrBuf.trim().split('\n').pop() || `exit ${code}`;
                reject(new Error(headline));
                return;
            }
            const lines = stdoutBuf
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            resolve(lines);
        });
    });
}

/**
 * Collect the distinct top-level names from a list of tarball entries.
 *
 * Tarballs built by our Export action look like:
 *   ./sandbox-template/topology.clab.yml
 *   ./sandbox-template/configs/...
 *   ./README.md
 *
 * The "top-level" names are `sandbox-template` and `README.md` — the
 * first path segment after any leading `./`. We drop the bare `.` /
 * `./` self-references tar includes.
 */
function collectTopLevel(entries: string[]): Set<string> {
    const out = new Set<string>();
    for (const entry of entries) {
        let e = entry;
        if (e.startsWith('./')) e = e.slice(2);
        if (e === '' || e === '.') continue;
        // First segment, stripped of trailing slash (directories).
        const slashIdx = e.indexOf('/');
        const first = slashIdx === -1 ? e : e.slice(0, slashIdx);
        if (first.length > 0) out.add(first);
    }
    return out;
}

/**
 * Extract a tarball into the target directory.
 * Uses `tar -xzf <tar> -C <target>`.
 */
function extractTar(
    tarPath: string,
    targetRoot: string,
    output: vscode.OutputChannel,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = ['-xzf', tarPath, '-C', targetRoot];
        output.appendLine(`[sandboxDashboard] tar ${args.join(' ')}`);

        const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderrBuf = '';
        child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        child.on('error', (err) => {
            reject(new Error(`could not spawn tar: ${err.message}`));
        });

        child.on('close', (code) => {
            if (stderrBuf.trim()) {
                output.appendLine(`[sandboxDashboard] tar -xzf stderr:\n${stderrBuf.trim()}`);
            }
            if (code === 0) {
                resolve();
            } else {
                const headline = stderrBuf.trim().split('\n').pop() || `exit ${code}`;
                reject(new Error(headline));
            }
        });
    });
}
