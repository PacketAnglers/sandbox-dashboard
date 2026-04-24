/**
 * Import action — bring lab content into the current workspace.
 *
 * As of M4.1, Import is a router: it opens with a QuickPick asking
 * the user HOW they want to import, then dispatches to one of two
 * sub-flows.
 *
 *   📁 Upload File (.tar.gz)  → runImportFromTarball
 *      The original M3.3 flow: open dialog, collision check via
 *      `tar -tzf`, modal warning if any, extract via `tar -xzf`.
 *      Behavior unchanged from M3.3 — just relocated.
 *
 *   🐙 Clone from GitHub      → runImportFromGitHub
 *      New in M4.1. User-validated request from the v0.3.0 smoke
 *      test: many folks keep their lab content in a repo and
 *      "drop my repo here" is a far more natural workflow than
 *      "find my tarball, upload it, etc."
 *
 * The router pattern keeps the public-facing runImport signature
 * unchanged, so extension.ts and the webview message dispatch see
 * exactly the same surface they did before.
 *
 * GitHub clone behavior decisions
 * ────────────────────────────────
 * - Clones into the workspace root (`git clone <url> .`), NOT into
 *   a subdirectory. This matches user expectation: "my repo IS the
 *   lab", not "my repo is a thing inside the lab".
 *
 * - Therefore, a non-empty workspace must be wiped first. We do NOT
 *   wipe silently. Users get a destructive-confirmation modal listing
 *   what's about to be deleted, with a clearly-distinct primary
 *   button "Delete and Clone".
 *
 * - Empty workspaces fast-path: skip the modal and clone directly.
 *   "Empty" here means no top-level entries (dotfiles included).
 *
 * - Wipe via fs.readdir + fs.rm({recursive, force}) per entry.
 *   Safer than shelling out to `rm -rf *` (no shell glob to
 *   misbehave, no quoting hazards, no zsh-vs-bash dotfile
 *   gotchas). The .git directory the new clone will create is
 *   the user's, not ours, so we don't have to preserve anything.
 *
 * - Authentication: trust code-server. code-server intercepts git's
 *   credential prompts and surfaces them through the browser's auth
 *   flow. We don't set GIT_TERMINAL_PROMPT=0; we let git try and
 *   trust that the integration handles it.
 *
 * - Timeouts:
 *     30s "still working" — surface a status update suggesting the
 *                           user check for a stuck auth flow if
 *                           they haven't seen one open
 *     5min hard timeout   — kill the git process and surface a
 *                           failure toast. Pathological case; in
 *                           practice clones either complete fast
 *                           or die fast.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';

const STILL_WORKING_MS = 30_000;     // 30s: surface "still working" hint
const CLONE_HARD_TIMEOUT_MS = 300_000; // 5min: kill the process

// ─── Public entry point — the router ────────────────────────────────────────

export async function runImport(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: import');

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Import extracts content into the workspace, so there has to be one.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // ── Step 1: pick the import method ─────────────────────────────────────
    type Method = 'tarball' | 'github';
    interface MethodItem extends vscode.QuickPickItem {
        method: Method;
    }
    const items: MethodItem[] = [
        {
            label: '$(file-zip) Upload File (.tar.gz)',
            description: 'Pick a tarball from the container filesystem and extract it',
            method: 'tarball',
        },
        {
            label: '$(github) Clone from GitHub',
            description: 'Wipe the workspace and clone a Git repository into it',
            method: 'github',
        },
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Import lab content',
        placeHolder: 'How do you want to import?',
    });
    if (!picked) {
        output.appendLine('[sandboxDashboard] import cancelled by user (no method picked)');
        return;
    }

    if (picked.method === 'tarball') {
        await runImportFromTarball(workspaceRoot, output);
    } else {
        await runImportFromGitHub(workspaceRoot, output);
    }
}

// ─── Tarball path (M3.3 logic, refactored) ──────────────────────────────────

async function runImportFromTarball(
    workspaceRoot: string,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] import: tarball method');

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

    // List tarball contents for collision detection
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
        if (action === 'View Log') output.show();
        return;
    }

    const topLevelInTar = collectTopLevel(tarEntries);
    output.appendLine(
        `[sandboxDashboard] tarball top-level entries (${topLevelInTar.size}): ${Array.from(topLevelInTar).join(', ')}`,
    );

    const collisions: string[] = [];
    for (const name of topLevelInTar) {
        if (fs.existsSync(path.join(workspaceRoot, name))) {
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
        if (action === 'View Log') output.show();
        return;
    }

    output.appendLine(
        `[sandboxDashboard] import complete: ${topLevelInTar.size} top-level entries`,
    );
    vscode.window.showInformationMessage(
        `Imported ${topLevelInTar.size} ${topLevelInTar.size === 1 ? 'entry' : 'entries'} from ${path.basename(tarPath)}.`,
    );
}

// ─── GitHub clone path (NEW in M4.1) ────────────────────────────────────────

async function runImportFromGitHub(
    workspaceRoot: string,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] import: github method');

    // ── Step 1: get the URL ────────────────────────────────────────────────
    const url = await vscode.window.showInputBox({
        title: 'Clone from GitHub',
        prompt: 'Repository URL (https or ssh)',
        placeHolder: 'https://github.com/your-org/your-lab-repo.git',
        ignoreFocusOut: true,
        validateInput: (value) => {
            const v = value.trim();
            if (!v) return 'Repository URL is required';
            // Loose check — accept anything that *looks* git-clonable.
            // We don't try to be smarter than git itself; if the URL
            // is malformed, git will say so clearly.
            if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(v)) {
                return 'URL should start with https://, http://, git@, ssh://, or git://';
            }
            return null;
        },
    });

    if (!url) {
        output.appendLine('[sandboxDashboard] import cancelled by user (no URL)');
        return;
    }
    const trimmedUrl = url.trim();
    output.appendLine(`[sandboxDashboard] github clone source: ${trimmedUrl}`);

    // ── Step 2: check workspace contents ───────────────────────────────────
    const entries = await fsp.readdir(workspaceRoot);
    const isEmpty = entries.length === 0;

    if (!isEmpty) {
        // Destructive-confirmation modal. Show what's about to be wiped
        // — first 8 entries verbatim, the rest summarized.
        const listed = entries.slice(0, 8).join(', ') +
            (entries.length > 8 ? `, … (+${entries.length - 8} more)` : '');
        const proceed = await vscode.window.showWarningMessage(
            `This will DELETE everything in your workspace before cloning.`,
            {
                modal: true,
                detail:
                    `Contents to be removed: ${listed}\n\n` +
                    'If you have uncommitted work in this workspace, cancel and back it up first. ' +
                    'This cannot be undone.',
            },
            'Delete and Clone',
        );

        if (proceed !== 'Delete and Clone') {
            output.appendLine('[sandboxDashboard] github clone cancelled by user (destructive confirm declined)');
            return;
        }

        // ── Wipe ───────────────────────────────────────────────────────────
        output.appendLine(`[sandboxDashboard] wiping ${entries.length} workspace entries before clone`);
        try {
            for (const entry of entries) {
                const fullPath = path.join(workspaceRoot, entry);
                await fsp.rm(fullPath, { recursive: true, force: true });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`[sandboxDashboard] wipe failed: ${msg}`);
            const action = await vscode.window.showErrorMessage(
                `Couldn't clear workspace: ${msg}. Clone aborted.`,
                'View Log',
            );
            if (action === 'View Log') output.show();
            return;
        }
        output.appendLine('[sandboxDashboard] workspace wipe complete');
    } else {
        output.appendLine('[sandboxDashboard] workspace empty — fast-path, no confirmation needed');
    }

    // ── Step 3: clone with progress + timeouts ─────────────────────────────
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Cloning ${shortRepoName(trimmedUrl)}…`,
                cancellable: false,
            },
            (progress) => runGitClone(trimmedUrl, workspaceRoot, output, progress),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] git clone failed: ${msg}`);

        // Workspace is now empty (we wiped it) and the clone failed.
        // The user has lost their previous content (with their consent).
        // Make sure the toast acknowledges the state honestly.
        const display = isEmpty
            ? `Clone failed: ${msg}`
            : `Clone failed: ${msg}. The workspace was already cleared, so you'll need to import again or restore from backup.`;
        const action = await vscode.window.showErrorMessage(display, 'View Log');
        if (action === 'View Log') output.show();
        return;
    }

    // ── Step 4: success ────────────────────────────────────────────────────
    output.appendLine('[sandboxDashboard] github clone complete');
    await vscode.commands.executeCommand('sandboxDashboard.refresh');
    vscode.window.showInformationMessage(
        `Cloned ${shortRepoName(trimmedUrl)} into workspace.`,
    );
}

// ─── tarball helpers (unchanged from M3.3) ──────────────────────────────────

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

function collectTopLevel(entries: string[]): Set<string> {
    const out = new Set<string>();
    for (const entry of entries) {
        let e = entry;
        if (e.startsWith('./')) e = e.slice(2);
        if (e === '' || e === '.') continue;
        const slashIdx = e.indexOf('/');
        const first = slashIdx === -1 ? e : e.slice(0, slashIdx);
        if (first.length > 0) out.add(first);
    }
    return out;
}

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

// ─── git clone helper (NEW) ─────────────────────────────────────────────────

/**
 * Spawn `git clone <url> .` from the workspace root with progress
 * streaming AND two layered timeouts:
 *
 *   - At STILL_WORKING_MS (30s), surface a "still working" hint
 *     in the progress toast. Most clones finish in under 10s; if
 *     we're past 30s, the most likely cause is a stuck auth flow.
 *
 *   - At CLONE_HARD_TIMEOUT_MS (5min), SIGKILL the git process and
 *     reject. Pathological cases (network hung, auth flow never
 *     completed). Without this we'd hang the user's progress
 *     notification indefinitely.
 *
 * `git clone` writes its progress lines to stderr (yes, really —
 * stderr is git's interactive surface, not its error channel),
 * so we read both streams the same way.
 */
