/**
 * Webview panel management for the sandbox-dashboard.
 *
 * This module owns everything about the panel:
 *   - Creating the panel with the right options and CSP
 *   - The message channel (both directions)
 *   - Building the HTML (placeholder in M2.1, stateful in M2.2+)
 *   - Dispose lifecycle
 *
 * The extension.ts module remains glue: it tells `DashboardPanel`
 * when to open/focus, and pushes state updates via `postState()`.
 * The webview itself stays dumb — it renders what it's told.
 */

import * as vscode from 'vscode';
import { ExtensionMessage, WebviewMessage, WorkspaceState } from './types';

// ─── Panel singleton ────────────────────────────────────────────────────────
//
// One workspace, one dashboard. Re-invoking "open" reveals the existing
// panel rather than spawning duplicates. Matches how lab-dashboard
// works on the techlib side and is what users expect.

let currentPanel: DashboardPanel | undefined;

/**
 * Open the dashboard panel, or focus it if one already exists.
 *
 * The optional `onReady` callback fires the first time the webview
 * signals it's ready to receive state. Extension.ts uses this to
 * push the initial state snapshot without racing script-load.
 */
/**
 * Options for showing the dashboard.
 *
 * Callbacks are decoupling hooks for cross-module concerns (like the
 * refresher wanting to know when the panel opens/closes) without the
 * webview module needing to know about the refresher.
 */
export interface ShowDashboardOptions {
    /** Fires once the first time the webview signals it's ready to receive state. */
    onReady?: () => void;
    /** Fires when the panel is disposed (user closed tab, or extension shutdown). */
    onDispose?: () => void;
}

export function showDashboard(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    opts: ShowDashboardOptions = {},
): DashboardPanel {
    if (currentPanel) {
        currentPanel.reveal();
        output.appendLine('[sandboxDashboard] revealed existing panel');
        return currentPanel;
    }

    currentPanel = new DashboardPanel(context, output, opts);
    output.appendLine('[sandboxDashboard] panel created');
    return currentPanel;
}

/**
 * Return the current panel if one is open, else undefined.
 *
 * Used by extension.ts to push state updates only when a panel
 * exists — no point computing state for nobody.
 */
export function getDashboard(): DashboardPanel | undefined {
    return currentPanel;
}

// ─── DashboardPanel class ───────────────────────────────────────────────────

export class DashboardPanel {
    private readonly panel: vscode.WebviewPanel;
    private readonly output: vscode.OutputChannel;
    private readonly disposables: vscode.Disposable[] = [];
    private lastState: WorkspaceState | undefined;
    private ready = false;

    constructor(
        context: vscode.ExtensionContext,
        output: vscode.OutputChannel,
        private readonly opts: ShowDashboardOptions = {},
    ) {
        this.output = output;

        this.panel = vscode.window.createWebviewPanel(
            'sandboxDashboard',       // viewType
            'Sandbox Dashboard',      // tab title
            vscode.ViewColumn.Active,
            {
                // M2 needs JS in the webview for message-driven DOM updates.
                // CSP below keeps the attack surface tiny — only our inline
                // script (identified by a fresh nonce) is allowed to run.
                enableScripts: true,
                // Preserve scroll position & DOM when tab is hidden; otherwise
                // every tab-away would cause a full re-render. For a dashboard
                // that's explicitly supposed to reflect live state, this also
                // means we need to re-send state when revealed (we don't bother
                // for M2 — state pushes are cheap and the webview just overwrites).
                retainContextWhenHidden: true,
            },
        );

        this.panel.webview.html = this.buildHtml();

        // Webview → Extension messages. M2 only carries 'ready'.
        this.panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.handleMessage(msg),
            null,
            this.disposables,
        );

