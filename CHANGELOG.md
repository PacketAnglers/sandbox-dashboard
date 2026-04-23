# Changelog

All notable changes to the **Sandbox Dashboard** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-22

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
