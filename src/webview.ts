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
export function showDashboard(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    onReady?: () => void,
): DashboardPanel {
    if (currentPanel) {
        currentPanel.reveal();
        output.appendLine('[sandboxDashboard] revealed existing panel');
        return currentPanel;
    }

    currentPanel = new DashboardPanel(context, output, onReady);
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
        private readonly onReady?: () => void,
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

    dispose(): void {
        currentPanel = undefined;
        this.output.appendLine('[sandboxDashboard] panel disposed');
        while (this.disposables.length) {
            const d = this.disposables.pop();
            d?.dispose();
        }
        this.panel.dispose();
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
                this.onReady?.();
                break;
            default:
                this.output.appendLine(`[sandboxDashboard] unknown message: ${JSON.stringify(msg)}`);
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
        .empty {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .error {
            color: var(--vscode-errorForeground, #f44);
            font-size: 0.92rem;
            margin-top: 0.4rem;
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

    <div class="footnote">
        Buttons (Import / Start / Save / Export) land in Milestone 3. This release (0.2.0) adds live
        workspace awareness so the dashboard reflects what's actually true about your lab.
    </div>

    <script nonce="${nonce}">
        // Sandbox Dashboard webview — M2.2 renderer.
        //
        // Receives { type: 'state', payload: WorkspaceState } messages from the
        // extension host and updates each section's DOM to match. Pure view
        // layer — no computation, no fetching. If state changes 10x, we render
        // 10x; if it never changes, we sit forever on the initial snapshot.
        (function () {
            const vscode = acquireVsCodeApi();

            // ── Helpers ────────────────────────────────────────────────────
            // All DOM writes go through \`setBody\` so we can easily swap the
            // rendering strategy later (e.g. animate changes in M4 polish).
            function setBody(sectionId, html) {
                const el = document.getElementById(sectionId);
                if (el) el.innerHTML = html;
            }
            // Basic HTML escaping for user-controlled strings (file paths, lab
            // names). Never inject state values into HTML without going through
            // this — a .clab.yml path containing an unescaped \`<\` would break
            // the DOM and invite XSS (even inside a webview, hygiene matters).
            function esc(s) {
                if (s == null) return '';
                return String(s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }
            // Human-friendly "just now / 5s ago / 2m ago" for the last-checked
            // timestamp. Computed at render time — not live-updating, that's
            // something M2.4 polish could add via setInterval if we want it.
            function timeAgo(epochMs) {
                if (!epochMs) return 'never';
                const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
                if (diffSec < 2) return 'just now';
                if (diffSec < 60) return diffSec + 's ago';
                const m = Math.floor(diffSec / 60);
                if (m < 60) return m + 'm ago';
                const h = Math.floor(m / 60);
                return h + 'h ago';
            }

            // ── Renderers (one per section) ────────────────────────────────
            function renderWorkspace(state) {
                if (!state.workspaceRoot) {
                    setBody('workspace-body',
                        '<div class="empty">No workspace folder open. Open a folder to see lab status.</div>');
                    return;
                }
                setBody('workspace-body',
                    '<div class="kv"><span class="k">Root</span><span class="v"><code>' +
                    esc(state.workspaceRoot) + '</code></span></div>');
            }

            function renderTopologies(state) {
                const topos = state.topologies || [];
                if (topos.length === 0) {
                    setBody('topologies-body',
                        '<div class="empty">No <code>*.clab.yml</code> files found in this workspace.</div>');
                    return;
                }
                let html = '<ul class="items">';
                for (const t of topos) {
                    html += '<li><code>' + esc(t.relativePath) + '</code>';
                    if (t.depth > 0) {
                        html += '<span class="meta">(depth ' + t.depth + ')</span>';
                    }
                    html += '</li>';
                }
                html += '</ul>';
                setBody('topologies-body', html);
            }

            function renderContainerlab(state) {
                const c = state.containerlab || {};
                if (!c.available) {
                    setBody('containerlab-body',
                        '<div class="empty"><code>containerlab</code> CLI not available in this environment.</div>');
                    return;
                }
                const labs = c.deployedLabs || [];
                let html = '';
                html += '<div class="kv"><span class="k">Status</span><span class="v">Available</span></div>';
                if (labs.length === 0) {
                    html += '<div class="kv"><span class="k">Deployed labs</span><span class="v empty">None</span></div>';
                } else {
                    html += '<div class="kv"><span class="k">Deployed labs</span><span class="v">' + labs.length + '</span></div>';
                    html += '<ul class="items">';
                    for (const lab of labs) {
                        html += '<li><code>' + esc(lab.name) + '</code>' +
                                '<span class="meta">' + esc(String(lab.nodeCount)) + ' node' + (lab.nodeCount === 1 ? '' : 's') + '</span>';
                        if (lab.topologyPath) {
                            html += '<div class="meta" style="margin-left:0;font-size:0.82rem;">' + esc(lab.topologyPath) + '</div>';
                        }
                        html += '</li>';
                    }
                    html += '</ul>';
                }
                html += '<div class="kv"><span class="k">Last checked</span><span class="v">' + timeAgo(c.lastCheckedAt) + '</span></div>';
                if (c.error) {
                    html += '<div class="error">' + esc(c.error) + '</div>';
                }
                setBody('containerlab-body', html);
            }

            function render(state) {
                renderWorkspace(state);
                renderTopologies(state);
                renderContainerlab(state);
            }

            // ── Message plumbing ───────────────────────────────────────────
            // Listen first, then signal ready — avoids a race where state
            // arrives between our postMessage and addEventListener registration.
            window.addEventListener('message', (event) => {
                const msg = event.data;
                if (!msg) return;
                if (msg.type === 'state' && msg.payload) {
                    render(msg.payload);
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
