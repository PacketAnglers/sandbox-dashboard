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
 * M3.1 SCOPE
 * ──────────
 * All four actions are stubs that log to the output channel. This
 * proves the end-to-end dispatch works (webview button click →
 * action message → command execution → log line) BEFORE any of
 * the actions touch the filesystem or spawn processes. Buttons
 * visibly fire; nothing destructive happens.
 *
 * Subsequent milestones fill in real implementations:
 *   M3.2 → runExport  (simplest, no state dependencies)
 *   M3.3 → runImport  (inverse of Export)
 *   M3.4 → runStart   (most complex — process spawn, progress UI)
 *   M3.5 → runSave    (runExport + `containerlab save` prelude)
 */

import * as vscode from 'vscode';

/**
 * Export — bundle the current workspace as a tarball for download.
 */
export async function runExport(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: export (M3.1 stub)');
    vscode.window.showInformationMessage('Export — coming in M3.2');
}

/**
 * Import — load a previously-exported lab tarball into the workspace.
 */
export async function runImport(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: import (M3.1 stub)');
    vscode.window.showInformationMessage('Import — coming in M3.3');
}

/**
 * Start — deploy the workspace's topology via `containerlab deploy`.
 */
export async function runStart(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: start (M3.1 stub)');
    vscode.window.showInformationMessage('Start — coming in M3.4');
}

/**
 * Save — capture running configs via `containerlab save`, then bundle
 * the workspace as a tarball for download.
 */
export async function runSave(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: save (M3.1 stub)');
    vscode.window.showInformationMessage('Save — coming in M3.5');
}
