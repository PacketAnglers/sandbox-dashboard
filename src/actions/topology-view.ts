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
 * Instead of hardcoding srl-labs' command ID, we enumerate registered
 * commands at runtime and look for the first `containerlab.*` command
 * whose ID contains "topoviewer" (case-insensitive). Buys resilience
 * against future srl-labs renames. As of the v0.4.2 smoke test, the
 * actual ID is `containerlab.lab.graph.topoViewer`.
 *
 * EDITOR-CONTEXT BRIDGING (added v0.4.3)
 * ──────────────────────────────────────
 * srl-labs' TopoViewer command discovers its target topology via the
 * active text editor's URI. Dispatched from our webview, the active
 * editor is either nothing or our webview panel — neither resolves to
 * a topology file. Result: srl-labs surfaces "No lab node or topology
 * file selected" and bails.
 *
 * We bridge by opening the deployed lab's topology file as a preview
 * tab BEFORE dispatching. preview:true gives single-italic-tab
 * semantics that read as transient (auto-replaced by the next preview
 * file the user opens); preserveFocus:false ensures the editor
 * actually becomes the active one before we dispatch.
 *
 * The topology path comes from `containerlab inspect` (via shared
 * inspectDeployedLabs helper) rather than the dashboard's cached
 * Topologies state — fresh source of truth, works for any deployed
 * lab regardless of filename convention.
 *
 * INTEGRATION-SHIM PLAYBOOK
 * ─────────────────────────
 * Topology View is the first instance of "dashboard as launcher for
 * other extensions' capabilities." The pattern that worked here:
 *   1. Don't rebuild — defer to the upstream extension
 *   2. Thin shim module in src/actions/
 *   3. Dynamic command discovery, not hardcoded IDs
 *   4. Discover what context the target command expects (active
 *      editor? specific selection? command args?) and set it up
 *      BEFORE dispatch
 *   5. Clear error toast if target extension is missing
 *   6. Button in actions row with appropriate enablement gate
 *
 * Step 4 is the lesson from v0.4.3: integration shims may need to
 * BRIDGE context, not just dispatch.
 *
 * WHAT WE DON'T DO HERE
 * ─────────────────────
 * - We don't pass a topology file as a command arg. srl-labs'
 *   command doesn't accept one (it discovers via active editor).
 * - We DO close the preview-opened editor afterward (v0.4.5
 *   change). Pre-v0.4.5 we left it open per Option C from the
 *   v0.4.3 design discussion. User feedback: a lingering YAML
 *   tab after clicking "view the graph" is presumptuous. v0.4.5
 *   smart-closes only if WE opened the file (vs. it was already
 *   open before our pre-open). Users who explicitly want the
 *   YAML in the editor can use the new Open Topology File button.
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { inspectDeployedLabs, RunningLab } from './_helpers';

export async function runTopologyView(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: topology-view');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Topology View needs a workspace context.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;

    // ── Identify the deployed lab to view ──────────────────────────────────
    // Fresh read via inspectDeployedLabs rather than relying on the
    // dashboard's cached state. The button enablement gate in the webview
    // already verified hasDeployedLab from cached state, but cached state
    // can be up to 30s stale; by the time this dispatch runs, the lab
    // could have been destroyed externally. Defensive re-check.
    const deployed = await inspectDeployedLabs(output);
    if (deployed.length === 0) {
        vscode.window.showInformationMessage(
            'No lab is currently deployed. Topology View needs a running lab to display.',
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
            title: 'Pick a lab to open in Topology View',
            placeHolder: 'Which deployed lab do you want to view?',
            matchOnDescription: true,
        });
        if (!picked) {
            output.appendLine('[sandboxDashboard] topology view cancelled by user (no lab picked)');
            return;
        }
        lab = picked.lab;
    }
    output.appendLine(
        `[sandboxDashboard] topology view: lab "${lab.name}" (topology ${lab.topologyPath})`,
    );

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

    // ── Bridge editor context: pre-open topology as preview ────────────────
    // srl-labs' TopoViewer command discovers its target via the active
    // text editor's URI. Without an anchor it bails with "No lab node or
    // topology file selected." We open the topology file as a preview
    // tab with preserveFocus:false so the editor actually becomes
    // active before we dispatch.
    //
    // SMART CLEANUP (added v0.4.5): we capture whether the file was
    // already open before our pre-open. If we opened it, we close it
    // after dispatch — the user clicked "Topology View" expressing intent
    // to see the GRAPH, not to open the YAML in the editor pane. Leaving
    // the YAML tab around is presumptuous. If the user already had it
    // open, we leave it alone — they had it open for a reason.
    //
    // Resolve to absolute path: containerlab's labPath may be relative
    // to wherever containerlab was invoked. We anchor against the
    // workspace root so showTextDocument always gets a valid file URI.
    const absoluteTopologyPath = path.isAbsolute(lab.topologyPath)
        ? lab.topologyPath
        : path.join(workspaceRoot, lab.topologyPath);

    const wasAlreadyOpen = vscode.workspace.textDocuments.some(
        (doc) => doc.uri.fsPath === absoluteTopologyPath,
    );

    try {
        await vscode.window.showTextDocument(
            vscode.Uri.file(absoluteTopologyPath),
            { preview: true, preserveFocus: false },
        );
        output.appendLine(
            `[sandboxDashboard] anchored editor on ${absoluteTopologyPath} for TopoViewer` +
                (wasAlreadyOpen ? ' (was already open; will leave open)' : ' (will close after dispatch)'),
        );
    } catch (err) {
        // Best-effort. If the file can't be opened (deleted, permissions,
        // etc.) we still dispatch — worst case srl-labs surfaces the same
        // "no topology" error we were trying to prevent, which is no
        // worse than the pre-v0.4.3 behavior.
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(
            `[sandboxDashboard] could not pre-open ${absoluteTopologyPath}: ${msg}; dispatching anyway`,
        );
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
        return;
    }

    // ── Smart cleanup: close our pre-open if we opened it ──────────────────
    // Find the specific tab matching our topology file URI and close
    // just that one — NOT closeActiveEditor, which by now is probably
    // TopoViewer itself (not what we want to close).
    //
    // tabGroups API is in VS Code 1.67+; sandbox containers ship code-
    // server with a recent enough version. Best-effort: if the close
    // fails for any reason, we log and move on — the user can dismiss
    // the lingering tab manually.
    if (!wasAlreadyOpen) {
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (
                        tab.input instanceof vscode.TabInputText &&
                        tab.input.uri.fsPath === absoluteTopologyPath
                    ) {
                        await vscode.window.tabGroups.close(tab);
                        output.appendLine(
                            `[sandboxDashboard] closed transient editor tab for ${absoluteTopologyPath}`,
                        );
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(
                `[sandboxDashboard] could not close transient editor tab: ${msg}`,
            );
        }
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
