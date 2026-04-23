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

### Changed
- **Webview is now script-enabled under a strict Content Security
  Policy.** `enableScripts: true` with `default-src 'none'`,
  `style-src` allowing inline styles and the webview's own source,
  and `script-src` locked to a per-render nonce. External scripts,
  eval, and unnonced inline scripts are all blocked. This
  infrastructure lands now (without changing the visual surface)
  so M2.2 can push state updates without further CSP work.
- **Extension refactored into purpose-built modules.** `extension.ts`
  is now a lean glue module; `webview.ts` owns panel lifecycle, HTML
  rendering, and the message channel; `types.ts` is the shared type
  surface (state shapes + message protocol). Single-responsibility
  boundaries pay off starting in M2.2 when state computation lands.

### Internal
- Message protocol between extension and webview established with a
  `ready` handshake. The webview signals it's finished loading
  before the extension pushes state, avoiding races where an initial
  state push can be dropped by a still-booting webview. `postState`
  API stores the most-recent snapshot and replays on ready — callers
  never have to worry about timing.
- Per-render CSP nonce via `generateNonce()` helper (32 random
  alphanumerics), following VS Code webview guidance.

### Notes
- This is M2.1 of 4. The visible UI is still the placeholder — all
  changes in this release are infrastructure. State-driven rendering
  lands in M2.2.
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
