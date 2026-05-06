import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prewarmWebviewAccount } from '../../services/webviewAccountService';
import type { Account, AccountStatus } from '../../types/accounts';
import { MRU_ACCOUNT_KEY, PREWARM_MAX_ACCOUNTS } from '../../utils/webviewAccountMru';
import { usePrewarmMostRecentAccount } from '../usePrewarmMostRecentAccount';

vi.mock('../../services/webviewAccountService', () => ({
  prewarmWebviewAccount: vi.fn().mockResolvedValue(undefined),
}));

function makeAccount(
  overrides: Partial<Account> & { id: string; provider: Account['provider'] }
): Account {
  return {
    label: overrides.id,
    createdAt: '2026-01-01T00:00:00Z',
    status: 'closed' as AccountStatus,
    ...overrides,
  };
}

function renderPrewarmHook(args: { accounts: Account[]; activeAccountId: string | null }): void {
  const accountsById: Record<string, Account | undefined> = Object.fromEntries(
    args.accounts.map(a => [a.id, a])
  );
  renderHook(() =>
    usePrewarmMostRecentAccount({
      accounts: args.accounts,
      accountsById,
      activeAccountId: args.activeAccountId,
    })
  );
}

describe('usePrewarmMostRecentAccount (issue #1233)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prewarms the MRU account when conditions are met', () => {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-1');
    renderPrewarmHook({
      accounts: [makeAccount({ id: 'acct-1', provider: 'slack', status: 'closed' })],
      activeAccountId: null,
    });
    expect(prewarmWebviewAccount).toHaveBeenCalledTimes(1);
    expect(prewarmWebviewAccount).toHaveBeenCalledWith('acct-1', 'slack');
  });

  it('does nothing when no MRU id is persisted', () => {
    renderPrewarmHook({
      accounts: [makeAccount({ id: 'acct-1', provider: 'slack' })],
      activeAccountId: null,
    });
    expect(prewarmWebviewAccount).not.toHaveBeenCalled();
  });

  it('does nothing when the accounts list is empty', () => {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-1');
    renderPrewarmHook({ accounts: [], activeAccountId: null });
    expect(prewarmWebviewAccount).not.toHaveBeenCalled();
  });

  it('does nothing when accounts.length exceeds PREWARM_MAX_ACCOUNTS', () => {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-1');
    const tooMany: Account[] = Array.from({ length: PREWARM_MAX_ACCOUNTS + 1 }, (_, i) =>
      makeAccount({ id: `acct-${i}`, provider: 'slack', status: 'closed' })
    );
    renderPrewarmHook({ accounts: tooMany, activeAccountId: null });
    expect(prewarmWebviewAccount).not.toHaveBeenCalled();
  });

  it('does nothing when the MRU account is no longer in the store', () => {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-removed');
    renderPrewarmHook({
      accounts: [makeAccount({ id: 'acct-1', provider: 'telegram' })],
      activeAccountId: null,
    });
    expect(prewarmWebviewAccount).not.toHaveBeenCalled();
  });

  it('does nothing when the MRU account is already the active one', () => {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-1');
    renderPrewarmHook({
      accounts: [makeAccount({ id: 'acct-1', provider: 'slack' })],
      activeAccountId: 'acct-1',
    });
    expect(prewarmWebviewAccount).not.toHaveBeenCalled();
  });

  it.each<AccountStatus>(['pending', 'loading', 'open'])(
    'does nothing when the MRU account is already in status %s',
    status => {
      window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-1');
      renderPrewarmHook({
        accounts: [makeAccount({ id: 'acct-1', provider: 'slack', status })],
        activeAccountId: null,
      });
      expect(prewarmWebviewAccount).not.toHaveBeenCalled();
    }
  );

  it('still prewarms when the MRU account is in status timeout or error', () => {
    window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-1');
    renderPrewarmHook({
      accounts: [makeAccount({ id: 'acct-1', provider: 'slack', status: 'timeout' })],
      activeAccountId: null,
    });
    expect(prewarmWebviewAccount).toHaveBeenCalledWith('acct-1', 'slack');
  });
});
