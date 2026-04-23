import * as vscode from 'vscode';

/**
 * Sandbox Dashboard extension
 *
 * Dashboard for UCN Sandbox labs. Surfaces the sandbox lifecycle —
 * import an existing lab, start the topology, save running state,
 * export a tarball — through a webview UI. Designed for users who
 * want to lab without learning Git or wrangling the CLI.
 *
 * Sister extension to packetanglers.lab-dashboard, which serves the
 * techlib labs. The two extensions deliberately do not share a
 * codebase — sandbox is a stateful long-lived control plane, while
 * lab-dashboard is a write-once status renderer. Different jobs,
 * different tools.
 *
 * MILESTONE 1 STATUS
 * ──────────────────
 * This is the scaffold release. Activation, output channel, status
 * bar button, and a single command that opens an empty webview
 * placeholder. No buttons, no workspace scanning, no operations.
 * All of that lands in subsequent milestones:
 *   - M2: workspace status + topology detection
 *   - M3: the four buttons (Import / Start / Save / Export)
 *   - M4: polish, confirmations, error handling
 *
 * Why ship M1 standalone? It locks in the marketplace ID, command
 * namespace, container image pairing, and OpenVSX publish pipeline.
 * Those are hard-to-change once published. Better to validate them
 * on a tiny scaffold than discover a problem mid-feature.
 */

// Track the dashboard panel so re-invoking the command focuses the
// existing panel instead of spawning duplicates. Single-panel model
// is the right call for sandbox — there's only one workspace, and
// the dashboard reflects its state. No reason to have two views.
let dashboardPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Sandbox Dashboard');
	context.subscriptions.push(output);
	output.appendLine('[sandboxDashboard] activated (v0.1.0 scaffold)');

	// ── Status bar button ──────────────────────────────────────────────────
	// Permanent "🧪 Sandbox" button in the bottom status bar. One click
	// opens (or focuses) the dashboard webview regardless of whether the
	// user closed the tab, never opened it, or just can't find it. Zero
	// discovery friction — always visible, always works.
	//
	// Icon choice: $(beaker) maps to Codicon's flask/beaker glyph, which
	// reads visually as "experiment / sandbox / try things." Mirrors the
	// lab-dashboard pattern of using a Codicon (it uses $(preview)) plus
	// a short descriptive label.
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100, // priority — higher values place the item further left
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
			openDashboard(context, output);
		}),
	);
}

export function deactivate() {
	// Nothing to tear down — VS Code disposes everything via the
	// context.subscriptions registry and the panel's onDidDispose handler.
}

/**
 * Open or focus the dashboard webview.
 *
 * Single-panel semantics: if a panel exists, reveal it; otherwise
 * create one. The dashboard content is intentionally a placeholder
 * for Milestone 1 — meaningful UI lands in M2+.
 */
function openDashboard(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): void {
	if (dashboardPanel) {
		dashboardPanel.reveal(vscode.ViewColumn.Active);
		output.appendLine('[sandboxDashboard] revealed existing panel');
		return;
	}

	dashboardPanel = vscode.window.createWebviewPanel(
		'sandboxDashboard',           // viewType — internal id
		'Sandbox Dashboard',          // title shown on tab
		vscode.ViewColumn.Active,
		{
			enableScripts: false,     // M1 has no JS — flip to true in M2 when buttons land
			retainContextWhenHidden: true, // preserve scroll/state when tab is hidden
		},
	);

	dashboardPanel.webview.html = renderPlaceholder();

	dashboardPanel.onDidDispose(
		() => {
			dashboardPanel = undefined;
			output.appendLine('[sandboxDashboard] panel disposed');
		},
		null,
		context.subscriptions,
	);

	output.appendLine('[sandboxDashboard] panel created');
}

/**
 * Milestone 1 placeholder content. Honest about its own state —
 * tells the user this is a scaffold and what's coming. Beats a
 * mysterious empty page that looks like something is broken.
 *
 * Styling uses VS Code's CSS variables so it adapts to whatever
 * theme the user has active. No external assets, no fonts — pure
 * inline HTML so the webview loads instantly with zero network.
 */
function renderPlaceholder(): string {
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src 'unsafe-inline';">
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
		h1 {
			margin: 0 0 0.5rem;
			font-size: 1.8rem;
			font-weight: 600;
		}
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
		ul {
			margin: 0.4rem 0 1rem;
			padding-left: 1.4rem;
		}
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
		<strong>This is the v0.1.0 scaffold.</strong> The infrastructure is in place
		— marketplace identity, command routing, container image pairing — and the
		dashboard buttons land in upcoming releases. If you're seeing this, the
		<code>sandbox-dashboard</code> extension is installed and activated correctly.
	</div>
</body>
</html>`;
}
