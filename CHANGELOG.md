# Changelog

All notable changes to the **Sandbox Dashboard** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-04-23

### Fixed
- **Webview script no longer silently fails to run in 0.2.0.** The
  cross-platform path-splitting logic in the topology-grouping
  renderer contained a malformed string literal (`'\'` — a single
  backslash inside single quotes, which JS treats as an escaped
  closing quote, making the string unterminated and throwing a
  SyntaxError). Because the whole script block is parsed as one
  unit, the syntax error killed the entire webview script,
  including the `ready` handshake the extension waits for before
  pushing state. The symptom was "Computing…" in every section
  forever — the extension happily computed and queued state, but
  the webview never signaled it was ready to receive it.
- Root cause: my own over-zealous backslash-escape "fix" during
  M2.4 polish. Caught by the end-to-end smoke test when the
  sandbox-dashboard 0.2.0 container landed in a real lab. Fixed
  and verified by extracting the emitted HTML from the bundle and
  running `node --check` on the script body — the same validation
  step that will now be a permanent part of the bundle sanity
  check for future releases.

### Lessons
- Template-literal-inside-JS-string escape counting is easy to get
  wrong. The rule: to emit one literal `\` in the webview JS
  string, source needs 4 backslash characters (2 for the template
  literal level → emits 2 for the JS string-literal level → runtime
  value is 1).
- Trust `node --check` over mental model. Adding a pre-commit
  syntax check on the emitted webview script is on the M3 backlog.



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
- **Reactive state updates (M2.3).** The dashboard now stays fresh
  without user intervention:
  - **File watchers** on `*.clab.yml` / `*.clab.yaml` — create,
    change, and delete events trigger a recompute. A new topology
    file appears in the dashboard within ~300ms of being saved.
  - **ContainerLab polling** every 30 seconds while the dashboard
    is open. Deploy a lab via terminal and the dashboard reflects
    it within half a minute. Polling pauses when the dashboard is
    closed to avoid wasted CPU.
  - **Debouncing** coalesces rapid-fire file-system events (editors
    often emit 3-5 events per save) into a single recompute via a
    300ms window.
  - **Latest-wins race safety** via a monotonic token — if a fast
    compute starts while a slow compute is in flight, the slow
    result gets dropped when it resolves so stale state never
    overwrites fresh state.
- **Display polish (M2.4):**
  - **Topologies grouped by subdirectory.** A workspace with
    `sandbox-template/topology.clab.yml` and `extra-lab/topology.clab.yml`
    now shows two labeled folder groups (📁 sandbox-template, 📁
    extra-lab) instead of a flat list. Root-level files appear
    first, un-indented.
  - **Welcoming empty states.** "No topology found" / "No labs
    running" / "containerlab CLI not detected" each now include a
    helpful next-step hint rather than a terse shrug.
  - **Live-updating timestamps.** "Last checked: 12s ago" counts up
    smoothly via a 5-second webview-side refresh interval, even when
    the underlying state hasn't changed.
  - **Running-lab indicator.** A small green dot next to each
    deployed lab's name. Inherits theme colors so it respects
    high-contrast modes.
  - **Prominent error banner** for truly-unexpected compute
    failures. State-level errors (containerlab inspect failing,
    unrecognized JSON shape) continue to render inline in their
    section; the banner is reserved for the "something really
    broke" case. Clears automatically when state recovers.

### Changed
- **Webview is now script-enabled under a strict Content Security
  Policy.** `enableScripts: true` with `default-src 'none'`,
  `style-src` allowing inline styles and the webview's own source,
  and `script-src` locked to a per-render nonce. External scripts,
  eval, and unnonced inline scripts are all blocked.
- **Extension refactored into purpose-built modules.** `extension.ts`
  is lean glue; `webview.ts` owns panel lifecycle, HTML rendering,
  and the message channel; `types.ts` is the shared type surface;
  `state.ts` computes workspace state; `containerlab.ts` wraps CLI
  inspection; `refresher.ts` is the reactivity engine (watchers,
  polling, debounce, race-safety).

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
- `DashboardPanel` accepts `onReady` and `onDispose` callbacks via an
  options object, letting cross-module concerns (like the refresher's
  poll lifecycle) hook in without coupling the webview module to them.
- `DashboardPanel.postError(message)` pushes an ephemeral error banner
  to the webview (distinct from state-level errors which render
  inline). A subsequent successful `postState` clears the banner
  automatically.

### Notes
- Buttons (Import / Start / Save / Export) still land in Milestone 3.
  M2 builds the *observation* layer that M3's *action* layer will
  build on top of.
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
