import type { McpUiResource } from './types';

/** The sandbox proxy URL on the widget origin, carrying the declared CSP. */
export function widgetProxyUrl(csp: McpUiResource['csp'] | undefined, windows: boolean): string {
  const base = windows ? 'http://ohwidget.localhost/proxy' : 'ohwidget://localhost/proxy';
  const query = new URLSearchParams();
  for (const origin of csp?.connect_domains ?? []) query.append('connect', origin);
  for (const origin of csp?.resource_domains ?? []) query.append('resource', origin);
  const encoded = query.toString();
  return encoded ? `${base}?${encoded}` : base;
}

export function isWindowsHost(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}
