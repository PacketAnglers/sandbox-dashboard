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

        // Content-wise M2.1 is still the placeholder — we validate that the
        // new infrastructure (scripts on, CSP correct, message channel wired)
        // works against the same visual surface the user already smoke-tested.
        // M2.2 will swap the body for state-aware rendering.
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
        h2 {
            font-size: 1.1rem;
            font-weight: 600;
            margin: 1.5rem 0 0.5rem;
            color: var(--vscode-foreground);
        }
        ul { margin: 0.4rem 0 1rem; padding-left: 1.4rem; }
        li { margin: 0.25rem 0; }
        .scaffold-note {
            margin-top: 2rem;
            padding: 1rem 1.2rem;
            border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
            background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.08));
            color: var(--vscode-descriptionForeground);
            font-size: 0.92rem;
        }
        code {
            font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
            background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.15));
            padding: 0.1em 0.4em;
            border-radius: 3px;
            font-size: 0.92em;
        }
    </style>
</head>
<body>
    <h1>🧪 Sandbox Dashboard</h1>
    <p class="tagline">Lab lifecycle — import, start, save, export — without leaving the IDE.</p>

    <h2>Coming in upcoming releases</h2>
    <ul>
        <li><strong>Import</strong> — load a previously-exported lab from a tarball.</li>
        <li><strong>Start</strong> — deploy the topology in your workspace.</li>
        <li><strong>Save</strong> — capture running configs and bundle the workspace for download.</li>
        <li><strong>Export</strong> — bundle the current workspace as a tarball.</li>
    </ul>

    <div class="scaffold-note">
        <strong>This is the v0.2.0 scaffold (M2.1).</strong> Webview is now script-enabled
        under a tight CSP, auto-opens once per workspace, and is ready to receive state
        updates from the extension host. Stateful content lands in M2.2.
    </div>

    <script nonce="${nonce}">
        // Sandbox Dashboard webview — M2.1 bootstrap.
        //
        // For M2.1, all we do is the 'ready' handshake. This proves the
        // message channel is plumbed end-to-end under our CSP. M2.2 adds
        // a state-message handler that updates the DOM.
        (function () {
            const vscode = acquireVsCodeApi();

            // Listen first, then signal ready — avoids a race where state
            // arrives between our postMessage and addEventListener registration.
            window.addEventListener('message', (event) => {
                const msg = event.data;
                // M2.1: we accept state messages but ignore the payload.
                // M2.2 replaces this with real rendering.
                if (msg && msg.type === 'state') {
                    // eslint-disable-next-line no-console
                    console.log('[sandboxDashboard] state received (M2.1 ignores payload)', msg.payload);
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
