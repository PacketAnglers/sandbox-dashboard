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
 * This is the barrel. Each action lives in its own file under
 * src/actions/; the barrel re-exports so extension.ts can
 * `import { runX } from './actions'` without caring about the split.
 *
 * MILESTONE MAP (all shipped as of v0.3.0)
 * ──────────────
 *   M3.1: all four as stubs
 *   M3.2: runExport → ./export.ts
 *   M3.3: runImport → ./import.ts
 *   M3.4: runStart  → ./start.ts
 *   M3.5: runSave   → ./save.ts   (reuses runTar from ./export)
 *
 * Shared helpers (tarball exec, timestamp, default dir) live in
 * ./export.ts and are exported for reuse by ./save.ts. This avoids
 * a separate "utils" file for code that would otherwise have one
 * caller besides its own.
 */

export { runExport } from './export';
export { runImport } from './import';
export { runStart } from './start';
export { runSave } from './save';
