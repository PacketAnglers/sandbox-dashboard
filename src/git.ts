/**
 * Git utility module.
 *
 * Thin wrapper around `git config --global` reads/writes plus a
 * "do we have a .git directory worth caring about?" detector.
 *
 * Why this exists at the module level rather than inline in
 * setup-git.ts: M4.2 only touches identity, but later milestones
 * may want to read other git state (default branch, current
 * remote, etc.) for dashboard display, and a centralized git
 * surface keeps that growth coherent.
 *
 * Why we shell out to `git` rather than parse ~/.gitconfig:
 *   - git's own config resolution handles include directives,
 *     case-insensitive section names, and multi-value entries
 *     correctly. Re-implementing that is a tar pit.
 *   - Sandbox containers always have git installed (it's used
 *     by Import/clone), so the binary is always available.
 *   - Same spawn+argv pattern we use everywhere else; consistent
 *     with the codebase's "shell out, no shell, no injection"
 *     posture.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface GitIdentity {
    name?: string;
    email?: string;
}

/**
 * Read git's global user.name and user.email.
 *
 * Returns whatever's actually set, with `undefined` for missing
 * fields (rather than empty string) so callers can use `?? 'fallback'`
 * cleanly. Both calls run in parallel — they don't depend on each
 * other and there's no reason to serialize them.
 */
export async function getGitIdentity(): Promise<GitIdentity> {
    const [name, email] = await Promise.all([
        readConfig('user.name'),
        readConfig('user.email'),
    ]);
    return { name, email };
}

/**
 * Write git's global user.name and user.email.
 *
 * Both writes are sequential — we want them to either both succeed
 * or fail clearly. Concurrent writes to ~/.gitconfig can race
 * (git uses file-level locking but parallel processes still
 * occasionally trip on it).
 *
 * Throws on any write failure with a message describing which
 * field failed. Caller is expected to surface this to the user.
 */
export async function setGitIdentity(name: string, email: string): Promise<void> {
    await writeConfig('user.name', name);
    await writeConfig('user.email', email);
}

/**
 * Detect whether the workspace contains a git repository worth
 * caring about — either at the workspace root itself or as an
 * immediate top-level subdirectory.
 *
 * Two-level check, not deep:
 *   - workspaceRoot/.git           → tarball-uploaded existing repo
 *   - workspaceRoot/<sub>/.git     → tarball with one repo nested
 *
 * Anything deeper (workspaceRoot/a/b/c/.git) is unusual enough that
 * we don't proactively prompt for it; the user can run the setup-git
 * command from the palette if they need to.
 *
 * Used by the activation-time prompt trigger: we only nag the user
 * about git identity if there's evidence git actually matters in
 * this workspace.
 */
export async function hasGitInWorkspace(workspaceRoot: string): Promise<boolean> {
    // Direct workspace root case.
    if (existsAndIsDir(path.join(workspaceRoot, '.git'))) {
        return true;
    }

    // One-level-deep case. Read top-level entries and check each.
    let entries: string[];
    try {
        entries = await fs.promises.readdir(workspaceRoot);
    } catch {
        return false;
    }

    for (const entry of entries) {
        // Skip dotfiles other than directories explicitly worth checking;
        // .vscode, .devcontainer etc. won't have .git inside them.
        if (entry.startsWith('.')) continue;
        const entryPath = path.join(workspaceRoot, entry);
        if (existsAndIsDir(path.join(entryPath, '.git'))) {
            return true;
        }
    }

    return false;
}

// ─── internals ──────────────────────────────────────────────────────────────

/**
 * Read a single git config key at the --global level.
 * Returns the value if set, or undefined if unset / empty / errored.
 */
function readConfig(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const child = spawn('git', ['config', '--global', '--get', key], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        child.stdout.on('data', (c) => { stdoutBuf += c.toString(); });

        child.on('error', () => resolve(undefined));
        child.on('close', (code) => {
            // git config returns exit 1 for "key not set" — that's not an
            // error from our perspective, just absence. Any non-zero is
            // treated as "we don't have a value to return".
            if (code !== 0) {
                resolve(undefined);
                return;
            }
            const value = stdoutBuf.trim();
            resolve(value.length > 0 ? value : undefined);
        });
    });
}

/**
 * Write a single git config key at the --global level.
 * Resolves on success, rejects with an Error on any failure.
 */
function writeConfig(key: string, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['config', '--global', key, value], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderrBuf = '';
        child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

        child.on('error', (err) => {
            reject(new Error(`git config write failed for ${key}: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                const headline = stderrBuf.trim() || `git config exited ${code}`;
                reject(new Error(`git config write failed for ${key}: ${headline}`));
            }
        });
    });
}

/** True iff path exists AND is a directory. Synchronous; cheap. */
function existsAndIsDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}
