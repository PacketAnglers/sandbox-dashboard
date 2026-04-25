/**
 * Open Topology File action — explicit user-driven open of the
 * topology YAML in the editor pane.
 *
 * SEPARATION OF CONCERNS
 * ──────────────────────
 * This exists as a sibling to Topology View (which opens the lab in
 * srl-labs' graphical TopoViewer). The two answer different user
 * intents:
 *
 *   - Topology View (🗺️): "show me the graph"
 *   - Open Topology File (📝): "let me read or edit the YAML"
 *
 * Pre-v0.4.5, Topology View implicitly opened the YAML as a side
 * effect of bridging editor context for srl-labs. v0.4.5 closes
 * that file after dispatch (so Topology View no longer surprises
 * users with an unwanted editor tab) and adds this button so users
 * who DO want the YAML can open it explicitly.
 *
 * RESOLUTION STRATEGY
 * ───────────────────
 * Uses the shared three-step resolver from _topology-resolver.ts —
 * the same logic Start uses. That means:
 *   - Session memory hits first (no re-prompt)
 *   - Glob discovery for *.clab.yml
 *   - Fallback file picker for non-conforming names
 *
 * This means the button works regardless of whether the user has
 * conformed to the *.clab.yml convention, which is important
 * because users can opt out at the Start rename gate.
 *
 * EDITOR OPENING
 * ──────────────
 * Opens as a NORMAL (non-preview) tab — preview:false. The user
 * explicitly asked for this file; they probably want it to stick
 * around. Preview semantics would auto-replace it the moment they
 * open another file, which would be surprising. preserveFocus:false
 * focuses the editor since opening the file IS the action they
 * requested.
 */

import * as vscode from 'vscode';
import { resolveTopology } from './_topology-resolver';

export async function runOpenTopologyFile(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: open-topology-file');

    // ── Resolve workspace root ─────────────────────────────────────────────
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(
            'Open a folder first — Open Topology File needs a workspace.',
        );
        return;
    }
    const workspaceRoot = folders[0].uri.fsPath;
    const wsFolder = folders[0];

    // ── Resolve which topology to open ─────────────────────────────────────
    const topologyPath = await resolveTopology(workspaceRoot, wsFolder, output, 'open');
    if (!topologyPath) {
        output.appendLine('[sandboxDashboard] open-topology-file cancelled at resolution');
        return;
    }

    // ── Open it as a normal (non-preview) tab ──────────────────────────────
    try {
        await vscode.window.showTextDocument(vscode.Uri.file(topologyPath), {
            preview: false,
            preserveFocus: false,
        });
        output.appendLine(`[sandboxDashboard] opened ${topologyPath} in editor`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] open-topology-file failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Couldn't open topology file: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') output.show();
    }
}
