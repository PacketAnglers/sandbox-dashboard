# Sandbox Dashboard

VS Code extension that surfaces the lab lifecycle — **import, start, save, export** — for [aclabs](https://github.com/aristanetworks/acLabs) UCN Sandbox labs. Built so users can pick up where they left off without learning Git or wrangling the CLI.

Sister extension to [`packetanglers.lab-dashboard`](https://github.com/PacketAnglers/lab-dashboard), which serves the techlib labs. The two extensions deliberately do not share a codebase — sandbox is a stateful long-lived control plane, while lab-dashboard is a write-once status renderer. Different jobs, different tools.

## Status

**v0.4.3 — Topology View fix and concurrent-click defense.** Topology View now correctly anchors srl-labs' TopoViewer on the deployed lab's topology file. Concurrent button clicks are blocked at the system level — buttons grey out and show a "…" suffix while their action runs, and the underlying `trackedCommand` wrapper catches palette/keybinding races too. User-validated against real lab workflows.

| Milestone | Status | What's in it |
|-----------|--------|--------------|
| **M1** | ✅ Shipped | Marketplace identity, command routing, status bar button, container image pairing, publish pipeline |
| **M2** | ✅ Shipped | Auto-open on first activation, workspace status, topology detection, containerlab inspection, live reactivity, display polish |
| **M3** | ✅ Shipped | The four buttons: Import / Start / Save / Export; preconditional enablement; build-time webview syntax guardrail |
| **M4** | ✅ Shipped | Stop button (with optional save-first); Import gains a GitHub clone path alongside tarball upload |
| M5 | Planned | Webview-hosted upload/download (so Import/Export interact with the user's local machine, not the container's filesystem) |
| M6 | Planned | Per-lab readiness signal (container-state-based) |

### M4 recap

1. **M4.0 — Stop action.** Fifth button (🛑) with three-option modal (Cancel / Save and Stop / Stop without Saving). Under the hood: `sudo -n containerlab destroy --cleanup -t <topology>`. UI vocabulary is "Stop" not "Destroy" — topology and saved configs survive, so a subsequent Start is fully resumable. Refactored Save to share lab-inspection logic via new `src/actions/_helpers.ts`.
2. **M4.1 — GitHub clone for Import.** Import opens with a QuickPick: 📁 Upload File or 🐙 Clone from GitHub. GitHub path includes empty-workspace fast path, destructive-confirm modal for non-empty workspaces, `git clone --progress` with line-streamed progress, 30s "still working" hint, 5-min hard timeout, and trusts code-server to handle GitHub auth.

## What the dashboard shows (v0.4.3)

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
| `Sandbox Dashboard: Import Lab from Tarball` | Pick how to import — upload a `.tar.gz` or clone from GitHub. The "Import" name is preserved even though M4.1 added a clone path. |
| `Sandbox Dashboard: Start Lab` | Deploy a `*.clab.yml` via `containerlab deploy`. Picker appears if multiple topologies exist. |
| `Sandbox Dashboard: Stop Lab` | Tear down a deployed lab via `containerlab destroy --cleanup`. Three-option modal: Cancel / Save and Stop / Stop without Saving. |
| `Sandbox Dashboard: Save Lab (Capture Configs + Export)` | Run `containerlab save` on a deployed lab, then bundle the workspace as a tarball. |
| `Sandbox Dashboard: Export Workspace as Tarball` | Bundle the workspace as a `.tar.gz` without touching running state. |
| `Sandbox Dashboard: Open Topology View` | Dispatches to `srl-labs.vscode-containerlab`'s TopoViewer for a graphical view of the running lab. Uses dynamic command lookup — resilient to future command-ID renames. |
| `Sandbox Dashboard: Set Up Git for Committing` | Prompt for `user.name` and `user.email`, then run `git config --global` for both. Idempotent — confirms and exits if already set. Auto-triggers from Clone-from-GitHub and from extension activation when a `.git` directory is detected without identity configured. |

All actions are also reachable via the five buttons at the top of the dashboard; the command palette entries exist so keyboard-driven workflows work too.

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
    index.ts          barrel re-exporting the action runners
    _helpers.ts       shared inspectDeployedLabs + RunningLab (used by Save, Stop)
    export.ts         Export + shared tar helper (runTar, timestamp, excludes)
    import.ts         Import router (tarball method + GitHub clone method)
    start.ts          Start with topology picker + progress streaming
    stop.ts           Stop with three-option modal + optional save-first
    save.ts           Save (containerlab save + tarball, reuses runTar)
scripts/
  check-webview-script.js   build-time JS-syntax guardrail on emitted webview script
```

The webview is a pure renderer. The extension host computes authoritative state and pushes it as `{ type: 'state', payload }` messages; the webview reflects what it was told. Button clicks flow the reverse direction as `{ type: 'action', payload: { kind } }` messages, which the extension dispatcher translates to `sandboxDashboard.<kind>` VS Code commands. State channel and action channel are independent — actions run while the observer keeps the display honest.

## Building from source

```bash
npm install
npm run bundle
npx vsce package --no-dependencies
# produces sandbox-dashboard-<version>.vsix
```

## License

MIT
