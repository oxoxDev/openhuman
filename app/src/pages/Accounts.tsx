import { useEffect, useMemo, useState } from 'react';

import AddAccountModal from '../components/accounts/AddAccountModal';
import WebviewHost from '../components/accounts/WebviewHost';
import { closeWebviewAccount, startWebviewAccountService } from '../services/webviewAccountService';
import { addAccount, removeAccount, setActiveAccount } from '../store/accountsSlice';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import type { Account, ProviderDescriptor } from '../types/accounts';

function makeAccountId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const Accounts = () => {
  const dispatch = useAppDispatch();
  const accountsById = useAppSelector(state => state.accounts.accounts);
  const order = useAppSelector(state => state.accounts.order);
  const activeAccountId = useAppSelector(state => state.accounts.activeAccountId);
  const messagesByAccount = useAppSelector(state => state.accounts.messages);
  const logsByAccount = useAppSelector(state => state.accounts.logs);
  const unreadByAccount = useAppSelector(state => state.accounts.unread);

  const [addOpen, setAddOpen] = useState(false);

  // Bring up the bridge once.
  useEffect(() => {
    startWebviewAccountService();
  }, []);

  const accounts: Account[] = useMemo(
    () => order.map(id => accountsById[id]).filter((a): a is Account => Boolean(a)),
    [order, accountsById]
  );

  const active = activeAccountId ? (accountsById[activeAccountId] ?? null) : null;
  const activeMessages = active ? (messagesByAccount[active.id] ?? []) : [];
  const activeLogs = active ? (logsByAccount[active.id] ?? []) : [];

  const handlePickProvider = (p: ProviderDescriptor) => {
    setAddOpen(false);
    const id = makeAccountId();
    const acct: Account = {
      id,
      provider: p.id,
      label: p.label,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    dispatch(addAccount(acct));
    dispatch(setActiveAccount(id));
  };

  const handleRemove = (accountId: string) => {
    void closeWebviewAccount(accountId);
    dispatch(removeAccount({ accountId }));
  };

  return (
    <div className="flex h-full overflow-hidden bg-canvas-50">
      {/* Sidebar */}
      <aside className="flex w-64 flex-none flex-col border-r border-stone-200 bg-white">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h1 className="text-sm font-semibold text-stone-900">Accounts</h1>
          <button
            onClick={() => setAddOpen(true)}
            className="rounded-md bg-primary-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-600">
            + Add
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {accounts.length === 0 ? (
            <div className="px-4 py-6 text-xs text-stone-500">
              No accounts yet. Click <span className="font-semibold">+ Add</span> to connect a
              service.
            </div>
          ) : (
            <ul>
              {accounts.map(acct => {
                const isActive = acct.id === activeAccountId;
                const unread = unreadByAccount[acct.id] ?? 0;
                return (
                  <li key={acct.id}>
                    <button
                      onClick={() => dispatch(setActiveAccount(acct.id))}
                      className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-primary-50 text-primary-700'
                          : 'text-stone-700 hover:bg-stone-50'
                      }`}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{acct.label}</span>
                        <span className="truncate text-[11px] text-stone-400">
                          {acct.status}
                          {acct.lastError ? ` • ${acct.lastError}` : ''}
                        </span>
                      </span>
                      {unread > 0 && (
                        <span className="rounded-full bg-coral-500 px-1.5 text-[10px] font-semibold text-white">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {active && (
          <div className="border-t border-stone-200 p-3">
            <button
              onClick={() => handleRemove(active.id)}
              className="w-full rounded-md border border-coral-200 bg-white px-3 py-1.5 text-xs font-medium text-coral-600 hover:bg-coral-50">
              Remove {active.label}
            </button>
          </div>
        )}
      </aside>

      {/* Main pane */}
      <main className="flex min-w-0 flex-1 flex-col">
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-sm text-stone-400">
            Select or add an account to get started.
          </div>
        ) : (
          <>
            <div className="flex-1">
              <WebviewHost accountId={active.id} provider={active.provider} />
            </div>
          </>
        )}
      </main>

      <AddAccountModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onPick={handlePickProvider}
      />
    </div>
  );
};

export default Accounts;
