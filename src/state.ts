/**
 * Workspace state computation.
 *
 * `computeWorkspaceState()` is the single entrypoint for "what's
 * currently true about the user's workspace?" — it discovers topology
 * files and probes containerlab, returns a complete `WorkspaceState`
 * snapshot ready to push to the webview.
 *
 * Design notes:
 *   - findFiles is VS Code's idiomatic glob API. It respects the
 *     user's files.exclude and files.watcherExclude settings, so if
 *     the user has excluded node_modules we don't waste time there.
 *   - Containerlab inspection runs concurrently with file discovery
 *     via Promise.all — typical cost is dominated by inspect anyway,
 *     so parallelizing gives us a small but free speedup.
 *   - A missing workspace folder is a legitimate state (new lab
 *     hasn't opened a folder yet), not an error. We return a
 *     well-formed "empty" state.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { inspectContainerlab } from './containerlab';
import { inFlightSnapshot } from './in-flight';
import type { TopologyFile, WorkspaceState } from './types';

/**
 * Globs for containerlab topology files. We run two findFiles calls
 * and merge rather than using brace alternation (`*.clab.{yml,yaml}`)
 * because minimatch brace-alternation support in VS Code's matcher
 * has been inconsistent across versions. Two explicit globs is
 * slightly less elegant but unambiguously correct.
 */
const TOPOLOGY_GLOBS = ['**/*.clab.yml', '**/*.clab.yaml'];

/**
 * Compute a full workspace-state snapshot.
 *
 * Safe to call repeatedly; each call is independent. Typical cost is
 * dominated by the containerlab inspect (≤5s with our timeout), with
 * file discovery in the low milliseconds unless the workspace is
 * unusually large.
 */
export async function computeWorkspaceState(): Promise<WorkspaceState> {
    const now = Date.now();

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        // No folder open — return a clean empty state. The webview will
        // render this as "open a folder to see your lab status."
        return {
            workspaceRoot: null,
            topologies: [],
            containerlab: {
                available: false,
                deployedLabs: [],
                lastCheckedAt: now,
            },
            inFlightActions: inFlightSnapshot(),
            computedAt: now,
        };
    }

    // Sandbox labs are single-root (one workspace folder per lab). Take
    // the first folder. If we ever support multi-root, this is the place
    // to extend — but for now, simpler is better.
    const root = folders[0].uri.fsPath;

    // Kick off topology discovery and containerlab inspection concurrently.
    // Both are I/O-bound and independent, so there's no reason to serialize.
    const [topologies, containerlab] = await Promise.all([
        discoverTopologies(folders[0]),
        inspectContainerlab(),
    ]);

    return {
        workspaceRoot: root,
        topologies,
        containerlab,
        inFlightActions: inFlightSnapshot(),
        computedAt: Date.now(),
    };
}

/**
 * Find all *.clab.{yml,yaml} files within a workspace folder.
 *
 * Uses vscode.workspace.findFiles so the user's files.exclude settings
 * are honored (e.g. node_modules, .git, build output). Sorted by
 * relative path for stable presentation — same file list order every
 * call, regardless of underlying filesystem enumeration order.
 */
async function discoverTopologies(folder: vscode.WorkspaceFolder): Promise<TopologyFile[]> {
    // Run both globs concurrently. Most workspaces have only .yml files
    // so one of these returns instantly with an empty array, but doing
    // both is cheap and catches users who prefer .yaml.
    const results = await Promise.all(
        TOPOLOGY_GLOBS.map((glob) =>
            vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, glob),
                // null exclude → honor user's files.exclude settings. Passing
                // any pattern here overrides those settings, which would be
                // surprising; null is "default VS Code behavior."
                null,
            ),
        ),
    );

    // Merge + dedupe by path. A file could theoretically match both globs
    // if we had a third extension variant; today this is just safety.
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const batch of results) {
        for (const uri of batch) {
            if (!seen.has(uri.fsPath)) {
                seen.add(uri.fsPath);
                uris.push(uri);
            }
        }
    }

    const rootPath = folder.uri.fsPath;
    const topologies: TopologyFile[] = uris.map((uri) => {
        const absolute = uri.fsPath;
        const relative = path.relative(rootPath, absolute);
        // depth 0 = root-level file. A file at `sub/topology.clab.yml` is
        // depth 1. Using path.sep-split to be cross-platform (though on
        // lab-base-sandbox it's always Linux, this costs us nothing).
        const depth = relative.split(path.sep).length - 1;
        return {
            path: absolute,
            relativePath: relative,
            name: path.basename(absolute),
            depth,
        };
    });

    // Stable ordering: alphabetical by relative path. Makes "the list
    // didn't change" visually obvious when nothing changed.
    topologies.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return topologies;
}
