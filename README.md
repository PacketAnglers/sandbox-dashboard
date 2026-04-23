# Sandbox Dashboard

VS Code extension that surfaces the lab lifecycle — **import, start, save, export** — for [aclabs](https://github.com/aristanetworks/acLabs) UCN Sandbox labs. Built so users can pick up where they left off without learning Git or wrangling the CLI.

Sister extension to [`packetanglers.lab-dashboard`](https://github.com/PacketAnglers/lab-dashboard), which serves the techlib labs. The two extensions deliberately do not share a codebase — sandbox is a stateful long-lived control plane, while lab-dashboard is a write-once status renderer. Different jobs, different tools.

## Status

**v0.2.0 — live workspace awareness.** The dashboard now observes the workspace in real time. Lifecycle buttons land in Milestone 3.

| Milestone | Status | What's in it |
|-----------|--------|--------------|
| **M1** | ✅ Shipped | Marketplace identity, command routing, status bar button, container image pairing, publish pipeline |
| **M2** | ✅ Shipped | Auto-open on first activation, workspace status, topology detection, containerlab inspection, live reactivity, display polish |
| M3 | Planned | The four buttons: Import / Start / Save / Export |
| M4 | Planned | Polish, confirmations, richer error handling |

## What the dashboard shows (v0.2.0)

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

(More commands land in Milestone 3 alongside the dashboard buttons.)

## Architecture

```
src/
  extension.ts     glue — activation, status bar, commands, auto-open policy
  webview.ts       panel lifecycle, HTML, CSP, message protocol
  refresher.ts     reactivity engine (watchers, polling, debounce, race safety)
  state.ts         workspace state computation
  containerlab.ts  CLI wrapper (defensive JSON parsing)
  types.ts         shared types (state + messages)
```

The webview is a pure renderer. The extension host computes authoritative state and pushes it as `{ type: 'state', payload }` messages; the webview just reflects what it was told. This pattern scales cleanly — M3's buttons will flow the other direction as `{ type: 'action', payload }` messages without changing the state channel.

## Building from source

```bash
npm install
npm run bundle
npx vsce package --no-dependencies
# produces sandbox-dashboard-<version>.vsix
```

## License

MIT
