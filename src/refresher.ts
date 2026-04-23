/**
 * StateRefresher — reactivity engine for the dashboard.
 *
 * This class owns three responsibilities that go together:
 *
 *   1. File watchers on topology files (*.clab.yml / *.clab.yaml).
 *      Create / change / delete events trigger a recompute.
 *
 *   2. A poll timer for containerlab state (process state isn't
 *      file-driven, so we periodically ask the CLI "what's running?").
 *
 *   3. Debouncing + race-safety on the compute pipeline. File-system
 *      events cluster (editors save → truncate → write, producing 3-5
 *      events per save), so we coalesce rapid-fire triggers into a
 *      single compute. And because computes are async, we use a
 *      "latest-wins" token to drop results from superseded computes.
 *
 * The caller wiring is dead simple:
 *
 *     const refresher = new StateRefresher(output);
 *     context.subscriptions.push(refresher);
 *     refresher.schedule();  // initial compute
 *
 * `dispose()` shuts everything down — timers, watchers, in-flight
 * computes all get cleaned up. VS Code's subscription pattern handles
 * the rest.
 */

import * as vscode from 'vscode';
import { computeWorkspaceState } from './state';
import { getDashboard } from './webview';

/**
 * Cadence for containerlab status polling.
 *
 * 30s is the sweet spot: a user who deploys a lab via the terminal
 * sees it reflected in the dashboard within half a minute — "alive"
 * enough to feel responsive — while we spawn only 2 `containerlab
 * inspect` processes per minute when the dashboard is open.
 */
const CONTAINERLAB_POLL_INTERVAL_MS = 30_000;

/**
 * Debounce window for file-system events.
 *
 * Editors fire multiple FS events per save (truncate, write, rename-
 * to-temp, rename-back, etc.). 300ms coalesces those cleanly without
 * feeling sluggish to users.
 */
const FS_DEBOUNCE_MS = 300;

export class StateRefresher implements vscode.Disposable {
    private readonly watchers: vscode.FileSystemWatcher[] = [];
    private pollTimer: NodeJS.Timeout | undefined;
    private debounceTimer: NodeJS.Timeout | undefined;
    private disposed = false;

    /**
     * Monotonically-increasing token; each scheduled compute captures
     * the current value, and only pushes to the webview if its token
     * is still the latest when it completes. Guards against out-of-
     * order resolution (e.g. inspect #1 slow, inspect #2 fast —
     * without a token, #1's stale result would overwrite #2's fresh one).
     */
    private latestToken = 0;

    constructor(private readonly output: vscode.OutputChannel) {
        this.installWatchers();
        // Polling starts when the dashboard opens — see notifyDashboardOpened.
        // Running a 30s `containerlab inspect` loop forever for a dashboard
        // nobody's looking at would be gratuitous CPU waste. File watchers
        // stay armed continuously because they're nearly free.
    }

    /**
     * Call when the dashboard panel is opened (or revealed).
     *
     * Starts the containerlab poll if not already running. Safe to call
     * repeatedly — multiple opens won't spawn multiple timers.
     */
    notifyDashboardOpened(): void {
        if (this.disposed) return;
        if (this.pollTimer) return; // already polling
        this.startPolling();
    }

