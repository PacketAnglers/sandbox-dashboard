/**
 * Shared topology resolver.
 *
 * "Which topology file does the user want to interact with?" — a question
 * that comes up in two places now (Start and Open Topology File), and
 * likely more later (any future feature that operates on "the user's
 * intended topology" needs the same answer).
 *
 * THE THREE-STEP RESOLVER
 * ───────────────────────
 *   1. Session memory. If the user picked a manual topology earlier
 *      this session, reuse it silently — unless the file has since been
 *      deleted, in which case clear the memory and fall through.
 *
 *   2. Glob discovery. Look for *.clab.yml / *.clab.yaml. Zero matches
 *      → step 3. One match → use silently. Multiple → QuickPick.
 *
 *   3. Fallback file picker. showOpenDialog scoped to workspace,
 *      filtered to .yml / .yaml as an escape hatch. User cancel = quiet
 *      exit (returns undefined).
 *
 * SESSION MEMORY MODEL
 * ────────────────────
 * Module-level Map<workspaceRoot, picked-path>. Persists for the
 * extension's lifetime, which matches the lab's lifetime (extension
 * reactivates on lab restart → fresh Map). Survives dashboard close
 * and reopen within the same session. Does NOT persist across lab
 * restarts — matches the dashboard's "honest ephemerality" posture.
 *
 * Existence-check on the remembered file handles the "user deleted
 * the topology mid-session" case silently.
 *
 * WHY THIS LIVES HERE AND NOT IN _helpers.ts
 * ───────────────────────────────────────────
 * _helpers.ts is internal to the actions/ folder and houses
 * containerlab-specific utilities (inspectDeployedLabs, RunningLab,
 * extractLabs). The topology resolver is workspace-state-related,
 * not containerlab-state-related, so it gets its own module. Keeps
 * the layering clean.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** Glob patterns for the *.clab.yml convention. */
const CLAB_GLOBS = ['**/*.clab.yml', '**/*.clab.yaml'];

/**
 * Session-scoped memory of the user's manually-picked topology file,
 * keyed by workspace root path. See module header for full rationale
 * around scope and lifetime.
 *
 * Exported so callers can update it after operations that change a
 * file's path (e.g., Start's rename gate renames lab.yml → lab.clab.yml
 * and needs to keep the remembered path consistent).
 */
export const rememberedTopology = new Map<string, string>();

/**
 * Resolve the user's intended topology file using the three-step
 * algorithm. Returns the resolved absolute path, or undefined if the
 * user cancelled at any prompt step.
 *
 * Side effect: records the resolved path in rememberedTopology so
 * subsequent calls within the same session reuse it. Callers don't
 * need to manage the memory themselves.
 *
 * The `purpose` string customizes the QuickPick / showOpenDialog
 * prompts so users see context-appropriate text ("Pick a topology
 * to deploy" vs "Pick a topology to open in editor"). Defaults to
 * "deploy" for backward compatibility with Start's original copy.
 */
export async function resolveTopology(
    workspaceRoot: string,
    wsFolder: vscode.WorkspaceFolder,
    output: vscode.OutputChannel,
    purpose: 'deploy' | 'open' = 'deploy',
): Promise<string | undefined> {
    let topologyPath: string | undefined;

    // ── Step 1: session memory ─────────────────────────────────────────────
    const remembered = rememberedTopology.get(workspaceRoot);
    if (remembered) {
        if (fs.existsSync(remembered)) {
            output.appendLine(
                `[sandboxDashboard] resolveTopology(${purpose}): using remembered ${remembered}`,
            );
            return remembered;
        }
        output.appendLine(
            `[sandboxDashboard] resolveTopology(${purpose}): remembered ${remembered} no longer exists; clearing`,
        );
        rememberedTopology.delete(workspaceRoot);
        // Fall through to discovery.
    }

    // ── Step 2: glob discovery ─────────────────────────────────────────────
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
            title: purpose === 'open' ? 'Pick a topology to open' : 'Pick a topology to deploy',
            placeHolder: purpose === 'open'
                ? 'Which .clab.yml do you want to open?'
                : 'Which .clab.yml do you want to start?',
            matchOnDescription: true,
        });
        if (!picked) {
            output.appendLine(
                `[sandboxDashboard] resolveTopology(${purpose}): cancelled at glob picker`,
            );
            return undefined;
        }
        topologyPath = picked.uri.fsPath;
    }

    // ── Step 3: fallback file picker ───────────────────────────────────────
    if (!topologyPath) {
        output.appendLine(
            `[sandboxDashboard] resolveTopology(${purpose}): no *.clab.yml found; prompting for manual file pick`,
        );
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(workspaceRoot),
            filters: { 'Topology file': ['yml', 'yaml'] },
            title: purpose === 'open' ? 'Pick a topology file to open' : 'Pick a topology file to deploy',
            openLabel: purpose === 'open' ? 'Open' : 'Use as Topology',
        });
        if (!picked || picked.length === 0) {
            output.appendLine(
                `[sandboxDashboard] resolveTopology(${purpose}): cancelled at file picker`,
            );
            return undefined;
        }
        topologyPath = picked[0].fsPath;
    }

    // ── Remember for this session ──────────────────────────────────────────
    rememberedTopology.set(workspaceRoot, topologyPath);
    output.appendLine(
        `[sandboxDashboard] resolveTopology(${purpose}): resolved to ${topologyPath}`,
    );
    return topologyPath;
}
