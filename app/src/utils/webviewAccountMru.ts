/**
 * Issue #1233 — most-recently-active account tracking + prewarm gating.
 *
 * Persists the last account the user clicked in the rail to `localStorage`
 * so the next session can prewarm that account's CEF profile + provider
 * page in the background, turning the first user click into a warm-reopen
 * (`state:"reused"`) instead of a cold load.
 *
 * Extracted from `Accounts.tsx` so the helpers can be unit-tested in
 * isolation without spinning up the full Redux + Tauri service graph.
 */

export const MRU_ACCOUNT_KEY = 'webview-accounts:lastActive';

/**
 * Cap on `accounts.length` for which the MRU prewarm runs. Power users
 * with many accounts skip prewarm so the spawn cost stays bounded — the
 * prewarmed webview reserves a CEF process + provider profile, and we
 * don't want a 20-account user to have all 20 warming on launch.
 */
export const PREWARM_MAX_ACCOUNTS = 5;

export function readMruAccountId(): string | null {
  try {
    return window.localStorage.getItem(MRU_ACCOUNT_KEY);
  } catch {
    // Storage may be disabled (private mode, sandboxing) — silently
    // skip; worst case is a normal cold open next session.
    return null;
  }
}

export function writeMruAccountId(accountId: string): void {
  try {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, accountId);
  } catch {
    // Same fallback as `readMruAccountId` — never throw on a write
    // failure, prewarm is best-effort.
  }
}
