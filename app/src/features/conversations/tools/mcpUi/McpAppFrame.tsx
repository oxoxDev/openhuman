import debug from 'debug';
import { useEffect, useMemo, useRef, useState } from 'react';

import Button from '../../../../components/ui/Button';
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog';
import { useT } from '../../../../lib/i18n/I18nContext';
import { mcpUiApi } from '../../../../services/api/mcpUiApi';
import { openUrl } from '../../../../utils/openUrl';
import { requestComposerPrefill } from './composerPrefill';
import { QrHandoff } from './LinkActions';
import { McpAppBridge } from './mcpAppBridge';
import type { McpUiPresentation, McpUiResource } from './types';
import { isWindowsHost, PROXY_FRAME_SANDBOX, widgetProxyUrl } from './widgetUrl';

const log = debug('mcp-ui:frame');

const DEFAULT_HEIGHT = 360;

interface PendingCall {
  name: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; resource: McpUiResource }
  | { status: 'unavailable' };

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function McpAppFrame({ presentation }: { presentation: McpUiPresentation }) {
  const { t, locale } = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [pending, setPending] = useState<PendingCall | null>(null);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  const serverId = presentation.server_id;

  useEffect(() => {
    let cancelled = false;
    mcpUiApi
      .resourceRead({
        serverId,
        uri: presentation.inline_id ? undefined : presentation.resource_uri,
        inlineId: presentation.inline_id,
      })
      .then(resource => {
        if (!cancelled) setState({ status: 'ready', resource });
      })
      .catch(error => {
        log('widget document unavailable: %s', error instanceof Error ? error.message : error);
        if (!cancelled) setState({ status: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, presentation.resource_uri, presentation.inline_id]);

  const resource = state.status === 'ready' ? state.resource : null;
  const src = useMemo(
    () => (resource ? widgetProxyUrl(resource.csp, isWindowsHost()) : null),
    [resource]
  );

  useEffect(() => {
    if (!resource) return;
    const bridge = new McpAppBridge({
      presentation,
      html: resource.html,
      theme: currentTheme(),
      locale,
      source: () => frameRef.current?.contentWindow,
      handlers: {
        callTool: async (name, args) => {
          if (!serverId) throw new Error('No server for this view');
          const first = await mcpUiApi.toolCall(serverId, name, args, false);
          if (!first.requires_confirmation) return first.result;
          await new Promise<unknown>((resolve, reject) =>
            setPending({ name, args, resolve, reject })
          );
          const confirmed = await mcpUiApi.toolCall(serverId, name, args, true);
          return confirmed.result;
        },
        openExternal: url => openUrl(url),
        handOff: url => setHandoffUrl(url),
        prefillMessage: text => requestComposerPrefill(text),
        readResource: async uri => {
          if (!serverId) throw new Error('No server for this view');
          const read = await mcpUiApi.resourceRead({ serverId, uri });
          return { contents: [{ uri, mimeType: read.mime_type, text: read.html }] };
        },
        resize: next => setHeight(next),
      },
    });
    const onMessage = (event: MessageEvent) => {
      bridge.handleMessage(event);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [resource, presentation, serverId, locale]);

  if (state.status === 'unavailable') {
    return (
      <p className="text-xs text-content-muted" data-testid="mcp-ui-unavailable">
        {t('conversations.mcpUi.widgetUnavailable')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="mcp-ui-frame">
      {state.status === 'loading' || !src ? (
        <p className="text-xs text-content-muted">{t('conversations.mcpUi.widgetLoading')}</p>
      ) : (
        <iframe
          ref={frameRef}
          src={src}
          title={presentation.title ?? t('conversations.mcpUi.widgetTitle')}
          sandbox={PROXY_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          allow=""
          className={
            resource?.prefers_border
              ? 'w-full rounded-lg border border-line bg-transparent'
              : 'w-full bg-transparent'
          }
          style={{ height }}
          data-testid="mcp-ui-iframe"
        />
      )}
      {handoffUrl ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-line p-3">
          <QrHandoff url={handoffUrl} hint={t('conversations.mcpUi.scanToOpen')} />
          <Button
            size="xs"
            variant="tertiary"
            analyticsId="mcp-ui-close-qr"
            onClick={() => setHandoffUrl(null)}>
            {t('conversations.mcpUi.hideQr')}
          </Button>
        </div>
      ) : null}
      {pending ? (
        <ConfirmDialog
          titleId="mcp-ui-confirm-title"
          title={t('conversations.mcpUi.confirmTitle')}
          body={t('conversations.mcpUi.confirmBody').replace('{tool}', pending.name)}
          confirmLabel={t('conversations.mcpUi.confirmAllow')}
          cancelLabel={t('conversations.mcpUi.confirmDeny')}
          testId="mcp-ui-confirm"
          onConfirm={() => {
            pending.resolve(undefined);
            setPending(null);
          }}
          onCancel={() => {
            pending.reject(new Error('The user declined this action'));
            setPending(null);
          }}
        />
      ) : null}
    </div>
  );
}
