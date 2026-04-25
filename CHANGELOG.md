# Changelog

All notable changes to the **Sandbox Dashboard** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4] - 2026-04-25

Fourth patch of the v0.4.x user-feedback cycle. v0.4.3's TopoViewer
"fix" only worked for labs whose topology files matched the
`*.clab.yml` convention — a constraint we didn't know about until
v0.4.3 smoke testing forced us to investigate.

### The story
v0.4.3 shipped an editor pre-open intended to fix Topology View
against the deployed lab. Smoke testing surfaced that the fix
didn't actually work for the user's lab — a repo whose topology
file was named `lab.yml` (no `.clab.` prefix). Renaming to
`topology.clab.yml` made it work.

Root cause: `srl-labs.vscode-containerlab`'s tree view discovers
labs via files matching `*.clab.yml` / `*.clab.yaml`. Their
TopoViewer command operates on tree-view nodes (with active-editor
fallback that ALSO requires the file to be in their tree). Labs
deployed from non-conforming filenames are invisible to their
ecosystem entirely.

This is structural, not a bug we can patch. v0.4.2's Start fallback
picker (which lets users deploy any topology file regardless of
naming) inadvertently created a class of users srl-labs can't serve.

### Added
- **Ecosystem-compatibility rename gate at Start time.** When a user
  starts a lab whose topology file doesn't match `*.clab.yml`, a
  three-button modal appears BEFORE deploy:
  1. **Rename and Start** — `fs.rename` to `<stem>.clab.yml` (or
     `.clab.yaml` if the source was `.yaml`), update remembered
     topology, deploy. Collision-detected: if `<stem>.clab.yml`
     already exists, a follow-up "delete existing & rename / cancel"
     prompt prevents silent overwrite.
  2. **Start without Renaming** — deploy with the original filename.
     The deployed lab will be marked `topologyMatchesConvention:
     false` in state, and Topology View will be disabled per-lab.
  3. **Cancel** — don't deploy at all.

  Renaming BEFORE deploy is the only sane time to do it: rename-
  after-deploy creates broken state because containerlab's metadata
  is stamped with the original filename.

  The prompt explicitly mentions the workspace-modification effect
  for git-tracked files so users can make an informed choice.

- **`DeployedLab.topologyMatchesConvention: boolean`** field
  populated in `src/containerlab.ts` from the inspect output. Single
  regex `/\.clab\.ya?ml$/i` defines conformance; the same regex
  triggers the rename gate in `src/actions/start.ts` (DRY: one
  source of truth for "what counts as conforming").

- **Per-lab Topology View enablement** in the dashboard. The button
  now requires a deployed lab AND that lab to be conforming. Per-
  case tooltip explains the disablement reason — "Open a folder",
  "Start a lab", or "Topology View requires the deployed topology
  file to be named *.clab.yml..." with instructions for the
  rename-on-restart path.

- **Generalized `set()` helper** in webview now accepts an optional
  `disabledTitle` for the disabled-because-not-applicable case
  (NOT for disabled-because-busy — the "…" suffix already
  communicates that). Cleaner separation of "why is this button
  off" cues.

### Notes
- The `.yaml`-vs-`.yml` choice from the source extension is
  preserved in the rename target. Users with strong opinions about
  YAML extension convention won't be silently flipped.