        this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
    }

    reveal(): void {
        this.panel.reveal(vscode.ViewColumn.Active);
    }

    /**
     * Push a state snapshot to the webview.
     *
     * Stores locally so that if the webview isn't ready yet, we can
     * replay the latest on the 'ready' handshake. Callers don't need
     * to worry about timing — just call postState whenever state
     * changes, and the webview will converge.
     */
    postState(state: WorkspaceState): void {
        this.lastState = state;
        if (this.ready) {
            const msg: ExtensionMessage = { type: 'state', payload: state };
            this.panel.webview.postMessage(msg);
        }
    }

    /**
     * Push an error banner to the webview.
     *
     * Distinct from state-level errors (containerlab inspect failing,
     * unrecognized JSON shape — those surface inline inside the
     * relevant section). postError is for truly-unexpected failures,
     * typically thrown from inside an async compute that we weren't
     * able to wrap into a well-formed state. The webview renders
     * these as a prominent top-of-page banner so the user knows
     * something broke.
     *
     * A subsequent successful postState clears the banner
     * automatically (webview-side), so no explicit "clear" is needed
     * from callers — just push fresh state and the UI recovers.
     */
    postError(message: string): void {
        if (this.ready) {
            const msg: ExtensionMessage = { type: 'error', payload: { message } };
            this.panel.webview.postMessage(msg);
        }
        // If the webview isn't ready yet, we don't persist the error
        // like we do with state — by the time the webview loads, the
        // underlying problem may have resolved and showing a stale error
        // would be confusing. Errors are ephemeral; state is durable.
    }

    dispose(): void {
        currentPanel = undefined;
        this.output.appendLine('[sandboxDashboard] panel disposed');
        while (this.disposables.length) {
            const d = this.disposables.pop();
            d?.dispose();
        }
        this.panel.dispose();
        // Fire the onDispose callback last — listeners (like the refresher)
        // should see the panel truly gone before they react.
        this.opts.onDispose?.();
    }

    // ── private ──────────────────────────────────────────────────────────────

    private handleMessage(msg: WebviewMessage): void {
        switch (msg.type) {
            case 'ready':
                this.ready = true;
                this.output.appendLine('[sandboxDashboard] webview ready');
                // Replay last known state if we have one — guards against
                // races where state was pushed before the webview finished
                // loading.
                if (this.lastState) {
                    const replay: ExtensionMessage = { type: 'state', payload: this.lastState };
                    this.panel.webview.postMessage(replay);
                }
                // Signal extension.ts that it can now start computing and
                // pushing state if it wants to.
                this.opts.onReady?.();
                break;
            case 'action':
                // Dispatch to the registered VS Code command. Using
                // executeCommand rather than calling the action directly
                // keeps the command palette / keybinding / webview paths
                // fully convergent — they all end up in the same place.
                this.output.appendLine(
                    `[sandboxDashboard] action requested from webview: ${msg.payload.kind}`,
                );
                void vscode.commands.executeCommand(
                    `sandboxDashboard.${msg.payload.kind}`,
                );
                break;
            default: {
                // Exhaustiveness check — if a new message type is added to
                // WebviewMessage, TypeScript flags this line as an error
                // until we handle it above.
                const _exhaustive: never = msg;
                this.output.appendLine(
                    `[sandboxDashboard] unknown message: ${JSON.stringify(_exhaustive)}`,
                );
            }
        }
    }

    private buildHtml(): string {
        // Fresh nonce per render — CSP requires it.
        const nonce = generateNonce();
        const cspSource = this.panel.webview.cspSource;

        // CSP breakdown:
        //   default-src 'none'      — deny everything that isn't explicitly allowed
        //   style-src cspSource
        //             'unsafe-inline' — allow inline <style> blocks
        //                               ('unsafe-inline' is standard for VS Code
        //                               webviews that don't ship an external stylesheet)
        //   script-src 'nonce-…'    — allow ONLY our inline script block bearing
        //                             the matching nonce. External scripts, eval,
        //                             and unnonced inline scripts are all blocked.
        const csp = [
            `default-src 'none'`,
            `style-src ${cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        // M2.2: the HTML ships with an initial "Computing state…" placeholder
        // in every section. The script registers a message handler that
        // receives state messages and swaps the placeholders for real content.
        // This means the webview briefly shows "Computing…" between the ready
        // handshake and the first state push — honest, informative UX that
        // beats rendering a blank page.
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Sandbox Dashboard</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 2rem 2.5rem;
            line-height: 1.6;
            max-width: 760px;
        }
        h1 { margin: 0 0 0.5rem; font-size: 1.8rem; font-weight: 600; }
        .tagline {
            color: var(--vscode-descriptionForeground);
            margin: 0 0 2rem;
            font-size: 1.05rem;
        }
        section { margin: 1.75rem 0; }
        section h2 {
            font-size: 1.05rem;
            font-weight: 600;
            margin: 0 0 0.6rem;
            color: var(--vscode-foreground);
            text-transform: uppercase;
            letter-spacing: 0.04em;
            font-size: 0.85rem;
            color: var(--vscode-descriptionForeground);
        }
        .kv { margin: 0.3rem 0; }
        .kv .k {
            display: inline-block;
            min-width: 8.5rem;
            color: var(--vscode-descriptionForeground);
        }
        .kv .v { color: var(--vscode-foreground); }
        ul.items { list-style: none; margin: 0.4rem 0; padding: 0; }
        ul.items li {
            padding: 0.35rem 0.6rem;
            border-left: 2px solid transparent;
        }
        ul.items li + li { border-top: 1px solid var(--vscode-widget-border, transparent); }
        ul.items li .meta {
            color: var(--vscode-descriptionForeground);
            font-size: 0.88rem;
            margin-left: 0.5rem;
        }
        /* Topology grouping: root-level list + nested subfolder groups.
           The subfolder label is prominent so users can scan by directory;
           the files within are indented for clear hierarchy. */
        .topo-group {
            margin: 0.6rem 0;
        }
        .topo-group-label {
            display: block;
            color: var(--vscode-descriptionForeground);
            font-size: 0.88rem;
            margin: 0.8rem 0 0.25rem;
            padding-left: 0.1rem;
        }
        .topo-group-label::before { content: "📁 "; font-size: 0.9rem; }
        .topo-item {
            padding: 0.25rem 0.6rem 0.25rem 1.5rem;
            font-size: 0.95rem;
        }
        .topo-item.root-level { padding-left: 0.6rem; }
        /* Running-lab indicator: a small green dot signals "there is a live
           deployment." Inherits from charts/diff colors so it respects high-
           contrast themes. */
        .running-dot {
            display: inline-block;
            width: 0.55rem;
            height: 0.55rem;
            border-radius: 50%;
            background: var(--vscode-charts-green, #0a0);
            margin-right: 0.4rem;
            vertical-align: middle;
        }
        .empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        /* Hint inside an empty-state, rendered smaller/dimmer so it feels
           like guidance, not filler. */
        .empty-hint {
            display: block;
            font-style: normal;
            font-size: 0.88rem;
            color: var(--vscode-descriptionForeground);
            margin-top: 0.3rem;
            opacity: 0.8;
        }
        .error {
            color: var(--vscode-errorForeground, #f44);
            font-size: 0.92rem;
            margin-top: 0.4rem;
        }
        /* Top-of-page error banner: prominent enough to notice immediately,
           but uses the editor's own error colors so it never clashes. */
        .error-banner {
            margin: 0 0 1.5rem;
            padding: 0.75rem 1rem;
            border-left: 3px solid var(--vscode-errorForeground, #f44);
            background: var(--vscode-inputValidation-errorBackground, rgba(255,60,60,0.08));
            color: var(--vscode-errorForeground, #f44);
            font-size: 0.92rem;
            display: none; /* shown via JS when an error state arrives */
        }
        .error-banner.visible { display: block; }
        /* Actions row: the four lifecycle buttons at the top of the
           dashboard. Uses VS Code's own button color tokens so it reads
           as a native control in whichever theme the user has active. */
        .actions-row {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin: 0.5rem 0 1.5rem;
        }
        .action-btn {
            /* Mimic a VS Code button. These CSS vars are provided by the
               editor to every webview; if a theme ever stops defining
               them, we fall back to reasonable defaults. */
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #fff);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 0.45rem 0.9rem;
            font-size: 0.92rem;
            font-family: var(--vscode-font-family);
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.15s ease, opacity 0.15s ease;
        }
        .action-btn:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }
        .action-btn:focus {
            outline: 1px solid var(--vscode-focusBorder, #007fd4);
            outline-offset: 2px;
        }
        .action-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .action-btn .icon {
            margin-right: 0.35rem;
            font-size: 0.95em;
        }
        code {
            font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
            background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.15));
            padding: 0.1em 0.4em;
            border-radius: 3px;
            font-size: 0.92em;
        }
        .footnote {
            margin-top: 2.5rem;
            padding-top: 1rem;
            border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
            color: var(--vscode-descriptionForeground);
            font-size: 0.85rem;
        }
    </style>
</head>
<body>
    <h1>🧪 Sandbox Dashboard</h1>
    <p class="tagline">Lab lifecycle — import, start, save, export — without leaving the IDE.</p>

    <div id="error-banner" class="error-banner" role="alert"></div>

    <section id="section-actions">
        <h2>Actions</h2>
        <div class="actions-row">
            <button type="button" class="action-btn" data-action="import" id="action-import">
                <span class="icon">📥</span>Import
            </button>
            <button type="button" class="action-btn" data-action="start" id="action-start">
                <span class="icon">▶️</span>Start
            </button>
            <button type="button" class="action-btn" data-action="topologyView" id="action-topology-view">
                <span class="icon">🗺️</span>Topology View
            </button>
            <button type="button" class="action-btn" data-action="stop" id="action-stop">
                <span class="icon">🛑</span>Stop
            </button>
            <button type="button" class="action-btn" data-action="save" id="action-save">
                <span class="icon">💾</span>Save
            </button>
            <button type="button" class="action-btn" data-action="export" id="action-export">
                <span class="icon">📦</span>Export
            </button>
        </div>
    </section>

    <section id="section-workspace">
        <h2>Workspace</h2>
        <div id="workspace-body" class="empty">Computing…</div>
    </section>

    <section id="section-topologies">
        <h2>Topologies</h2>
        <div id="topologies-body" class="empty">Computing…</div>
    </section>

    <section id="section-containerlab">
        <h2>ContainerLab</h2>
        <div id="containerlab-body" class="empty">Computing…</div>
    </section>

    <script nonce="${nonce}">
        // Sandbox Dashboard webview — M2.4 renderer.
        //
        // Receives state / error messages from the extension host and
        // updates each section's DOM to match. Pure view layer — no
        // computation, no fetching. If state changes 10x, we render
        // 10x; if it never changes, we sit forever on the initial snapshot.
        //
        // M2.4 additions over M2.3:
        //   • Topologies grouped by subdirectory
        //   • Welcoming empty states (hints, not shrugs)
        //   • Live-updating "Ns ago" timestamp (setInterval refresh)
        //   • Prominent top-of-page error banner
        //   • Error message-type handler
        (function () {
            const vscode = acquireVsCodeApi();

            // ── Helpers ────────────────────────────────────────────────────
            function setBody(sectionId, html) {
                const el = document.getElementById(sectionId);
                if (el) el.innerHTML = html;
            }
            function esc(s) {
                // HTML-escape user-controlled strings before DOM insertion.
                // File paths, lab names — anything that could contain '<' or
                // '&' — must go through this. XSS hygiene inside a webview
                // matters just as much as in a browser.
                if (s == null) return '';
                return String(s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }
            function timeAgo(epochMs) {
                // Human-friendly "just now / 5s ago / 2m ago". Updated both
                // on state push and by the setInterval refresher so the
                // timestamp never sits stale while the dashboard is open.
                if (!epochMs) return 'never';
                const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
                if (diffSec < 2) return 'just now';
                if (diffSec < 60) return diffSec + 's ago';
                const m = Math.floor(diffSec / 60);
                if (m < 60) return m + 'm ago';
                const h = Math.floor(m / 60);
                return h + 'h ago';
            }

            // Holds the most-recent state so the setInterval refresher can
            // repaint timestamps without waiting for the extension to push
            // a fresh state message. If no state has arrived yet, this is
            // undefined and the interval no-ops.
            let latestState;

            // ── Workspace section ──────────────────────────────────────────
            function renderWorkspace(state) {
                if (!state.workspaceRoot) {
                    setBody('workspace-body',
                        '<div class="empty">No workspace folder open.' +
                        '<span class="empty-hint">Open a folder via <code>File → Open Folder…</code> to see lab status.</span>' +
                        '</div>');
                    return;
                }
                setBody('workspace-body',
                    '<div class="kv"><span class="k">Root</span><span class="v"><code>' +
                    esc(state.workspaceRoot) + '</code></span></div>');
            }

            // ── Topologies section ─────────────────────────────────────────
            // Group by the first segment of the relative path. Root-level files
            // show first with no group header; subfolders get a folder label
            // ("📁 sandbox-template") with their files indented beneath.
            function groupTopologies(topos) {
                const root = [];
                const groups = new Map(); // groupName → array
                for (const t of topos) {
                    if (!t.relativePath.includes('/') && !t.relativePath.includes('\\\\')) {
                        root.push(t);
                    } else {
                        // Split on either separator for cross-platform safety.
                        const firstSep = Math.min(
                            ...[t.relativePath.indexOf('/'), t.relativePath.indexOf('\\\\')]
                                .filter((i) => i !== -1),
                        );
                        const groupName = t.relativePath.slice(0, firstSep);
                        if (!groups.has(groupName)) groups.set(groupName, []);
                        groups.get(groupName).push(t);
                    }
                }
                return { root, groups };
            }

            function renderTopologies(state) {
                const topos = state.topologies || [];
                if (topos.length === 0) {
                    setBody('topologies-body',
                        '<div class="empty">No <code>*.clab.yml</code> files in this workspace yet.' +
                        '<span class="empty-hint">Create one to describe your topology, or import an existing lab tarball (coming in M3).</span>' +
                        '</div>');
                    return;
                }

                const { root, groups } = groupTopologies(topos);
                let html = '';

                // Root-level files render first, without a folder header.
                if (root.length > 0) {
                    html += '<div class="topo-group">';
                    for (const t of root) {
                        html += '<div class="topo-item root-level"><code>' + esc(t.relativePath) + '</code></div>';
                    }
                    html += '</div>';
                }

                // Subfolders alphabetical for stable ordering across renders.
                const sortedGroups = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
                for (const groupName of sortedGroups) {
                    html += '<div class="topo-group">';
                    html += '<span class="topo-group-label">' + esc(groupName) + '</span>';
                    for (const t of groups.get(groupName)) {
                        // Show the relative path sans the group prefix so the
                        // indentation carries the directory context, not the text.
                        const rest = t.relativePath.slice(groupName.length + 1);
                        html += '<div class="topo-item"><code>' + esc(rest) + '</code></div>';
                    }
                    html += '</div>';
                }

                setBody('topologies-body', html);
            }

            // ── ContainerLab section ───────────────────────────────────────
            function renderContainerlab(state) {
                const c = state.containerlab || {};
                if (!c.available) {
                    setBody('containerlab-body',
                        '<div class="empty"><code>containerlab</code> CLI not detected.' +
                        '<span class="empty-hint">The sandbox-dashboard container image ships containerlab — if you are seeing this outside that image, install it from <code>containerlab.dev</code>.</span>' +
                        '</div>');
                    return;
                }
                const labs = c.deployedLabs || [];
                let html = '';
                html += '<div class="kv"><span class="k">Status</span><span class="v">Available</span></div>';

                if (labs.length === 0) {
                    html += '<div class="kv"><span class="k">Deployed labs</span><span class="v empty">None running</span></div>';
                } else {
                    html += '<div class="kv"><span class="k">Deployed labs</span><span class="v">' + labs.length + '</span></div>';
                    html += '<ul class="items">';
                    for (const lab of labs) {
                        html += '<li><span class="running-dot" title="Running"></span><code>' + esc(lab.name) + '</code>' +
                                '<span class="meta">' + esc(String(lab.nodeCount)) + ' node' + (lab.nodeCount === 1 ? '' : 's') + '</span>';
                        if (lab.topologyPath) {
                            html += '<div class="meta" style="margin-left:1.2rem;font-size:0.82rem;">' + esc(lab.topologyPath) + '</div>';
                        }
                        html += '</li>';
                    }
                    html += '</ul>';
                }

                html += '<div class="kv"><span class="k">Last checked</span>' +
                        '<span class="v" data-timestamp="' + (c.lastCheckedAt || 0) + '">' +
                        timeAgo(c.lastCheckedAt) + '</span></div>';

                if (c.error) {
                    html += '<div class="error">' + esc(c.error) + '</div>';
                }
                setBody('containerlab-body', html);
            }

            // ── Error banner ───────────────────────────────────────────────
            // The extension sends { type: 'error', payload: { message } } when
            // a truly unexpected failure occurred. State-level errors (like
            // containerlab inspect failing) are rendered inline in their
            // section; this banner is for "I don't know what's going on"
            // situations that need user awareness.
            function showErrorBanner(message) {
                const banner = document.getElementById('error-banner');
                if (!banner) return;
                banner.textContent = message;
                banner.classList.add('visible');
            }
            function clearErrorBanner() {
                const banner = document.getElementById('error-banner');
                if (!banner) return;
                banner.textContent = '';
                banner.classList.remove('visible');
            }

            // ── Render ─────────────────────────────────────────────────────
            function render(state) {
                latestState = state;
                // A successful state push means whatever error caused the
                // banner is either resolved or we have fresh info that
                // supersedes it. Clear it.
                clearErrorBanner();
                renderWorkspace(state);
                renderTopologies(state);
                renderContainerlab(state);
            }

            // ── Action buttons ─────────────────────────────────────────────
            // Each button has a data-action attribute whose value matches the
            // ActionKind union in src/types.ts. Clicking sends a message to
            // the extension host, which dispatches to the corresponding
            // VS Code command (sandboxDashboard.<kind>).
            //
            // In M3.1 all buttons are always enabled. M3.2-M3.5 will tighten
            // updateButtonEnablement() as each action gains real behavior,
            // disabling buttons whose preconditions aren't met.
            document.querySelectorAll('.action-btn[data-action]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const kind = btn.getAttribute('data-action');
                    if (!kind) return;
                    vscode.postMessage({ type: 'action', payload: { kind: kind } });
                });
            });

            function updateButtonEnablement(state) {
                const hasWorkspace = !!(state && state.workspaceRoot);
                const hasTopology = !!(state && state.topologies && state.topologies.length > 0);
                const hasDeployedLab = !!(
                    state && state.containerlab &&
                    state.containerlab.deployedLabs &&
                    state.containerlab.deployedLabs.length > 0
                );

                // Export & Import: both need a workspace to exist. Export has
                // to have something to bundle; Import has to have somewhere
                // to extract into.
                setDisabled('action-export', !hasWorkspace);
                setDisabled('action-import', !hasWorkspace);

                // Start: needs a workspace. The runStart action has a
                // three-step topology resolver:
                //   1. Session memory (remembered manual pick)
                //   2. Glob discovery (*.clab.yml / *.clab.yaml)
                //   3. Fallback file picker (for non-standard filenames)
                // That means Start is useful even with zero glob matches,
                // so we don't disable on !hasTopology anymore. The
                // hasTopology signal still informs the Topologies SECTION
                // display, just not this button's enablement.
                setDisabled('action-start', !hasWorkspace);

                // Save & Stop: both need a deployed lab. The moment the
                // last lab is destroyed, both buttons grey out together.
                // Save captures configs from a running lab; Stop tears
                // down a running lab. Neither has work to do otherwise.
                setDisabled('action-save', !hasWorkspace || !hasDeployedLab);
                setDisabled('action-stop', !hasWorkspace || !hasDeployedLab);

                // Topology View: needs a deployed lab. Same enablement
                // condition as Stop/Save because "look at the running
                // lab" only makes sense when there IS a running lab.
                // The action is a thin shim that dispatches to
                // srl-labs' TopoViewer; button is live the moment a
                // lab is deployed, dims the moment it's destroyed.
                setDisabled('action-topology-view', !hasWorkspace || !hasDeployedLab);
            }

            function setDisabled(id, disabled) {
                const el = document.getElementById(id);
                if (!el) return;
                if (disabled) {
                    el.setAttribute('disabled', 'disabled');
                } else {
                    el.removeAttribute('disabled');
                }
            }

            // Every 5 seconds, refresh any [data-timestamp] element on the page.
            // This keeps "Last checked: 12s ago" counting up smoothly even when
            // the underlying state hasn't changed. Without this, the text would
            // sit frozen at the value it had when state was last pushed.
            setInterval(() => {
                document.querySelectorAll('[data-timestamp]').forEach((el) => {
                    const ts = Number(el.getAttribute('data-timestamp'));
                    if (ts) el.textContent = timeAgo(ts);
                });
            }, 5000);

            // ── Message plumbing ───────────────────────────────────────────
            // Listen first, then signal ready — avoids a race where state
            // arrives between our postMessage and addEventListener registration.
            window.addEventListener('message', (event) => {
                const msg = event.data;
                if (!msg) return;
                if (msg.type === 'state' && msg.payload) {
                    render(msg.payload);
                    updateButtonEnablement(msg.payload);
                } else if (msg.type === 'error' && msg.payload && msg.payload.message) {
                    showErrorBanner(msg.payload.message);
                }
            });

            vscode.postMessage({ type: 'ready' });
        })();
    </script>
</body>
</html>`;
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random nonce for CSP.
 *
 * Per VS Code webview guidance, a fresh nonce per render is standard.
 * 32 random hex chars is plenty — mirrors the length VS Code samples use.
 */
function generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
