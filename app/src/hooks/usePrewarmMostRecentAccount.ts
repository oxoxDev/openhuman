import { useEffect } from 'react';

import { prewarmWebviewAccount } from '../services/webviewAccountService';
import type { Account } from '../types/accounts';
import { PREWARM_MAX_ACCOUNTS, readMruAccountId } from '../utils/webviewAccountMru';

interface UsePrewarmMostRecentAccountArgs {
  accounts: Account[];
  accountsById: Record<string, Account | undefined>;
  activeAccountId: string | null;
}

/**
 * Issue #1233 — fire-and-forget prewarm of the most-recently-active account
 * once on mount of the Accounts page. The prewarmed webview is spawned
 * off-screen with the full handler / scanner / notification setup, so the
 * eventual user click hits the warm-reopen branch in
 * `webview_account_open` and emits `state:"reused"` instead of paying the
 * cold-load wait.
 *
 * Skips when:
 *   - no MRU id persisted (first run)
 *   - the user has more than `PREWARM_MAX_ACCOUNTS` accounts (bound the
 *     spawn cost on power users)
 *   - the MRU account is the currently active one (no point prewarming
 *     what's already on screen)
 *   - the MRU account is already pending / loading / open (live or
 *     in-flight)
 *
 * Runs exactly once per mount on purpose: the Tauri command itself is
 * idempotent server-side, but re-firing on every Redux churn would just
 * generate noise in the logs.
 */
export function usePrewarmMostRecentAccount({
  accounts,
  accountsById,
  activeAccountId,
}: UsePrewarmMostRecentAccountArgs): void {
  useEffect(() => {
    const mruId = readMruAccountId();
    if (!mruId) return;
    if (accounts.length === 0 || accounts.length > PREWARM_MAX_ACCOUNTS) return;
    const acct = accountsById[mruId];
    if (!acct) return;
    if (acct.id === activeAccountId) return;
    if (acct.status === 'open' || acct.status === 'loading' || acct.status === 'pending') {
      return;
    }
    void prewarmWebviewAccount(acct.id, acct.provider);
    // Mount-only by design — see docstring. The deps the hook reads are
    // captured at first render so a later add-account or status flip
    // doesn't trigger a duplicate prewarm. We deliberately omit the
    // values from the deps array; the rule isn't enforced in this repo's
    // ESLint config, so we explain the omission in prose instead of via
    // a missing-rule disable directive.
  }, []);
}
