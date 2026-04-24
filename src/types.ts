/**
 * Shared types for the sandbox-dashboard extension.
 *
 * This module is the single source of truth for:
 *   1. The `WorkspaceState` shape — what the dashboard knows about
 *      the user's workspace at any given moment.
 *   2. The message protocol between the extension host (TypeScript
 *      running in Node) and the webview (HTML/JS running in a
 *      sandboxed iframe).
 *
 * Keeping these in one file means a state field renamed once is a
 * rename once — type-checked across the entire extension surface.
 */

// ─── WorkspaceState ─────────────────────────────────────────────────────────

/**
 * A single *.clab.yml file found in the workspace.
 *
 * `depth` is precomputed server-side so the webview renderer can
 * group / indent without re-walking path strings. The webview is a
 * pure renderer — all computation lives extension-side.
 */
export interface TopologyFile {
    /** Absolute path on disk. */
    path: string;
    /** Relative to workspace root, for display. */
    relativePath: string;
    /** Basename (filename only), for quick-scan columns. */
    name: string;
    /** Number of path segments below workspace root (0 = root-level). */
    depth: number;
}

/**
 * A lab currently deployed by containerlab.
 *
 * We deliberately don't track per-node state in M2 — aggregate
 * `nodeCount` answers "is anything running?" which is all M2 needs.
 * Per-node detail lands in M3+ when the Start button appears and
 * users care about individual reachability.
 *
 * `topologyPath` is the bridge that will let M3 correlate a deployed
 * lab with a workspace topology file ("is my .clab.yml the one
 * that's running right now?").
 */
export interface DeployedLab {
    name: string;
    topologyPath: string;
    nodeCount: number;
}

export interface ContainerlabStatus {
    /** Is the `containerlab` CLI installed and callable? */
    available: boolean;
    /** Labs returned by `containerlab inspect --all` — usually 0 or 1. */
    deployedLabs: DeployedLab[];
    /** Epoch ms when the status was last computed. Powers "checked Ns ago" UX. */
    lastCheckedAt: number;
    /** If the inspect call failed, the error message for display. */
    error?: string;
}

export interface WorkspaceState {
    /** Absolute path to the workspace root, or null if no folder open. */
    workspaceRoot: string | null;
    /** All *.clab.yml files discovered in the workspace. */
    topologies: TopologyFile[];
    /** Containerlab runtime status. */
    containerlab: ContainerlabStatus;
    /** Epoch ms when the full state snapshot was computed. */
    computedAt: number;
}

// ─── Message Protocol ───────────────────────────────────────────────────────

/**
 * Messages sent FROM the extension host TO the webview.
 *
 * The webview is a pure renderer: it receives `state` messages and
 * updates the DOM to match. No computation, no fetching.
 */
export type ExtensionMessage =
    | { type: 'state'; payload: WorkspaceState }
    | { type: 'error'; payload: { message: string } };

/**
 * The four lifecycle actions the user can invoke from the dashboard.
 *
 * Implementations live in src/actions/{kind}.ts and are registered as
 * VS Code commands (sandboxDashboard.<kind>) so they're also reachable
 * from the command palette and keybindings — the webview button is
 * one dispatch path, not the only one.
 */
export type ActionKind = 'import' | 'start' | 'stop' | 'save' | 'export';

/**
 * Messages sent FROM the webview TO the extension host.
 *
 * `ready` is the boot-time handshake (webview signals it's loaded).
 *
 * `action` carries a user-initiated lifecycle request. The extension
 * host's dispatcher translates these to `vscode.commands.executeCommand
 * (sandboxDashboard.<kind>)` so the same action can be reached from
 * the status bar, keyboard shortcuts, or other UI surfaces later.
 */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'action'; payload: { kind: ActionKind } };
