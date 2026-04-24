/**
 * Shared helpers used by multiple action modules.
 *
 * Underscore prefix marks this as internal-to-actions: it's NOT
 * re-exported from ./index.ts. extension.ts only ever imports the
 * public action runners (runImport, runStart, runStop, runSave,
 * runExport).
 *
 * What's here:
 *   - inspectDeployedLabs(): query containerlab for the current set of
 *     running labs. Used by Save and Stop, both of which need a fresh
 *     read rather than relying on StateRefresher's cached snapshot —
 *     "operate on exactly the right live lab" matters most for
 *     mutating actions, and the refresher can be up to 30s stale.
 *
 *   - RunningLab: the lightweight record returned. Renamed from
 *     SavableLab (its M3.5 name) since it's now equally relevant to
 *     stop, restart, etc.
 *
 *   - extractLabs(): the JSON-shape normalizer. Mirrors the logic in
 *     src/containerlab.ts, intentionally duplicated so actions/ has no
 *     dependency on the state layer. Same four shapes covered (bare
 *     array, { containers }, keyed-by-lab, empty object).
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';

/** Minimal record of a currently-deployed lab. */
export interface RunningLab {
    name: string;
    topologyPath: string;
    nodeCount: number;
}

/**
 * Ask containerlab for the list of currently-deployed labs.
 *
 * Uses `containerlab inspect --all --format json`. NOT prefixed with
 * `sudo -n`: inspect is sometimes available without sudo, and if it
 * needs sudo and the user lacks it, the nicer failure mode is "no
 * lab found" (callers handle that with a UI explainer) rather than
 * a sudo-auth failure that doesn't really apply to read-only queries.
 *
 * Returns [] on any failure (binary missing, exit non-zero, JSON
 * parse failure, unrecognized shape). The output channel logs the
 * specific reason on every failure for diagnosability — callers
 * just see "no labs to operate on" and present accordingly.
 */
export async function inspectDeployedLabs(
    output: vscode.OutputChannel,
): Promise<RunningLab[]> {
    return new Promise((resolve) => {
        const child = spawn('containerlab', ['inspect', '--all', '--format', 'json'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        child.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
        child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

        child.on('error', (err) => {
            output.appendLine(`[sandboxDashboard] inspect spawn error: ${err.message}`);
            resolve([]);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                output.appendLine(`[sandboxDashboard] inspect exit ${code}: ${stderrBuf.trim()}`);
                resolve([]);
                return;
            }
            const trimmed = stdoutBuf.trim();
            if (!trimmed) { resolve([]); return; }

            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch (err) {
                output.appendLine(
                    `[sandboxDashboard] inspect JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                resolve([]);
                return;
            }
            resolve(extractLabs(parsed));
        });
    });
}

/**
 * Extract RunningLab records from containerlab's inspect output.
 *
 * Handles all four shapes containerlab has been known to emit:
 *   - bare array                   (oldest)
 *   - { containers: [ ... ] }      (older)
 *   - { "<lab_name>": [ ... ] }    (current 0.74+)
 *   - {}                           (current, no labs deployed)
 */
export function extractLabs(parsed: unknown): RunningLab[] {
    let containers: unknown[] = [];
    if (Array.isArray(parsed)) {
        containers = parsed;
    } else if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.containers)) {
            containers = obj.containers;
        } else {
            // keyed-by-lab shape: flatten all values that are arrays.
            for (const v of Object.values(obj)) {
                if (Array.isArray(v)) containers.push(...v);
            }
        }
    }

    const byLab = new Map<string, RunningLab>();
    for (const entry of containers) {
        if (entry === null || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const labName = typeof rec.lab_name === 'string'
            ? rec.lab_name
            : typeof rec.labName === 'string'
                ? rec.labName
                : undefined;
        if (!labName) continue;
        const topologyPath = typeof rec.labPath === 'string'
            ? rec.labPath
            : typeof rec.lab_path === 'string'
                ? rec.lab_path
                : '';
        const existing = byLab.get(labName);
        if (existing) {
            existing.nodeCount += 1;
        } else {
            byLab.set(labName, { name: labName, topologyPath, nodeCount: 1 });
        }
    }
    return Array.from(byLab.values());
}
