# Sandbox Dashboard

VS Code extension that surfaces the lab lifecycle — **import, start, save, export** — for [aclabs](https://github.com/aristanetworks/acLabs) UCN Sandbox labs. Built so users can pick up where they left off without learning Git or wrangling the CLI.

Sister extension to [`packetanglers.lab-dashboard`](https://github.com/PacketAnglers/lab-dashboard), which serves the techlib labs. The two extensions deliberately do not share a codebase — sandbox is a stateful long-lived control plane, while lab-dashboard is a write-once status renderer. Different jobs, different tools.

## Status

**v0.3.0 — the four buttons.** The dashboard is now a full lifecycle control plane for UCN Sandbox labs. Observe the workspace, deploy topologies, capture running configs, export tarballs, import lab bundles — all without leaving the IDE.

| Milestone | Status | What's in it |
|-----------|--------|--------------|
| **M1** | ✅ Shipped | Marketplace identity, command routing, status bar button, container image pairing, publish pipeline |
| **M2** | ✅ Shipped | Auto-open on first activation, workspace status, topology detection, containerlab inspection, live reactivity, display polish |
| **M3** | ✅ Shipped | The four buttons: Import / Start / Save / Export; preconditional enablement; build-time webview syntax guardrail |
| M4 | Planned | Destroy action, confirmation flows, richer error handling |

### M3 recap

1. **M3.0** — build-time syntax check on the emitted webview script. `scripts/check-webview-script.js` runs after every bundle, loads the bundled extension with a mock `vscode`, captures the HTML emitted by `DashboardPanel.buildHtml()`, extracts the inline `<script>` body, and runs `node --check` on it. Catches runtime-visible JS syntax errors at build time. Combined with `tsc --noEmit`, both TypeScript-level and emitted-JS-level syntax issues are caught before shipping.
2. **M3.1** — action message plumbing. Webview buttons send `{type:'action', payload:{kind}}` messages; the extension dispatcher translates to `sandboxDashboard.<kind>` VS Code commands. Same dispatch path used by command palette entries, so actions are reachable from buttons, keybindings, and the palette uniformly.
3. **M3.2** — Export. `tar -czf` with opinionated exclusions (`.git`, `node_modules`, `clab-*`). Default filename `<workspace-name>-YYYY-MM-DD-HHMM.tar.gz` in `$HOME`.
4. **M3.3** — Import. `tar -tzf` for collision detection; modal confirmation listing conflicts (first 5 verbatim, overflow summarized); `tar -xzf -C <workspaceRoot>` to extract. File watchers pick up new topologies automatically.
5. **M3.4** — Start. `sudo -n containerlab deploy -t <topology>` with line-streamed progress notification ("Creating container clab-foo-bar", etc.). Topology QuickPick when multiple `*.clab.yml` files exist. Triggers `sandboxDashboard.refresh` on success so the new lab surfaces within ~1 second instead of waiting up to 30s for the poll tick.
6. **M3.5** — Save. Two-phase: `sudo -n containerlab save` first (writes configs into `clab-*/<nodename>/`), then bundles with a shorter exclude list that keeps those directories. Partial-success path: if configs capture cleanly but the user cancels the save dialog, we toast "Configs captured; tarball skipped — you can Export anytime" instead of treating it as a failure.

All privileged containerlab calls use `sudo -n` (non-interactive). An unconfigured NOPASSWD sudo fails fast with a clear diagnostic instead of hanging forever on a password prompt the webview can't service.

## What the dashboard shows (v0.3.0)

Open a sandbox lab workspace and the dashboard auto-opens with three live sections:

- **Workspace** — the absolute path to the folder you're working in.
- **Topologies** — every `*.clab.yml` / `*.clab.yaml` file in the workspace, grouped by subdirectory for quick scanning. Updates within ~300ms of any file create / change / delete.
- **ContainerLab** — whether the CLI is available, how many labs are currently deployed (with node counts), the topology each deployed lab came from, and when the status was last checked. Refreshes every 30 seconds while the dashboard is open.

Errors that happen inside a specific section (e.g. `containerlab inspect` returning an unrecognized JSON shape) render inline with that section. Unexpected failures that disrupt the whole compute surface as a prominent top-of-page banner, which clears automatically once state recovers.

## How the reactivity works

Four cooperating mechanisms keep the display honest:

1. **File watchers** on both topology extensions catch creates, changes, and deletes across the whole workspace (respecting the user's `files.exclude` settings).
2. **ContainerLab polling** runs a 30-second loop while the dashboard is open — deploy a lab via terminal and the dashboard reflects it within half a minute. Polling pauses when the dashboard is closed to avoid wasted CPU.
3. **Debouncing** coalesces rapid-fire events (editors often emit multiple events per save) into a single recompute via a 300ms window.
4. **Latest-wins race safety** via a monotonic token — if a fast compute starts while a slow one is in flight, the slow result gets dropped when it resolves so stale state never overwrites fresh state.

## Installation

The extension installs automatically inside the `lab-base-sandbox` container image. There is no end-user install step — launch a UCN Sandbox lab and the dashboard opens via the `$(beaker) Sandbox Dashboard` button in the status bar.

For development or out-of-lab use, install from the published `.vsix` on the [GitHub Releases page](https://github.com/PacketAnglers/sandbox-dashboard/releases) or from [Open VSX](https://open-vsx.org/extension/packetanglers/sandbox-dashboard).

## Commands

| Command | Description |
|---------|-------------|
| `Sandbox Dashboard: Open` | Open or focus the dashboard webview. |
| `Sandbox Dashboard: Refresh` | Force an immediate state recompute without waiting for the 30s poll tick. |
| `Sandbox Dashboard: Import Lab from Tarball` | Pick a `.tar.gz` and extract it into the current workspace (with collision confirmation). |
| `Sandbox Dashboard: Start Lab` | Deploy a `*.clab.yml` via `containerlab deploy`. Picker appears if multiple topologies exist. |
| `Sandbox Dashboard: Save Lab (Capture Configs + Export)` | Run `containerlab save` on a deployed lab, then bundle the workspace as a tarball. |
| `Sandbox Dashboard: Export Workspace as Tarball` | Bundle the workspace as a `.tar.gz` without touching running state. |

All actions are also reachable via the four buttons at the top of the dashboard; the command palette entries exist so keyboard-driven workflows work too.

## Architecture

```
src/
  extension.ts        glue — activation, status bar, commands, auto-open policy
  webview.ts          panel lifecycle, HTML, CSP, message protocol, button UI
  refresher.ts        reactivity engine (watchers, polling, debounce, race safety)
  state.ts            workspace state computation
  containerlab.ts     CLI wrapper (defensive JSON parsing)
  types.ts            shared types (state + messages + ActionKind)
  actions/
    index.ts          barrel re-exporting the four action runners
    export.ts         Export + shared tar helper (runTar, timestamp, excludes)
    import.ts         Import with collision detection
    start.ts          Start with topology picker + progress streaming
    save.ts           Save (containerlab save + tarball, reuses runTar)
scripts/
  check-webview-script.js   build-time JS-syntax guardrail on emitted webview script
```

The webview is a pure renderer. The extension host computes authoritative state and pushes it as `{ type: 'state', payload }` messages; the webview reflects what it was told. Button clicks flow the reverse direction as `{ type: 'action', payload: { kind } }` messages, which the extension dispatcher translates to `sandboxDashboard.<kind>` VS Code commands. State channel and action channel are independent — actions run while M2's observer keeps the display honest.

## Building from source

```bash
npm install
npm run bundle
npx vsce package --no-dependencies
# produces sandbox-dashboard-<version>.vsix
```

## License

MIT
