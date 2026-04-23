/**
 * ContainerLab CLI wrapper.
 *
 * Provides a single async function, `inspectContainerlab()`, that
 * shells out to `containerlab inspect --all --format json` and
 * returns a typed `ContainerlabStatus`.
 *
 * Design goals:
 *   - Defensive parsing. ContainerLab's JSON shape has evolved
 *     across versions. We extract the fields we need, tolerate
 *     missing ones, and never crash on unexpected input.
 *   - Honest error semantics. "No labs running" is NOT an error —
 *     it's the common steady state. We reserve `error` for
 *     genuinely unexpected failures (binary missing, timeout,
 *     malformed JSON).
 *   - Timeout. `inspect --all` can be slow if the daemon is
 *     busy; we cap at 5s so the dashboard never hangs waiting.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ContainerlabStatus, DeployedLab } from './types';

const execAsync = promisify(exec);

const INSPECT_TIMEOUT_MS = 5000;

/**
 * Probe the `containerlab` CLI and return the current deployment status.
 *
 * Callers should treat the returned object as authoritative; all
 * error handling happens inside. The only invariant: `lastCheckedAt`
 * is always set to the moment this function returned.
 */
export async function inspectContainerlab(): Promise<ContainerlabStatus> {
    const now = Date.now();

    // 1. Is the binary even on PATH? A fast pre-flight that gives us
    //    a clean "not available" signal without waiting for inspect's
    //    full timeout budget.
    try {
        await execAsync('command -v containerlab', { timeout: 2000 });
    } catch {
        return {
            available: false,
            deployedLabs: [],
            lastCheckedAt: now,
        };
    }

    // 2. Run the real inspect. `--all` returns every lab on the host;
    //    `--format json` gives us a parseable shape instead of the
    //    default table output.
    let stdout: string;
    try {
        const result = await execAsync(
            'containerlab inspect --all --format json',
            { timeout: INSPECT_TIMEOUT_MS },
        );
        stdout = result.stdout;
    } catch (err: unknown) {
        // containerlab exits non-zero when no labs are deployed.
        // That's a normal state, not an error. We distinguish by
        // checking the message/stderr — if it looks like "no
        // running labs" we return the clean empty state; otherwise
        // surface the error.
        const message = err instanceof Error ? err.message : String(err);
        if (/no\s+(running\s+)?labs?/i.test(message) || /no\s+containers?\s+found/i.test(message)) {
            return {
                available: true,
                deployedLabs: [],
                lastCheckedAt: Date.now(),
            };
        }
        return {
            available: true,
            deployedLabs: [],
            lastCheckedAt: Date.now(),
            error: `containerlab inspect failed: ${message}`,
        };
    }

    // 3. Parse the JSON. Empty output means "no labs" in some
    //    containerlab versions (instead of non-zero exit).
    const trimmed = stdout.trim();
    if (!trimmed) {
        return {
            available: true,
            deployedLabs: [],
            lastCheckedAt: Date.now(),
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (err) {
        return {
            available: true,
            deployedLabs: [],
            lastCheckedAt: Date.now(),
            error: `containerlab inspect returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // 4. Extract deployed labs. We're permissive about shape — different
    //    containerlab versions structure this differently:
    //
    //      - Newer: { containers: [ { lab_name, labPath, ... }, ... ] }
    //      - Older: [ { lab_name, labPath, ... }, ... ] (array at top level)
    //
    //    We accept either. If the shape is something we don't recognize,
    //    return empty with an error note — visible in the UI so a user
    //    can file an issue instead of puzzling over silent emptiness.
    const labs = extractDeployedLabs(parsed);
    if (labs === null) {
        return {
            available: true,
            deployedLabs: [],
            lastCheckedAt: Date.now(),
            error: 'containerlab inspect returned an unrecognized JSON shape',
        };
    }

    return {
        available: true,
        deployedLabs: labs,
        lastCheckedAt: Date.now(),
    };
}

/**
 * Extract the deployed-labs list from a parsed JSON blob.
 *
 * Returns `null` if the shape is unrecognizable (caller sets error),
 * `[]` if we recognize the shape but there are no labs, or an array
 * of DeployedLab records if labs are present.
 *
 * Groups containers by their `lab_name` to produce one DeployedLab
 * per logical lab, with `nodeCount` summing the containers that
 * belong to it.
 */
function extractDeployedLabs(parsed: unknown): DeployedLab[] | null {
    // Normalize to an array of container records regardless of whether
    // the top-level is an object with `containers` or already an array.
    let containers: unknown[];
    if (Array.isArray(parsed)) {
        containers = parsed;
    } else if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'containers' in parsed &&
        Array.isArray((parsed as { containers: unknown }).containers)
    ) {
        containers = (parsed as { containers: unknown[] }).containers;
    } else {
        return null;
    }

    // Group by lab_name. A lab with 4 nodes appears as 4 container records;
    // we want 1 DeployedLab with nodeCount=4.
    const byLab = new Map<string, DeployedLab>();
    for (const entry of containers) {
        if (entry === null || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;

        const labName = typeof rec.lab_name === 'string'
            ? rec.lab_name
            : (typeof rec.labName === 'string' ? rec.labName : undefined);
        if (!labName) continue;

        const topologyPath = typeof rec.labPath === 'string'
            ? rec.labPath
            : (typeof rec.lab_path === 'string' ? rec.lab_path : '');

        const existing = byLab.get(labName);
        if (existing) {
            existing.nodeCount += 1;
        } else {
            byLab.set(labName, {
                name: labName,
                topologyPath,
                nodeCount: 1,
            });
        }
    }

    return Array.from(byLab.values());
}
