import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MRU_ACCOUNT_KEY,
  PREWARM_MAX_ACCOUNTS,
  readMruAccountId,
  writeMruAccountId,
} from '../webviewAccountMru';

describe('webviewAccountMru helpers (issue #1233)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the localStorage key + prewarm cap as constants', () => {
    expect(MRU_ACCOUNT_KEY).toBe('webview-accounts:lastActive');
    expect(PREWARM_MAX_ACCOUNTS).toBe(5);
  });

  describe('readMruAccountId', () => {
    it('returns null when nothing has been written yet', () => {
      expect(readMruAccountId()).toBeNull();
    });

    it('returns the value previously written under MRU_ACCOUNT_KEY', () => {
      window.localStorage.setItem(MRU_ACCOUNT_KEY, 'acct-42');
      expect(readMruAccountId()).toBe('acct-42');
    });

    it('returns null when localStorage.getItem throws (private mode / sandbox)', () => {
      vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      expect(readMruAccountId()).toBeNull();
    });
  });

  describe('writeMruAccountId', () => {
    it('persists the id under MRU_ACCOUNT_KEY', () => {
      writeMruAccountId('acct-7');
      expect(window.localStorage.getItem(MRU_ACCOUNT_KEY)).toBe('acct-7');
    });

    it('overwrites the previous MRU id', () => {
      writeMruAccountId('acct-old');
      writeMruAccountId('acct-new');
      expect(window.localStorage.getItem(MRU_ACCOUNT_KEY)).toBe('acct-new');
    });

    it('swallows setItem errors so prewarm-on-click is best-effort', () => {
      vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      // Must not throw.
      expect(() => writeMruAccountId('acct-9')).not.toThrow();
    });
  });
});
