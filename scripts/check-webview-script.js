#!/usr/bin/env node
/**
 * check-webview-script.js
 *
 * Runs after `npm run bundle` to validate that the inline JavaScript
 * emitted into the dashboard webview is syntactically valid.
 *
 * WHY THIS EXISTS
 * ───────────────
 * sandbox-dashboard 0.2.0 shipped with a malformed string literal
 * inside the webview's inline <script> block — an escape-counting
 * mistake I made three layers deep (TypeScript source → template
 * literal emission → runtime JS literal). tsc saw the TypeScript
 * and said "fine." esbuild bundled the JS and said "fine." Neither
 * parses the CONTENTS of string literals, so both were correct —
 * from their perspective — to green-light a release that produced
 * a SyntaxError at the first byte of user-facing behavior.
 *
 * Only catching mechanism: a JS parser running over the actual
 * emitted script body. That's what this script does.
 *
 * HOW IT WORKS
 * ────────────
 * 1. Load the bundled extension (out/extension.js) with a mock
 *    `vscode` module so its top-level `require('vscode')` works.
 * 2. Stub enough of the VS Code API surface that `activate()` runs
 *    without crashing, and the auto-open path causes buildHtml()
 *    to fire — writing HTML into our fake webview.
 * 3. Extract the <script nonce=...>...</script> body from the HTML.
 * 4. Run `node --check` on a temp file containing that body.
 * 5. Exit 0 on success, non-zero with a clear message on failure.
 *
 * Wired into `npm run bundle` as a post-step so every bundle either
 * ships with a valid webview script or fails loudly at build time.
 * Mirrors the OPEN_VSX_TOKEN pre-flight pattern: turn silent-in-
 * prod bugs into loud-at-build errors.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const BUNDLE_PATH = path.resolve(__dirname, '..', 'out', 'extension.js');

function fail(msg) {
    console.error('[check-webview-script] ✗ ' + msg);
    process.exit(1);
}

if (!fs.existsSync(BUNDLE_PATH)) {
    fail(`bundle not found at ${BUNDLE_PATH} — run npm run bundle first`);
}

// ─── Mock the `vscode` module ───────────────────────────────────────────────
//
// The bundle's require('vscode') must succeed. We return a stub object with
// just enough API surface for activate() → showDashboard() → new DashboardPanel()
// → buildHtml() to reach the HTML-emission step without crashing.
//
// Anything the bundle touches but we don't care about (commands.registerCommand,
// createStatusBarItem, createFileSystemWatcher, etc.) returns a no-op stub.

let capturedHtml = '';
let registeredOpenCmd;

const mockVsCode = {
    window: {
        createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
        createStatusBarItem: () => ({
            text: '', tooltip: '', command: '',
            show: () => {}, hide: () => {}, dispose: () => {},
        }),
        createWebviewPanel: () => ({
            webview: {
                cspSource: 'https://test.webview.source',
                _html: '',
                set html(v) { this._html = v; capturedHtml = v; },
                get html() { return this._html; },
                onDidReceiveMessage: () => ({ dispose: () => {} }),
                postMessage: () => {},
            },
            onDidDispose: () => ({ dispose: () => {} }),
            reveal: () => {},
            dispose: () => {},
        }),
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: '/fake/workspace' } }],
        createFileSystemWatcher: () => ({
            onDidCreate: () => ({ dispose: () => {} }),
            onDidChange: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
        }),
        findFiles: async () => [],
    },
    commands: {
        registerCommand: (name, cb) => {
            if (name === 'sandboxDashboard.open') registeredOpenCmd = cb;
            return { dispose: () => {} };
        },
        executeCommand: async () => {},
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Uri: { file: (p) => ({ fsPath: p, path: p }) },
};

// Intercept require('vscode') — the bundle's `require('vscode')` resolves
// through Node's require system, so we need to hook it at the module-resolve
// level, not just in require.cache.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return 'vscode';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: mockVsCode,
    children: [],
    paths: [],
};

// ─── Load the bundle and trigger buildHtml ──────────────────────────────────

let ext;
try {
    ext = require(BUNDLE_PATH);
} catch (err) {
    fail(`failed to load bundle: ${err.message}`);
}

const fakeContext = {
    subscriptions: [],
    workspaceState: {
        get: () => false, // pretend auto-open hasn't happened yet
        update: async () => {},
    },
    globalState: {
        get: () => undefined,
        update: async () => {},
    },
};

try {
    ext.activate(fakeContext);
} catch (err) {
    fail(`activate() threw: ${err.message}`);
}

// activate() either auto-opens (if workspaceState.get returned falsy — we made
// it) or registers the open command. In both paths, one way or another the
// webview HTML should have been produced. If we didn't capture HTML from the
// auto-open path, invoke the open command explicitly.
if (!capturedHtml && registeredOpenCmd) {
    try {
        registeredOpenCmd();
    } catch (err) {
        fail(`open command threw: ${err.message}`);
    }
}

if (!capturedHtml) {
    fail('no HTML was emitted — activate() did not create a webview panel');
}

// ─── Extract and syntax-check the <script> body ─────────────────────────────

const scriptMatch = capturedHtml.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
    fail('no <script> tag found in emitted webview HTML');
}
const scriptBody = scriptMatch[1];

const tmpFile = path.join(os.tmpdir(), `sandbox-dashboard-webview-${process.pid}.js`);
fs.writeFileSync(tmpFile, scriptBody);

try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    console.log(`[check-webview-script] ✓ webview script syntax OK (${scriptBody.length} chars)`);
} catch (err) {
    // node --check writes its error to stderr
    const stderr = err.stderr ? err.stderr.toString() : '';
    console.error('[check-webview-script] ✗ webview script has a JS syntax error:');
    console.error(stderr);
    console.error(`[check-webview-script] (failing script saved to ${tmpFile} for inspection)`);
    process.exit(1);
} finally {
    // Only clean up on success — on failure we leave the temp file so the
    // developer can inspect it. The path is printed above.
    if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch {} // ignore — best-effort cleanup
    }
}
