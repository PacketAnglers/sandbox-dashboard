import * as vscode from 'vscode';
import { runExport, runImport, runSave, runSetupGit, runStart, runStop, runTopologyView } from './actions';
import { getGitIdentity, hasGitInWorkspace } from './git';
import { isInFlight, markInFlight, unmarkInFlight } from './in-flight';
import { StateRefresher } from './refresher';
import type { ActionKind } from './types';
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
 *   - src/webview.ts       → panel lifecycle, HTML, CSP, message protocol
 *   - src/types.ts         → shared types (state + messages)
 *   - src/state.ts         → workspace state computation
 *   - src/containerlab.ts  → CLI wrapper
 *   - src/refresher.ts     → reactivity engine (watchers + polling + debounce)
 *
 * MILESTONE STATUS
 * ────────────────
 *   M1  ✓ scaffold (0.1.0)
 *   M2.1 ✓ auto-open + script-enabled webview + message plumbing
 *   M2.2 ✓ workspace state model + initial snapshot
 *   M2.3 ✓ file watcher + containerlab polling (reactivity) (THIS)
 *   M2.4 state display polish
 *   M3  ✓ the four buttons (Import / Start / Save / Export)
 *   M4.0 ✓ Stop button with optional save-first
 *   M4.1 ✓ GitHub clone for Import (router pattern)
 *   M4.2 ✓ Set-up-Git for committing (this release: v0.4.1)
 */

// Workspace-scoped memory key for the "have we auto-opened for this
// workspace yet?" flag. VS Code keys workspaceState by the workspace
// folder's URI, so a new lab directory gets a fresh bucket and the
// dashboard will auto-open again — exactly what we want.
const AUTO_OPEN_SHOWN_KEY = 'sandboxDashboard.autoOpenShown';

/**
 * Wrap an action body so it participates in the in-flight registry.
 *
 * Returns a callback suitable for vscode.commands.registerCommand. The
 * returned callback:
 *
 *   1. Short-circuits silently if the same kind is already in flight.
 *      This is the authoritative race-condition guard — even if a user
 *      double-fires from the palette/keybinding (where button-disable
 *      doesn't apply), the second invocation is a no-op.
 *
 *   2. Marks the kind in flight, schedules a state push (so the webview
 *      sees the change within ~debounce and disables the button), then
 *      runs the action body.
 *
 *   3. Unmarks the kind on completion via finally — runs whether the
 *      action returned, threw, or rejected. A crashing action does not
 *      permanently lock its button.
 *
 *   4. Schedules another state push after unmark so the button re-
 *      enables promptly.
 *
 * Why this lives here and not in in-flight.ts: it has to call
 * refresher.schedule(), which is wired up in activate(). Pulling
 * refresher out into a module-level singleton just for this would be a
 * bigger refactor than the helper deserves.
 */
function trackedCommand(
    kind: ActionKind,
    body: () => Promise<void>,
    refresher: StateRefresher,
    output: vscode.OutputChannel,
): () => Promise<void> {
    return async () => {
        if (isInFlight(kind)) {
            output.appendLine(
                `[sandboxDashboard] ignoring concurrent invocation of ${kind} (already in flight)`,
            );
            return;
        }
        markInFlight(kind);
        refresher.schedule(`action started: ${kind}`);
        try {
            await body();
        } finally {
            unmarkInFlight(kind);
            refresher.schedule(`action ended: ${kind}`);
        }
    };
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Sandbox Dashboard');
    context.subscriptions.push(output);
    output.appendLine('[sandboxDashboard] activated (v0.4.4 — ecosystem-rename gate)');

    // ── Reactivity engine ──────────────────────────────────────────────────
    // StateRefresher installs file watchers on *.clab.yml / *.clab.yaml,
    // starts a 30s containerlab poll, and handles debouncing + race safety
    // for recomputes. Any caller can request a fresh compute via
    // refresher.schedule(reason); if the dashboard is open, the result gets
    // pushed to the webview; if not, the compute result is simply not
    // displayed until the user opens the dashboard.
    const refresher = new StateRefresher(output);
    context.subscriptions.push(refresher);

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
            openAndRefresh(context, output, refresher);
        }),
        vscode.commands.registerCommand('sandboxDashboard.refresh', () => {
            // Immediate state refresh. Used by Start/Save so deploy/save
            // results surface in the dashboard within ~a second rather
            // than waiting up to 30s for the next containerlab poll tick.
            // No-op effect on UI if the dashboard panel isn't open — the
            // computed state is kept as `lastState` and replayed on the
            // next open.
            output.appendLine('[sandboxDashboard] refresh command invoked');
            refresher.schedule('refresh command');
        }),
        vscode.commands.registerCommand(
            'sandboxDashboard.import',
            trackedCommand('import', () => runImport(context, output), refresher, output),
        ),
        vscode.commands.registerCommand(
            'sandboxDashboard.start',
            trackedCommand('start', () => runStart(context, output), refresher, output),
        ),
        vscode.commands.registerCommand(
            'sandboxDashboard.stop',
            trackedCommand('stop', () => runStop(context, output), refresher, output),
        ),
        vscode.commands.registerCommand(
            'sandboxDashboard.save',
            trackedCommand('save', () => runSave(context, output), refresher, output),
        ),
        vscode.commands.registerCommand(
            'sandboxDashboard.export',
            trackedCommand('export', () => runExport(context, output), refresher, output),
        ),
        vscode.commands.registerCommand(
            'sandboxDashboard.topologyView',
            trackedCommand('topologyView', () => runTopologyView(context, output), refresher, output),
        ),
        vscode.commands.registerCommand('sandboxDashboard.setupGit', () => runSetupGit(context, output)),
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
    maybeAutoOpen(context, output, refresher);

    // ── Git-identity activation hook ───────────────────────────────────────
    //
    // Trigger D (hybrid): only prompt the user about git identity if there's
    // evidence git matters in this workspace — specifically, a .git directory
    // exists at workspace root or one level deep. Users who never use git in
    // the lab see nothing.
    //
    // Fires after a 2-second delay so the auto-opened dashboard has time to
    // surface first and the user isn't ambushed by competing UI on lab launch.
    // The Clone-from-GitHub action has its own gate via ensureGitIdentity()
    // so users who arrive at git-needs without an existing .git directory
    // (the clone-from-scratch path) get prompted at the right moment too.
    //
    // Sandbox containers are intentionally ephemeral; we don't try to persist
    // identity across launches. This prompt fires once per session per
    // workspace where it's relevant, and that's the contract.
    setTimeout(() => {
        void maybePromptForGitIdentity(output);
    }, 2000);
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
    refresher: StateRefresher,
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
    openAndRefresh(context, output, refresher);

    // Record immediately so even a crash before the next activation doesn't
    // re-trigger auto-open. `update` returns a thenable, but for a simple
    // flag we don't need to await — VS Code persists asynchronously and
    // the ordering doesn't affect correctness.
    void context.workspaceState.update(AUTO_OPEN_SHOWN_KEY, true);
}

