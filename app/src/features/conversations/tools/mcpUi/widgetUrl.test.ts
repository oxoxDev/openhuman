import { describe, expect, it } from 'vitest';

import { widgetProxyUrl } from './widgetUrl';

describe('widgetProxyUrl', () => {
  it('uses the platform origin and carries the declared origins', () => {
    expect(widgetProxyUrl(undefined, false)).toBe('ohwidget://localhost/proxy');
    expect(
      widgetProxyUrl(
        {
          connect_domains: ['https://api.example.com'],
          resource_domains: ['https://cdn.example.com'],
        },
        true
      )
    ).toBe(
      'http://ohwidget.localhost/proxy?connect=https%3A%2F%2Fapi.example.com&resource=https%3A%2F%2Fcdn.example.com'
    );
  });
});
