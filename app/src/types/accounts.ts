export type AccountProvider = 'whatsapp';

export type AccountStatus = 'pending' | 'open' | 'error' | 'closed';

export interface Account {
  id: string;
  provider: AccountProvider;
  label: string;
  createdAt: string;
  status: AccountStatus;
  lastError?: string;
}

export interface IngestedMessage {
  id: string;
  from?: string | null;
  body?: string | null;
  unread?: number;
  ts?: number;
}

export interface AccountsState {
  accounts: Record<string, Account>;
  order: string[];
  activeAccountId: string | null;
  messages: Record<string, IngestedMessage[]>;
  unread: Record<string, number>;
  logs: Record<string, AccountLogEntry[]>;
}

export interface AccountLogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  msg: string;
}

export interface ProviderDescriptor {
  id: AccountProvider;
  label: string;
  description: string;
  serviceUrl: string;
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp Web',
    description: 'Open web.whatsapp.com inside the app and stream chat updates.',
    serviceUrl: 'https://web.whatsapp.com/',
  },
];
