/**
 * Lifecycle actions — Import / Start / Save / Export.
 *
 * Each action is an async function with the signature:
 *     (context, output) => Promise<void>
 *
 * Actions are registered as VS Code commands in extension.ts so the
 * dashboard webview button, the command palette, and future keyboard
 * shortcuts all reach the same implementation.
 *
 * LAYOUT
 * ──────
 * This is the barrel. Each action lives in its own file once it grows
 * a real implementation; the barrel re-exports them so extension.ts
 * can `import { runX } from './actions'` without caring about the
 * per-file split.
 *
 * Stubs for actions that haven't landed yet live inline at the bottom
 * of this file — kept minimal so the file stays readable as each
 * action graduates to its own module.
 *
 * MILESTONE MAP
 * ─────────────
 *   M3.1: all four as stubs (shipped)
 *   M3.2: runExport moves to ./export.ts (THIS COMMIT)
 *   M3.3: runImport moves to ./import.ts
 *   M3.4: runStart moves to ./start.ts
 *   M3.5: runSave moves to ./save.ts (delegates to runExport for tarball)
 */

import * as vscode from 'vscode';

export { runExport } from './export';

// ─── Stubs for actions not yet implemented ──────────────────────────────────

/**
 * Import — load a previously-exported lab tarball into the workspace.
 * Real implementation lands in M3.3.
 */
export async function runImport(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: import (stub, coming in M3.3)');
    vscode.window.showInformationMessage('Import — coming in M3.3');
}

/**
 * Start — deploy the workspace's topology via `containerlab deploy`.
 * Real implementation lands in M3.4.
 */
export async function runStart(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: start (stub, coming in M3.4)');
    vscode.window.showInformationMessage('Start — coming in M3.4');
}

/**
 * Save — capture running configs via `containerlab save`, then bundle
 * the workspace as a tarball for download.
 * Real implementation lands in M3.5 and will delegate the tarball
 * portion to runExport's helpers.
 */
export async function runSave(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: save (stub, coming in M3.5)');
    vscode.window.showInformationMessage('Save — coming in M3.5');
}
