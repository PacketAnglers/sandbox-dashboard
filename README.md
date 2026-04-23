# Sandbox Dashboard

VS Code extension that surfaces the lab lifecycle — **import, start, save, export** — for [aclabs](https://github.com/aristanetworks/acLabs) UCN Sandbox labs. Built so users can pick up where they left off without learning Git or wrangling the CLI.

Sister extension to [`packetanglers.lab-dashboard`](https://github.com/PacketAnglers/lab-dashboard), which serves the techlib labs. The two extensions deliberately do not share a codebase — sandbox is a stateful long-lived control plane, while lab-dashboard is a write-once status renderer. Different jobs, different tools.

## Status

**v0.1.0 — scaffold release.** The infrastructure is in place; the buttons land in upcoming milestones.

| Milestone | Status | What's in it |
|-----------|--------|--------------|
| **M1** | ✅ Shipped | Marketplace identity, command routing, status bar button, container image pairing, publish pipeline |
| M2 | Planned | Workspace status + topology detection |
| M3 | Planned | The four buttons: Import / Start / Save / Export |
| M4 | Planned | Polish, confirmations, error handling |

## Installation

The extension installs automatically inside the `lab-base-sandbox` container image. There is no end-user install step — launch a UCN Sandbox lab and the dashboard opens via the `$(beaker) Sandbox Dashboard` button in the status bar.

For development, install from the published `.vsix` on the [GitHub Releases page](https://github.com/PacketAnglers/sandbox-dashboard/releases) or from [Open VSX](https://open-vsx.org/extension/packetanglers/sandbox-dashboard).

## Commands

| Command | Description |
|---------|-------------|
| `Sandbox Dashboard: Open` | Open or focus the dashboard webview. |

(More commands land in Milestone 3 alongside the dashboard buttons.)

## Building from source

```bash
npm install
npm run bundle
npx vsce package --no-dependencies
# produces sandbox-dashboard-<version>.vsix
```

## License

MIT
