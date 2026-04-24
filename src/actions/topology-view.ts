/**
 * Topology View action — open the running lab in TopoViewer.
 *
 * THIN SHIM, NOT A NEW VIEWER
 * ───────────────────────────
 * We don't build a topology viewer here. srl-labs.vscode-containerlab
 * already ships TopoViewer — a polished, React-based topology viewer
 * with per-node SSH, interface hover tooltips, link impairments, and
 * packet capture integration. It's baked into lab-base-sandbox
 * alongside our extension, so it's always available in the lab.
 *
 * Our job: make it easy to find. A user who clicks Start and then
 * wants to see their topology shouldn't have to know about the
 * command palette or the Containerlab activity bar icon — one click
 * from the dashboard should do it.
 *
 * COMMAND ID RESILIENCE
 * ─────────────────────
 * Instead of hardcoding srl-labs' command ID (which we'd have to
 * guess from the palette display and would break on any future
 * rename), we enumerate registered commands at runtime and look for
 * the first `containerlab.*` command whose ID contains "topoviewer"
 * (case-insensitive). This is a small cost (~one getCommands call)
 * but buys us resilience.
 *
 * If no matching command is found, we surface a helpful error
 * toast explaining the srl-labs extension may not be installed.
 * Sandbox containers always ship it, but users running our
 * extension outside a sandbox container might hit this path.
 *
 * WHAT WE DON'T DO HERE
 * ─────────────────────
 * - We don't pass a specific topology file to TopoViewer. The
 *   srl-labs extension has its own discovery + disambiguation UI
 *   (their tree view lists deployed labs); letting them handle
 *   that keeps the boundary clean.
 * - We don't check lab-is-running ourselves before dispatching.
 *   The button is enablement-gated on deployed-lab state in the
 *   webview already; by the time dispatch happens, we trust that
 *   signal.
 * - We don't return from the dispatched command. TopoViewer takes
 *   focus; our job is done the moment the dispatch returns.
 */

import * as vscode from 'vscode';

export async function runTopologyView(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: topology-view');

    // ── Find TopoViewer command ────────────────────────────────────────────
    const commandId = await findTopoViewerCommand();
    if (!commandId) {
        output.appendLine(
            '[sandboxDashboard] topology view: no containerlab.*topoviewer command registered',
        );
        const action = await vscode.window.showErrorMessage(
            'Topology View requires the Containerlab VS Code extension (srl-labs.vscode-containerlab), ' +
                'which is bundled into sandbox lab containers. If you\'re seeing this message inside a ' +
                'sandbox lab, something is wrong with the lab image.',
            'View Log',
        );
        if (action === 'View Log') output.show();
        return;
    }

    output.appendLine(`[sandboxDashboard] dispatching to ${commandId}`);

    // ── Dispatch ───────────────────────────────────────────────────────────
    // We don't await the result meaningfully — TopoViewer opens a webview
    // panel and the command returns immediately. Any actual viewer errors
    // surface in srl-labs' own output channel, not ours.
    try {
        await vscode.commands.executeCommand(commandId);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] topology view dispatch failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Couldn't open Topology View: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') output.show();
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Find the TopoViewer command ID registered by srl-labs.vscode-containerlab.
 *
 * Strategy: enumerate all registered commands, filter to those starting
 * with `containerlab.`, and return the first whose ID contains the
 * substring "topoviewer" (case-insensitive).
 *
 * Returns undefined if no match is found. Most likely causes of a miss:
 *   - srl-labs.vscode-containerlab not installed
 *   - srl-labs renamed the command to something that doesn't include
 *     "topoviewer" in the ID (e.g. a hypothetical "containerlab.graph.viewer")
 *
 * The second case would also require a sympathetic palette-title change
 * by srl-labs, since users would be surprised by a rename of the
 * user-facing label too. Low probability but not zero; failure mode is
 * a clear error toast, not silent breakage.
 */
async function findTopoViewerCommand(): Promise<string | undefined> {
    const all = await vscode.commands.getCommands(/* filterInternal */ true);
    return all.find(
        (id) => id.startsWith('containerlab.') && id.toLowerCase().includes('topoviewer'),
    );
}