function runGitClone(
    url: string,
    workspaceRoot: string,
    output: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
    return new Promise((resolve, reject) => {
        // --progress forces git to emit progress lines even when not
        // attached to a TTY (which we aren't, going through spawn).
        const args = ['clone', '--progress', url, '.'];
        output.appendLine(`[sandboxDashboard] git ${args.join(' ')}`);

        const child = spawn('git', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: workspaceRoot,
        });

        let stderrBuf = '';
        let lineBuffer = '';
        let stillWorkingTimer: NodeJS.Timeout | undefined;
        let hardTimeoutTimer: NodeJS.Timeout | undefined;
        let killedByTimeout = false;

        const cleanup = () => {
            if (stillWorkingTimer) clearTimeout(stillWorkingTimer);
            if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
        };

        // Progress streaming. git uses CR (\r) for in-line progress
        // updates ("Receiving objects: 23% (115/498)"), not \n. Split
        // on either so each progress tick gets surfaced.
        const onChunk = (chunk: Buffer, isStderr: boolean) => {
            const text = chunk.toString();
            if (isStderr) stderrBuf += text;

            lineBuffer += text;
            // Replace CR with LF first, then split on LF.
            const normalized = lineBuffer.replace(/\r/g, '\n');
            const lines = normalized.split('\n');
            lineBuffer = lines.pop() ?? '';
            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                output.appendLine(`[git] ${line}`);
                progress.report({ message: truncate(line, 80) });
            }
        };

        child.stdout.on('data', (c) => onChunk(c, false));
        child.stderr.on('data', (c) => onChunk(c, true));

        // 30s "still working" hint. Replaces the progress message with
        // a more informative one if git's own progress hasn't
        // overwritten it shortly after.
        stillWorkingTimer = setTimeout(() => {
            output.appendLine('[sandboxDashboard] clone still in progress at 30s');
            progress.report({
                message: 'Still cloning… if a GitHub auth tab opened, complete it. Otherwise this may be a slow network.',
            });
        }, STILL_WORKING_MS);

        // 5min hard timeout. SIGTERM first, then SIGKILL after a grace.
        hardTimeoutTimer = setTimeout(() => {
            output.appendLine('[sandboxDashboard] clone exceeded 5min hard timeout — killing');
            killedByTimeout = true;
            child.kill('SIGTERM');
            // If it doesn't exit on SIGTERM in 3s, force-kill.
            setTimeout(() => {
                if (!child.killed) child.kill('SIGKILL');
            }, 3000);
        }, CLONE_HARD_TIMEOUT_MS);

        child.on('error', (err) => {
            cleanup();
            reject(new Error(`could not spawn git: ${err.message}`));
        });

        child.on('close', (code) => {
            cleanup();
            if (lineBuffer.trim()) {
                output.appendLine(`[git] ${lineBuffer.trim()}`);
            }
            if (killedByTimeout) {
                reject(new Error(
                    'clone exceeded 5-minute timeout. If a GitHub auth tab opened, you may need to complete it before retrying.',
                ));
                return;
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

/**
 * Extract a short, human-readable repo identifier from a URL for
 * use in toast titles. "https://github.com/foo/bar.git" → "foo/bar".
 * Falls back to the URL itself if we can't parse a sensible name.
 */
function shortRepoName(url: string): string {
    // Strip trailing .git
    const noGit = url.replace(/\.git$/, '');
    // Try to grab the last two path segments
    const m = noGit.match(/[/:]([^/:]+)\/([^/]+)$/);
    if (m) return `${m[1]}/${m[2]}`;
    return url;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