- For non-conforming deployed labs, our existing v0.4.3 editor
  pre-open is still a good practice (it removes one possible failure
  mode even if it can't help here), so we kept it.
- This release exposes a broader truth: the dashboard's flexibility
  ("works with any topology file") needs to be balanced against
  ecosystem fit ("srl-labs requires *.clab.yml"). Future integration
  shims (Edgeshark, Inspect, etc.) will likely face the same
  constraint and benefit from the same per-lab gating pattern.
- Pairs with `lab-base-sandbox` rev1.0.9 (extension bump only).



Third patch of the v0.4.x user-feedback cycle. One real bug surfaced in
the v0.4.2 smoke test, plus a system-level fix for a hazard the same
test logs revealed.

### Fixed
- **Topology View now actually opens.** v0.4.2 shipped the Topology
  View button but srl-labs' TopoViewer command discovers its target
  via the active text editor's URI. Dispatched from our webview, the
  active editor was either nothing or our webview panel — neither
  resolves to a topology file. Result: "No lab node or topology file
  selected."

  Fix: bridge editor context. Before dispatching, we open the deployed
  lab's topology file as a preview tab via
  `showTextDocument(uri, { preview: true, preserveFocus: false })`.
  The preview-tab semantics (italic single tab, auto-replaced by next
  preview file, easy to dismiss) read as transient. Topology path
  comes from `containerlab inspect` (via shared inspectDeployedLabs
  helper) so it works regardless of filename convention. Multi-lab
  case shows a QuickPick.

  Pre-open is best-effort: if `showTextDocument` fails, we log and
  dispatch anyway — failure mode is no worse than v0.4.2.

### Added
- **In-flight action tracking.** The v0.4.2 smoke logs revealed a
  serious race: a user clicked Start, didn't see immediate feedback
  (image pull is slow), clicked again, and two concurrent
  `containerlab deploy` invocations raced on the same topology. 13
  "container already in use" errors followed; the lab eventually
  recovered through containerlab's idempotency, but the chaos was
  alarming and not guaranteed under different timing.

  The same hazard applies to every action button. Fix: a system-level
  in-flight registry.

  - **`src/in-flight.ts`** — module-level `Set<ActionKind>` plus
    `isInFlight()`, `markInFlight()`, `unmarkInFlight()`,
    `inFlightSnapshot()` helpers.
  - **`src/extension.ts`** — `trackedCommand()` helper wraps each
    button-bound command. On invocation: short-circuits if the kind
    is already in flight, marks it, schedules a state push, runs
    the action body, and unmarks in a `finally` (runs even if the
    action throws — no permanently-locked buttons).
  - **`src/state.ts`** — `WorkspaceState` now carries
    `inFlightActions: ActionKind[]`, populated from the registry
    on every state computation.
  - **`src/webview.ts`** — `updateButtonEnablement` refactored to
    a unified `set(id, kind, enablementOK)` helper that handles
    disabled-OR-busy in one place. Buttons that are mid-execution
    get disabled AND get a `.action-btn--busy` class that adds a
    "…" suffix via CSS `::after`. Users now see "Start…" while
    deploy is running instead of an inert greyed button.

  All six button-bound commands participate (import, start, stop,
  save, export, topologyView). `setupGit` and `refresh` are
  deliberately unwrapped — interactive prompt locks the user in;
  refresh is instantaneous.

  Defense in depth: the button-disable on click is a UX nicety,
  but the authoritative race-condition guard is in `trackedCommand`,
  which catches palette/keybinding-triggered concurrent invocations
  too.

### Notes
- The integration-shim playbook documented in `topology-view.ts`
  gained a new step 4: "Discover what context the target command
  expects (active editor? specific selection? command args?) and
  set it up BEFORE dispatch." The lesson from this release.
- v0.4.2's smoke test confirmed the actual srl-labs TopoViewer
  command ID: `containerlab.lab.graph.topoViewer`. Our dynamic
  lookup found it correctly; the failure mode was purely the
  editor-context one. Worth knowing for future srl-labs
  integrations.
- Pairs with `lab-base-sandbox` rev1.0.8 (extension bump only).



Second patch of the v0.4.x user-feedback cycle. Two small but
high-value adds from the v0.4.1 smoke test.

### Added
- **Start fallback file picker for non-standard topology names.**
  Start now has a three-step topology resolver:
  1. Session memory — if the user picked a manual topology earlier
     this session, reuse it silently (unless the file has since been
     deleted, in which case clear the memory and fall through).
  2. Glob discovery — look for `*.clab.yml` / `*.clab.yaml`, same as
     v0.4.1 (zero → step 3, one → use silently, multiple → QuickPick).
  3. Fallback file picker — `showOpenDialog` filtered to `.yml` /
     `.yaml` as an escape hatch for repos that don't follow the
     `.clab.yml` naming convention. User cancel = quiet exit.

  Picked topology is remembered in a module-level `Map<workspace,
  path>` for the extension's lifetime (= lab session). Survives
  dashboard close+reopen; resets on lab restart (no persistence
  layer, matching the sandbox container's ephemeral contract).
  If the remembered file vanishes from disk, we detect+recover
  silently on the next Start.

- **Topology View button.** Sixth button in the actions row, placed
  between Start and Stop in reading order (Import → Start → *view
  what you started* → Stop → Save → Export). Dispatches to srl-labs'
  TopoViewer via a dynamic command lookup: enumerate
  `vscode.commands.getCommands()`, find the first `containerlab.*`
  command whose ID contains "topoviewer" (case-insensitive). This
  buys resilience against future srl-labs renames — the button
  keeps working even if the exact command ID changes, as long as
  the general pattern holds. Clear error toast if no match is
  found (srl-labs extension missing).

  Enablement: same condition as Stop/Save (needs a deployed lab).
  The moment the last lab is destroyed, Topology View dims
  alongside them.

- **`sandboxDashboard.topologyView`** command in the palette.

### Changed
- **Start button enablement loosened.** Previously disabled when
  `state.topologies.length === 0`. Now enabled whenever a workspace
  is open — Start can handle the zero-topology case itself via the
  fallback picker. The `hasTopology` signal is still computed in
  `updateButtonEnablement()` as documentation (and for any future
  button that genuinely needs it), but no button currently uses it.

### Notes
- Dynamic command lookup for Topology View is a small but deliberate
  architectural choice: the dashboard is increasingly a *launcher*
  for capabilities that live in other extensions (srl-labs'
  TopoViewer today; potentially Edgeshark / lab inspection / etc.
  tomorrow). Resilient dispatch patterns — discover-at-runtime
  rather than hardcode — make that integration style sustainable
  as the surrounding ecosystem evolves.
- Fallback picker accepts any `.yml` / `.yaml`; no shape validation.
  If the user picks a non-topology file, `containerlab deploy` will
  reject it with a clear error that surfaces through runDeploy's
  existing failure toast. Trusting the user's pick beats
  half-hearted YAML inspection for a patch release.
- Pairs with `lab-base-sandbox` rev1.0.7 (extension bump only).



Patch release driven by user feedback from the v0.4.0 smoke test:
after cloning a repo via Import, users hit the `git config user.name`
/ `user.email` wall the moment they tried to commit. They had to drop
to a terminal to set those, which broke the "low-friction lab
lifecycle" promise.

### Added
- **Set up Git for committing.** New action that prompts for `user.name`
  and `user.email` and runs `git config --global` for both. Reachable
  three ways:
  1. **Clone-from-GitHub gate.** Before any destructive workspace
     change, `runImportFromGitHub` calls a new `ensureGitIdentity()`
     helper. If config is missing, the prompt appears; the clone
     proceeds only if the user completes it. Cancel = clone aborted
     with no workspace mutation, plus a hint pointing at the
     `Set Up Git for Committing` palette command for later.
  2. **Activation-time hook.** On extension activation, after the
     dashboard auto-opens, a 2-second-deferred check runs: if the
     workspace contains a `.git` directory (root or one level deep)
     AND `git config --global` is missing identity fields, a non-modal
     info notification appears: *"Set up Git for committing? Sandbox
     labs start fresh each session..."* with **Set Up Now** and
     **Maybe Later** actions. Pure non-git workflows see nothing.
  3. **Command palette.** `Sandbox Dashboard: Set Up Git for
     Committing` is always available. Idempotent — if identity is
     already set, surfaces a confirmation toast and exits without
     re-prompting.
- **`src/git.ts` utility module** with `getGitIdentity()`,
  `setGitIdentity()`, `hasGitInWorkspace()`. Spawn-based, no shell,
  same safety pattern as the rest of the codebase.

### Notes
- **Sandbox containers are intentionally ephemeral** — 8-hour
  lifetime, blank canvas every launch, no persistent volumes for
  user state. We deliberately do NOT try to persist git identity
  across launches: that would be out of character with how labs
  work, and not actually possible without coordinated infrastructure
  changes outside this extension. Users see the prompt once per lab
  launch (in workspaces where git matters); that's the contract.
- The clone-time gate runs BEFORE the destructive workspace wipe.
  Cancelling at git-identity setup leaves the workspace untouched.
- Validation is loose: name must be non-empty, email must contain
  `@`. People legitimately use addresses like
  `12345+username@users.noreply.github.com` that strict RFC-822
  validators reject.

### Pairs with
- `lab-base-sandbox` rev1.0.6 (extension bump only).



Milestone 4 — **Stop and GitHub clone**. Driven by user feedback
from the v0.3.0 smoke test: a clean way to tear down a lab
without leaving the dashboard, and a "drop my repo here" import
path that matches how lab content actually lives in real
workflows.

### Added
- **Stop button.** Fifth button in the actions row (🛑). Tears
  down a deployed lab via `containerlab destroy --cleanup`. UI
  vocabulary deliberately avoids "destroy" because the topology
  file, `clab-*` config directories, and git-tracked content
  all survive — only the running containers and network state
  go away. A subsequent Start re-deploys from the same topology
  and picks up any saved configs automatically.
- **Three-button confirmation modal on Stop.** Cancel / Save and
  Stop / Stop without Saving. "Save and Stop" runs `containerlab
  save` first to capture running configs into `clab-<labname>/`,
  then destroys. If save fails, the lab is NOT torn down — the
  user wanted their configs preserved, so we don't proceed
  without them. Partial-success path (save succeeded, destroy
  failed) is surfaced honestly: "Configs were saved successfully,
  but stop failed: <err>. The lab is still running."
- **GitHub clone for Import.** Import now opens with a QuickPick:
  📁 Upload File (.tar.gz) or 🐙 Clone from GitHub. The tarball
  path is unchanged from M3.3. The GitHub path:
  - `showInputBox` for the repository URL with loose validation
  - Reads workspace contents — fast-path for empty workspaces
    (no confirmation), destructive-confirmation modal for
    non-empty (lists first 8 entries verbatim, "… (+N more)"
    overflow)
  - Wipe via `fs.readdir` + `fs.rm({recursive, force})` per
    entry — safer than shell wildcards
  - `git clone --progress <url> .` from workspace root with
    line-streamed progress (handles git's CR-based in-line
    progress updates by normalizing CR to LF before splitting)
  - 30s "still working" status hint in the progress toast
  - 5min hard timeout (SIGTERM, then SIGKILL after 3s grace)
  - Trusts code-server's auth flow — git credential prompts
    are intercepted and surfaced through the browser
  - On success: refreshes the dashboard, info toast
  - On failure: error toast acknowledges the workspace state
    honestly ("workspace was already cleared, you'll need to
    import again or restore from backup")
- **`Sandbox Dashboard: Stop Lab`** command in the palette.

### Changed
- **Stop and Save now share a fresh-inspect helper.** Both
  actions need to "ask containerlab what's currently running"
  before operating. New internal module `src/actions/_helpers.ts`
  houses `inspectDeployedLabs()`, `extractLabs()`, and the
  `RunningLab` type (renamed from `SavableLab` since it's now
  used by more than just save). Save's M3.5 inline copies were
  deleted in favor of importing from `_helpers`. Behavior
  unchanged.
- **Stop's button enablement matches Save's exactly.** Both
  disabled when no workspace open OR no labs deployed. Comment
  in `updateButtonEnablement` notes the parallel so future
  drift is visible.
- **Action button row now contains 5 buttons.** `flex-wrap` on
  the row already handled this — no CSS changes needed. The
  buttons read left-to-right as the natural lifecycle: Import
  (get content) → Start (run) → Stop (tear down) → Save
  (snapshot) → Export (bundle).

### Internal
- **`spawnAndStream` consolidation.** Stop has two containerlab
  invocations (save + destroy) that need the same line-
  streaming-to-progress-and-output pattern Start.runDeploy and
  Save.runContainerlabSave already implement. Stop's local
  `spawnAndStream` helper takes a `[bin, args]` tuple and the
  cwd/output/progress trio. Will be lifted to `_helpers` if
  Start or Save grow a second spawn each — premature
  extraction now would force the helper to handle every shape
  any caller might want.
- **JSDoc terminator gotcha caught and fixed.** Stop's draft
  contained `clab-*/` in a comment, which TypeScript correctly
  read as the JSDoc closing token (`*/`). Cascaded into 100+
  parse errors. Same family as M3.5's stray-backtick bug —
  comment contents accidentally matching the enclosing block's
  terminator. `tsc --noEmit` caught it immediately; fix was
  rephrasing the comment. Layered defenses (tsc + node --check
  on emitted webview) keep covering this class.

### Notes
- Pairs with `lab-base-sandbox` 1.0.5.
- "Stop" is intentionally NOT the same as a containerlab "pause"
  feature (which doesn't exist anyway). It's a clean teardown
  with optional save. Resumability comes from the topology +
  saved configs surviving in the workspace, not from any
  containerlab-level pause/resume mechanism.
- GitHub clone has no branch/tag selection. Falls back to
  whatever the repo's default branch is. Branch picker is a
  candidate for M5+ if users ask for it.
- No mid-clone cancellation. Killing a clone partway leaves
  the workspace in an indeterminate state; the 5-min timeout
  handles the pathological hang case.



Milestone 3 — **the four buttons**. The dashboard is no longer
just an observer; it's a fully functional control plane for the
sandbox lab lifecycle.

### Added
- **Import action.** Pick a `.tar.gz` / `.tgz` with the file
  picker; the action reads the tarball's top-level entries via
  `tar -tzf` and compares them against what's already in the
  workspace. Any collisions surface in a modal warning (first
  5 names listed verbatim, overflow summarized as "… (+N more)")
  with Overwrite / Cancel. Files already in the workspace but
  not in the tarball are preserved — this is a merge, not a
  replace, and the warning says so. Extraction via
  `tar -xzf -C <workspaceRoot>` with progress notification.
  Dashboard refreshes automatically once extraction completes
  because M2's file watchers pick up any new `*.clab.yml`.
- **Start action.** Discovers `*.clab.yml` / `*.clab.yaml` in the
  workspace. Zero files → explainer toast. One file → uses it.
  Multiple files → `showQuickPick` with basenames + relative
  paths. Deploys via `sudo -n containerlab deploy -t <path>`
  with progress notification; stdout/stderr are streamed to the
  Output channel line-by-line AND surfaced as the progress toast
  message, so users see "Creating container clab-foo-bar" etc.
  live. On success, triggers an immediate dashboard refresh via
  the new `sandboxDashboard.refresh` command — the new lab
  surfaces within ~1 second instead of waiting up to 30s for the
  next containerlab poll tick. Sudo-auth failures get a pointed
  "passwordless sudo not configured" toast instead of forcing the
  user to parse sudo's own prose.
- **Save action.** Two-phase: first `sudo -n containerlab save
  -t <topology>` captures the running configs of every node into
  `clab-<labname>/<nodename>/` directories; then bundles the
  whole workspace into a `.tar.gz` — keeping the `clab-*`
  directories this time because those hold the point of Save.
  If multiple labs are deployed, a picker lets the user choose;
  one lab uses it silently. Partial-success path: if configs
  capture cleanly but the user then cancels the save dialog, we
  toast "Configs captured; tarball skipped — you can Export
  anytime" instead of treating it as a failure. Same sudo-auth
  hint as Start when applicable.
- **Export action.** Bundles the workspace as `.tar.gz` via
  `tar -czf --exclude=./.git --exclude=./node_modules
  --exclude=./clab-* -C <workspaceRoot> .`. `showSaveDialog`
  defaults to `$HOME/<workspace-name>-YYYY-MM-DD-HHMM.tar.gz`.
  Success toast has a "Reveal in File Explorer" follow-up that
  calls VS Code's `revealFileInOS` command (cross-platform:
  Finder / Explorer / xdg-open). Exclusions are opinionated and
  minimal; `.vscode/`, `.devcontainer/`, and `*.log` are
  deliberately INCLUDED because sandbox labs ship useful content
  in those paths.
- **`sandboxDashboard.refresh` command.** Forces an immediate
  state recompute independent of the 30s poll cycle. Used
  internally by Start to surface new labs quickly; also exposed
  in the command palette as "Sandbox Dashboard: Refresh" for
  manual use.
- **Action buttons in the dashboard.** New "Actions" section at
  the top of the webview with Import / Start / Save / Export
  buttons styled via VS Code's `--vscode-button-*` theme tokens
  so they read as native controls in every theme.
- **Preconditional button enablement.** All four buttons
  correctly grey out when their preconditions aren't met:
  - Export, Import: disabled with no open workspace
  - Start: disabled with no `*.clab.yml` in the workspace
  - Save: disabled with no deployed lab
  Updates live on every state push — the moment the last lab
  is destroyed, Save dims without the user needing to refresh.

### Changed
- **Actions split into per-file modules under `src/actions/`.**
  0.2.x shipped a single `src/actions.ts` with all four as
  stubs. Each action now lives in `src/actions/<kind>.ts` with
  a barrel at `src/actions/index.ts` re-exporting the real
  implementations. `extension.ts`'s imports didn't change —
  `from './actions'` resolves to the barrel automatically.
- **`runTar` signature parameterized.** The tarball-bundling
  helper previously used a module-level `TAR_EXCLUDES` constant.
  It's now exported from `./export.ts` with a `readonly string[]`
  excludes parameter so Save can reuse the same code with a
  shorter exclude list (keeping `clab-*`). `DEFAULT_EXPORT_EXCLUDES`
  and `DEFAULT_SAVE_EXCLUDES` are both exported constants.
- **All four action commands declared in `contributes.commands`**
  for command-palette discoverability. Reachable from the
  palette, keybindings, or the webview buttons — same
  implementation, three entry points.

### Internal
- **Build-time syntax check for the emitted webview script.**
  `scripts/check-webview-script.js` runs after every `npm run
  bundle` (wired as a `postbundle` npm script). It loads the
  bundled extension with a mocked `vscode` module, captures the
  HTML emitted by `DashboardPanel.buildHtml()`, extracts the
  inline `<script>` body, and runs `node --check` on a temp file.
  Fails loudly with a line number on any JS syntax error. This
  is the guardrail that would have caught the v0.2.0 → v0.2.1
  hotfix at build time. Verified by re-injecting the 0.2.0 bug
  during development and confirming the check flagged it.
- **Layered syntax defense now covers both TypeScript and
  runtime JS.** `tsc --noEmit` protects against TypeScript
  parse errors including template-literal termination issues
  (caught a stray-backtick bug during M3.5); `node --check` on
  the emitted webview body protects against runtime-visible JS
  syntax bugs the TS compiler can't see inside string literals
  (caught the v0.2.0 backslash bug). Both fire in sequence on
  every bundle.
- **`sudo -n containerlab ...` defense pattern.** All privileged
  containerlab invocations use `-n` (non-interactive sudo). If
  passwordless sudo isn't configured, sudo fails fast with a
  clear diagnostic instead of hanging forever on a password
  prompt the webview can't service. Failure-message pattern-
  matching surfaces this as a "passwordless sudo not configured
  for containerlab" toast rather than forcing the user to parse
  sudo's own prose.
- **Line-buffered output streaming from `spawn`.** Start and
  Save both have to forward containerlab's chatter line-by-line
  to both the Output channel and the progress toast message.
  Each implements a small manual line-buffer since stdout chunks
  from Node don't arrive aligned to newlines. Trailing partial
  lines are flushed on `close`.

### Notes
- Pairs with `lab-base-sandbox` 1.0.4 (to be cut immediately
  after this release).
- Import has no rename-on-collision mode. If a user wants to
  preserve their existing workspace while importing, they can
  extract to a subfolder externally. Deliberately non-configurable
  for M3.
- Start has no Destroy pair. Destroy is a separate concern and
  is a candidate for M4.
- No deploy flags (`--reconfigure`, `--max-workers`, `--vars`).
  Can be added as a QuickPick modifier or VS Code setting later.



### Fixed
- **Dashboard no longer falsely reports `containerlab inspect
  returned an unrecognized JSON shape` on clean containerlab 0.74+
  hosts.** The parser was written against an older shape assumption
  (top-level array or `{ containers: [...] }`), but current
  containerlab defaults to an object keyed by lab name:
  `{ "<lab_name>": [ <container>, ... ], ... }`. Empty state is `{}`.
- Parser refactored into a dedicated `normalizeToContainers()` helper
  that recognizes all three historical shapes plus the empty-object
  case. Container records are flattened across all lab keys and
  then grouped by `lab_name` — same downstream logic as before,
  just fed from a more permissive input normalizer.

### Internal
- Six-way unit test of the normalizer (bare array, `containers`
  wrapper, keyed-by-lab with one lab, keyed-by-lab with multiple
  labs, empty object, unknown shape) run locally before release.

### Notes
- Pairs with `lab-base-sandbox` 1.0.3 (to be cut immediately after
  this release).



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
