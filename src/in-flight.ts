/**
 * In-flight action registry.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The v0.4.2 smoke test surfaced a race condition: a user clicked Start,
 * didn't see immediate feedback (image pull is slow), clicked Start
 * again, and two concurrent `containerlab deploy` invocations raced
 * against each other on the same topology. Containers got "already in
 * use" errors; the lab eventually stabilized through containerlab's
 * idempotency, but the chaos was alarming and not guaranteed to
 * recover under different timing.
 *
 * The same hazard applies to every action button — Stop, Save, Export,
 * Import, Topology View. Anywhere a user can click a button while the
 * previous click is still being processed, we have a race.
 *
 * SOLUTION
 * ────────
 * Track which action kinds are currently mid-execution in a module-level
 * Set<ActionKind>. Two consumers:
 *
 *   1. Command registrations in extension.ts wrap each action body in
 *      try/finally that adds/removes the kind. Wrapped via the
 *      trackedCommand() helper so all six button-bound commands get
 *      identical bookkeeping.
 *
 *   2. State computation in state.ts reads the Set and includes it in
 *      WorkspaceState.inFlightActions. The webview then disables
 *      in-flight buttons + visually marks them busy with a "…" suffix.
 *
 * State pushes happen on add/remove (via trackedCommand calling
 * refresher.schedule()), so the UI updates within ~300ms of an action
 * starting and ending.
 *
 * THIS IS EXTENSION-SIDE TRUTH, NOT WEBVIEW BLEMISHES
 * ────────────────────────────────────────────────────
 * The button-disable on click is a UX nicety; the authoritative "is
 * this running" check lives here, where the action actually runs.
 * trackedCommand() short-circuits if the kind is already in the Set,
 * so even palette/keybinding-triggered concurrent invocations are
 * blocked.
 *
 * NOT TRACKED
 * ───────────
 * sandboxDashboard.setupGit (interactive prompt; user can't fire it
 * twice from the input box) and sandboxDashboard.refresh (instantaneous,
 * no benefit from tracking). Only the six button-bound action kinds
 * (import, start, stop, save, export, topologyView) participate.
 */

import type { ActionKind } from './types';

const inFlight = new Set<ActionKind>();

/**
 * True if any instance of the given action kind is currently running.
 * Used by trackedCommand to short-circuit concurrent invocations.
 */
export function isInFlight(kind: ActionKind): boolean {
    return inFlight.has(kind);
}

/**
 * Mark an action kind as in flight. Called by trackedCommand at the
 * start of each tracked command.
 */
export function markInFlight(kind: ActionKind): void {
    inFlight.add(kind);
}

/**
 * Mark an action kind as no longer in flight. Called by trackedCommand
 * in the finally block — runs whether the action succeeded, failed,
 * or threw, so a crashing action doesn't permanently lock its button.
 */
export function unmarkInFlight(kind: ActionKind): void {
    inFlight.delete(kind);
}

/**
 * Snapshot of currently in-flight action kinds. Consumed by state.ts
 * to populate WorkspaceState.inFlightActions on every state computation.
 *
 * Returns a fresh array (not a reference to the underlying Set) so
 * callers can't mutate the registry through the snapshot.
 */
export function inFlightSnapshot(): ActionKind[] {
    return Array.from(inFlight);
}
