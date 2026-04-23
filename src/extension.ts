import * as vscode from 'vscode';
import { showDashboard } from './webview';

/**
 * Sandbox Dashboard extension — entrypoint.
 *
 * Dashboard for UCN Sandbox labs. Surfaces the sandbox lifecycle —
 * import an existing lab, start the topology, save running state,
 * export a tarball — through a webview UI. Designed for users who
 * want to lab without learning Git or wrangling the CLI.
 *
 * Sister extension to packetanglers.lab-dashboard (techlib labs).
 * The two deliberately don't share a codebase — sandbox is a
 * stateful long-lived control plane, while lab-dashboard is a
 * write-once status renderer. Different jobs, different tools.
 *
 * ARCHITECTURE
 * ────────────
 * This file is glue. It owns:
 *   - activation / deactivation lifecycle
 *   - the output channel
 *   - the status bar button
 *   - command registration
 *   - the auto-open policy (once-per-workspace)
 *
 * Everything else lives in purpose-built modules:
 *   - src/webview.ts  → panel lifecycle, HTML, CSP, message protocol
 *   - src/types.ts    → shared types (state + messages)
 *   - src/state.ts    → (M2.2) workspace state computation
 *   - src/containerlab.ts → (M2.2) CLI wrapper
 *
 * MILESTONE STATUS
 * ────────────────
 *   M1  ✓ scaffold (0.1.0)
 *   M2.1 ✓ auto-open + script-enabled webview + message plumbing (THIS)
 *   M2.2 workspace state model + initial snapshot
 *   M2.3 file watcher + containerlab polling (reactivity)
 *   M2.4 state display polish
 *   M3  the four buttons (Import / Start / Save / Export)
 *   M4  polish, confirmations, error handling
 */

// Workspace-scoped memory key for the "have we auto-opened for this
// workspace yet?" flag. VS Code keys workspaceState by the workspace
// folder's URI, so a new lab directory gets a fresh bucket and the
// dashboard will auto-open again — exactly what we want.
const AUTO_OPEN_SHOWN_KEY = 'sandboxDashboard.autoOpenShown';

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Sandbox Dashboard');
    context.subscriptions.push(output);
    output.appendLine('[sandboxDashboard] activated (v0.2.0 — M2.1)');

    // ── Status bar button ──────────────────────────────────────────────────
    // Permanent $(beaker) Sandbox Dashboard button. One click opens (or
    // focuses) the dashboard webview regardless of whether the user closed
    // the tab, never opened it, or just can't find it. Zero discovery friction.
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100, // priority — higher places further left
    );
    statusBarItem.text = '$(beaker) Sandbox Dashboard';
    statusBarItem.tooltip = 'Open the Sandbox Dashboard';
    statusBarItem.command = 'sandboxDashboard.open';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ── Commands ───────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('sandboxDashboard.open', () => {
            output.appendLine('[sandboxDashboard] open command invoked');
            showDashboard(context, output);
        }),
    );

    // ── Auto-open policy ───────────────────────────────────────────────────
    //
    // Open the dashboard automatically the first time this extension activates
    // in a given workspace. Subsequent activations (restart, VS Code re-open,
    // etc.) respect the user's last decision — if they closed it, we stay
    // closed until they click the status bar button.
    //
    // Why first-activation-per-workspace and not every activation?
    //   - Respects a user who closed the dashboard intentionally.
    //   - New workspace = new lab = new invitation is appropriate.
    //   - Zero friction for the common case (user opens a sandbox lab → sees
    //     the dashboard immediately without fishing for a button).
    //
    // Why not always-open? Sandbox labs get long-lived. Nagging on every
    // VS Code restart would be annoying after a few days. "Once per workspace"
    // threads the needle between discovery and respect.
    maybeAutoOpen(context, output);
}

export function deactivate() {
    // Nothing to tear down — VS Code disposes everything via the
    // context.subscriptions registry and the panel's onDidDispose handler.
}

/**
 * If this is the first activation in the current workspace, open the
 * dashboard. Records the decision in workspaceState so we don't re-open
 * on subsequent activations.
 */
function maybeAutoOpen(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): void {
    // No workspace folder → no workspace state scope → nowhere to record
    // the auto-open flag. Skip auto-open; the user can still click the
    // status bar button if they want to see the dashboard.
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        output.appendLine('[sandboxDashboard] no workspace folder; skipping auto-open');
        return;
    }

    const alreadyShown = context.workspaceState.get<boolean>(AUTO_OPEN_SHOWN_KEY, false);
    if (alreadyShown) {
        output.appendLine('[sandboxDashboard] auto-open already shown for this workspace; skipping');
        return;
    }

    output.appendLine('[sandboxDashboard] first activation for this workspace; auto-opening dashboard');
    showDashboard(context, output);

    // Record immediately so even a crash before the next activation doesn't
    // re-trigger auto-open. `update` returns a thenable, but for a simple
    // flag we don't need to await — VS Code persists asynchronously and
    // the ordering doesn't affect correctness.
    void context.workspaceState.update(AUTO_OPEN_SHOWN_KEY, true);
}