/**
 * Activation-time git-identity check (Trigger D path).
 *
 * Only prompts if BOTH conditions are true:
 *   1. The workspace contains a .git directory (or one in an immediate
 *      subdirectory) — i.e., there's evidence git matters here.
 *   2. The user's global git config is missing user.name and/or
 *      user.email — i.e., they'd hit a wall the moment they try
 *      to commit.
 *
 * If both are true, shows a non-modal info notification with
 * "Set Up Now" / "Maybe Later" actions. User can dismiss; we
 * don't nag again this session (in-memory flag would be ideal,
 * but for a once-per-activation check this is already low-noise).
 *
 * Why non-modal: this is a friendly nudge, not a forced workflow.
 * The user might be just looking around and not planning to commit.
 * A modal would feel rude.
 */
async function maybePromptForGitIdentity(
    output: vscode.OutputChannel,
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const workspaceRoot = folders[0].uri.fsPath;

    // Cheap check first: do we have a .git anywhere worth caring about?
    // If not, silent skip — pure non-git workflows shouldn't see this.
    const hasGit = await hasGitInWorkspace(workspaceRoot);
    if (!hasGit) {
        output.appendLine('[sandboxDashboard] no .git in workspace; skipping git-identity prompt');
        return;
    }

    // Has git. Now check identity. If both fields are set, no prompt needed.
    const identity = await getGitIdentity();
    if (identity.name && identity.email) {
        output.appendLine(
            `[sandboxDashboard] git identity already configured: ${identity.name} <${identity.email}>`,
        );
        return;
    }

    output.appendLine(
        '[sandboxDashboard] git workspace detected with missing identity; prompting',
    );
    const choice = await vscode.window.showInformationMessage(
        'Set up Git for committing? Sandbox labs start fresh each session, ' +
            'so your name and email need to be configured before you can commit and push.',
        'Set Up Now',
        'Maybe Later',
    );
    if (choice === 'Set Up Now') {
        await vscode.commands.executeCommand('sandboxDashboard.setupGit');
    }
    // 'Maybe Later' or dismiss → silent.
}

/**
 * Open (or focus) the dashboard and trigger a fresh state refresh.
 *
 * State computation is async and flows through the StateRefresher so
 * the debounce + latest-wins logic applies uniformly whether the
 * refresh was triggered by a file change, the poll timer, or a
 * user-invoked command.
 *
 * The user sees "Computing…" placeholders for ~FS_DEBOUNCE_MS + the
 * compute duration, then the real state swaps in. For a "I just
 * clicked the button" interaction, the 300ms debounce is imperceptible.
 */
function openAndRefresh(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    refresher: StateRefresher,
): void {
    showDashboard(context, output, {
        onDispose: () => refresher.notifyDashboardClosed(),
    });
    refresher.notifyDashboardOpened();
    refresher.schedule('open command');
}
