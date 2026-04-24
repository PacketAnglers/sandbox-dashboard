/**
 * Set up Git for committing.
 *
 * Sandbox containers are intentionally ephemeral (8-hour lifetime,
 * blank canvas every launch). Persisting git identity across lab
 * launches would be out of character with how labs work — and also
 * not actually possible without coordinated infrastructure changes
 * we haven't made.
 *
 * So this action is honest about what it does:
 *
 *   - Prompts the user for name + email
 *   - Runs `git config --global user.name` and `git config --global
 *     user.email` to set them for this container's lifetime
 *   - Doesn't try to remember anything across launches
 *
 * The user knows: "I set this up at the start of every lab session."
 * That matches the rest of the lab's contract.
 *
 * TWO ENTRY POINTS
 * ────────────────
 *   - runSetupGit(): the user-facing command (palette + activation
 *     trigger). Idempotent — if identity is already set, it shows
 *     a confirmation toast and exits without re-prompting.
 *
 *   - ensureGitIdentity(): the gate-or-skip helper used by
 *     Clone-from-GitHub. Returns true if identity is set after
 *     this call (so the caller can proceed), false if the user
 *     cancelled the prompt (so the caller should abort).
 */

import * as vscode from 'vscode';
import { getGitIdentity, setGitIdentity } from '../git';

export async function runSetupGit(
    _context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    output.appendLine('[sandboxDashboard] action: setup-git');

    const existing = await getGitIdentity();
    if (existing.name && existing.email) {
        // Already configured — confirm and exit. Idempotent.
        vscode.window.showInformationMessage(
            `Git is already set up: ${existing.name} <${existing.email}>`,
        );
        output.appendLine(
            `[sandboxDashboard] git already configured: ${existing.name} <${existing.email}>`,
        );
        return;
    }

    // Either name or email is missing. Run the prompt flow.
    const success = await promptAndSet(output);
    if (success) {
        const final = await getGitIdentity();
        vscode.window.showInformationMessage(
            `Git set up: ${final.name} <${final.email}>. You can commit now.`,
        );
    }
    // promptAndSet handles its own error toasts on failure.
    // No "you cancelled" toast — silent cancel is fine.
}

/**
 * Gate-or-skip helper: if git identity is fully set, returns true
 * immediately. If anything is missing, prompts the user; returns
 * true on successful set, false if the user cancels.
 *
 * Callers (currently just runImportFromGitHub) use this to decide
 * whether to proceed with their operation. If we return false,
 * caller MUST abort — proceeding would land the user in the very
 * commit-time wall this whole feature exists to prevent.
 */
export async function ensureGitIdentity(
    output: vscode.OutputChannel,
): Promise<boolean> {
    const existing = await getGitIdentity();
    if (existing.name && existing.email) {
        return true;
    }

    output.appendLine(
        '[sandboxDashboard] git identity missing; prompting before clone',
    );
    return promptAndSet(output);
}

// ─── prompt flow ────────────────────────────────────────────────────────────

/**
 * The actual interactive prompt: two showInputBox calls back-to-back,
 * then writeConfig for both.
 *
 * Returns true on success, false on user cancel at any prompt step.
 * On write failure, surfaces an error toast and returns false.
 *
 * We pre-fill each input with the existing value (if any) so users
 * who only have one of the two set don't have to re-type the other.
 */
async function promptAndSet(output: vscode.OutputChannel): Promise<boolean> {
    const existing = await getGitIdentity();

    // ── Prompt for name ────────────────────────────────────────────────────
    const name = await vscode.window.showInputBox({
        title: 'Set up Git for committing (1 of 2)',
        prompt: 'Your name (used in commit author info)',
        placeHolder: 'e.g. Mitch Vaughan',
        value: existing.name ?? '',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length === 0 ? 'Name cannot be empty' : null,
    });
    if (name === undefined) {
        // ESC or X — user cancelled.
        output.appendLine('[sandboxDashboard] setup-git cancelled at name prompt');
        return false;
    }

    // ── Prompt for email ───────────────────────────────────────────────────
    // Loose email validation: must contain @, must be non-empty. We
    // deliberately don't enforce strict RFC-822; people legitimately
    // use addresses like 12345+username@users.noreply.github.com that
    // strict validators sometimes reject.
    const email = await vscode.window.showInputBox({
        title: 'Set up Git for committing (2 of 2)',
        prompt: 'Your email (used in commit author info)',
        placeHolder: 'e.g. you@example.com or 12345+you@users.noreply.github.com',
        value: existing.email ?? '',
        ignoreFocusOut: true,
        validateInput: (v) => {
            const trimmed = v.trim();
            if (trimmed.length === 0) return 'Email cannot be empty';
            if (!trimmed.includes('@')) return 'Email should contain @';
            return null;
        },
    });
    if (email === undefined) {
        output.appendLine('[sandboxDashboard] setup-git cancelled at email prompt');
        return false;
    }

    // ── Write ──────────────────────────────────────────────────────────────
    try {
        await setGitIdentity(name.trim(), email.trim());
        output.appendLine(
            `[sandboxDashboard] git configured: ${name.trim()} <${email.trim()}>`,
        );
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[sandboxDashboard] git config write failed: ${msg}`);
        const action = await vscode.window.showErrorMessage(
            `Couldn't save Git identity: ${msg}`,
            'View Log',
        );
        if (action === 'View Log') output.show();
        return false;
    }
}
