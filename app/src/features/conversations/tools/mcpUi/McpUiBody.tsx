import { isTauri } from '../../../../utils/tauriCommands/common';
import { LinkActions } from './LinkActions';
import { McpAppFrame } from './McpAppFrame';
import { hasWidget, readMcpUiPresentation } from './types';

/**
 * What a tool call that offered UI shows outside its collapsed card: the
 * widget, when there is one and this host can sandbox it, or otherwise the
 * links the result offered.
 */
export function McpUiBody({ structured }: { structured: unknown }) {
  const presentation = readMcpUiPresentation(structured);
  if (!presentation) return null;
  const showFrame = hasWidget(presentation) && isTauri();
  const showLinks = !showFrame && presentation.links.length > 0;
  if (!showFrame && !showLinks) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="mcp-ui-body">
      {showFrame ? <McpAppFrame presentation={presentation} /> : null}
      {showLinks ? <LinkActions links={presentation.links} /> : null}
    </div>
  );
}
