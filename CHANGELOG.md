# Changelog

All notable changes to the **Sandbox Dashboard** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-23

### Added
- **Auto-open on first activation per workspace.** The dashboard now
  opens automatically the first time this extension activates in a
  given workspace, using `context.workspaceState` to remember the
  invitation has been extended. Subsequent activations respect the
  user's last decision — if they closed it, we stay closed until
  they click the status bar button again. Tracked per-workspace, so
  a new lab directory always gets a fresh invitation.
- **Live workspace awareness (M2.2).** The dashboard now shows:
  - **Workspace root** — where you are
  - **Topology files** — every `*.clab.yml` / `*.clab.yaml` in the
    workspace, discovered via `vscode.workspace.findFiles` so the
    user's `files.exclude` settings are honored
  - **ContainerLab status** — whether the CLI is available, how
    many labs are currently deployed (via `containerlab inspect
    --all --format json`), and when the status was last checked
  State is computed once on activation or command invocation; M2.3
  adds file-watcher + polling reactivity.

### Changed
- **Webview is now script-enabled under a strict Content Security
  Policy.** `enableScripts: true` with `default-src 'none'`,
  `style-src` allowing inline styles and the webview's own source,
  and `script-src` locked to a per-render nonce. External scripts,
  eval, and unnonced inline scripts are all blocked.
- **Extension refactored into purpose-built modules.** `extension.ts`
  is now a lean glue module; `webview.ts` owns panel lifecycle, HTML
  rendering, and the message channel; `types.ts` is the shared type
  surface; `state.ts` computes workspace state; `containerlab.ts`
  wraps CLI inspection.

### Internal
- Message protocol between extension and webview established with a
  `ready` handshake. The webview signals it's finished loading
  before the extension pushes state, avoiding races where an initial
  state push can be dropped by a still-booting webview. `postState`
  API stores the most-recent snapshot and replays on ready — callers
  never have to worry about timing.
- Per-render CSP nonce via `generateNonce()` helper (32 random
  alphanumerics), following VS Code webview guidance.
- Defensive JSON parsing for `containerlab inspect` output —
  tolerates both legacy (top-level array) and current (containers
  array) shapes, gracefully handles "no labs deployed" non-zero
  exits, and surfaces genuinely unexpected failures through the
  state's `error` field rather than crashing.
- All user-controlled string values (workspace paths, topology paths,
  lab names) HTML-escaped before DOM insertion in the webview.

### Notes
- The visible UI now shows real state. Buttons (Import / Start /
  Save / Export) still land in Milestone 3. Reactivity — watching
  for topology file changes, polling containerlab status — lands in
  M2.3.
- Pairs with `lab-base-sandbox` 1.0.1 (to be cut at end of M2).



### Added
- **Milestone 1 scaffold.** Establishes the marketplace identity
  (`packetanglers.sandbox-dashboard`), command namespace
  (`sandboxDashboard.*`), build/publish pipeline (Open VSX), and
  paired container image (`lab-base-sandbox`).
- Permanent **status bar button** (`$(beaker) Sandbox Dashboard`) that
  opens the dashboard webview from anywhere with one click.
- Single command `sandboxDashboard.open` that opens (or focuses) a
  placeholder webview describing what's coming in upcoming milestones.

### CI
- Release workflow pre-flights `OPEN_VSX_TOKEN` presence on tag builds
  and fails loudly with a clear remediation message if the secret is
  missing — catches misconfig before time is spent building/packaging.
  Previously a missing token would silently skip publish, making the
  tag look "green" while nothing landed on Open VSX.

### Notes
- This is a scaffold release. No functional buttons, no workspace
  scanning, no lab operations — those land in Milestones 2-4. The
  v0.1.0 release exists to validate the publish pipeline and container
  pairing on a tiny surface before building the real feature on top.
- Pairs with `lab-base-sandbox` 1.0.0+ (the new container image
  family for sandbox labs).