    /**
     * Call when the dashboard panel is closed.
     *
     * Stops the containerlab poll. File watchers keep running so that if
     * the user creates a new topology while the dashboard is closed, the
     * state is fresh when they next open it. (Watcher-triggered computes
     * are no-ops in postState when no dashboard is open, but the cost is
     * small and avoiding them would require cross-module coupling we don't
     * need yet.)
     */
    notifyDashboardClosed(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
            this.output.appendLine('[sandboxDashboard] containerlab poll paused (dashboard closed)');
        }
    }

    /**
     * Trigger a debounced state recompute.
     *
     * Callers that want "respond to this event" (a file changed, a
     * timer ticked, the user invoked the open command) call this and
     * forget. Coalescing + race safety are handled internally.
     *
     * Also: safe to call if no dashboard is open — the compute happens,
     * but the push is a no-op (getDashboard() returns undefined). Cost
     * of unused compute is small and lets us always have fresh state
     * ready the moment the user opens the dashboard.
     */
    schedule(reason: string): void {
        if (this.disposed) return;

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            this.run(reason);
        }, FS_DEBOUNCE_MS);
    }

    dispose(): void {
        this.disposed = true;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        for (const w of this.watchers) {
            w.dispose();
        }
        this.watchers.length = 0;
        this.output.appendLine('[sandboxDashboard] state refresher disposed');
    }

    // ── private ──────────────────────────────────────────────────────────────

    private installWatchers(): void {
        // One watcher per extension variant — same reason as discoverTopologies
        // in state.ts: brace alternation has been inconsistent in VS Code's
        // glob matcher across versions.
        //
        // Note: createFileSystemWatcher(pattern) scans the entire workspace
        // for the pattern; no need to restrict to workspaceFolders[0]. If
        // the user has no folder open there are simply no matches.
        for (const glob of ['**/*.clab.yml', '**/*.clab.yaml']) {
            const watcher = vscode.workspace.createFileSystemWatcher(glob);
            watcher.onDidCreate((uri) => this.schedule(`create ${uri.fsPath}`));
            watcher.onDidChange((uri) => this.schedule(`change ${uri.fsPath}`));
            watcher.onDidDelete((uri) => this.schedule(`delete ${uri.fsPath}`));
            this.watchers.push(watcher);
        }
        this.output.appendLine('[sandboxDashboard] file watchers installed for topology files');
    }

    private startPolling(): void {
        // A file watcher covers topology file changes, but containerlab
        // process state (deployed labs, node counts) isn't file-driven.
        // The user could deploy via terminal and we'd never know without
        // periodically asking the CLI. 30s balances freshness vs. CPU cost.
        this.pollTimer = setInterval(() => {
            this.schedule('poll tick');
        }, CONTAINERLAB_POLL_INTERVAL_MS);

        // In Node, setInterval keeps the event loop alive. VS Code's
        // extension host doesn't care — its main loop is always alive —
        // but unref() is good hygiene and means we don't prevent clean
        // shutdown if VS Code decides to reload extensions.
        //
        // Types note: NodeJS.Timeout has unref() but it's not on the
        // DOM Timeout alias that TS sometimes picks. Check before call.
        if (typeof (this.pollTimer as { unref?: () => void }).unref === 'function') {
            (this.pollTimer as { unref: () => void }).unref();
        }
        this.output.appendLine(
            `[sandboxDashboard] containerlab poll started (every ${CONTAINERLAB_POLL_INTERVAL_MS}ms, dashboard is open)`,
        );
    }

    /**
     * Actually execute a recompute and push the result.
     *
     * Implements the latest-wins pattern: capture a token at start,
     * check it's still the latest before pushing. If a newer compute
     * has been scheduled while we were running, our result is stale
     * and we drop it.
     */
    private async run(reason: string): Promise<void> {
        if (this.disposed) return;

        const myToken = ++this.latestToken;

        let state;
        try {
            state = await computeWorkspaceState();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[sandboxDashboard] state computation failed (${reason}): ${msg}`);
            return;
        }

        // Stale? A newer compute has already started (or finished) — drop
        // our result so we don't overwrite fresher data.
        if (myToken !== this.latestToken) {
            this.output.appendLine(
                `[sandboxDashboard] dropping stale state (token ${myToken}, latest ${this.latestToken}, reason: ${reason})`,
            );
            return;
        }

        // No dashboard open? Still valuable to have logged the attempt,
        // and we cache nothing — next time the user opens the dashboard,
        // a fresh compute runs via openAndPushState. Log and return.
        const dashboard = getDashboard();
        if (!dashboard) {
            return;
        }

        dashboard.postState(state);
        this.output.appendLine(
            `[sandboxDashboard] pushed state (${reason}): ` +
            `${state.topologies.length} topologies, ` +
            `${state.containerlab.deployedLabs.length} deployed labs, ` +
            `containerlab ${state.containerlab.available ? 'available' : 'unavailable'}`,
        );
    }
}
