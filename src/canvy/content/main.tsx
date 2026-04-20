import { extractCanvasContext } from './canvas';
import { hideWorkflowOverlay, showWorkflowOverlay } from './overlay/overlayRoot';
import { extractPageContext } from './pageContext';
import { scanCurrentPage } from './scan';
import { detectPageType } from '../shared/lms';
import type { OverlayUpdateResponse, PingResponse, WorkflowState } from '../shared/types';

const INIT_FLAG = '__makoIqContentInitialized';

function logContent(event: string, payload: Record<string, unknown> = {}) {
  console.info(`[Mako IQ content] ${event}`, payload);
}

function handleRuntimeMessage(message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
  if (message?.type === 'CANVY_PING') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'ping';
    const response: PingResponse = {
      ok: true,
      requestId,
      pageType: detectPageType(window.location.href),
      url: window.location.href
    };

    logContent('Ping received.', {
      requestId,
      pageType: response.pageType,
      url: response.url
    });

    sendResponse(response);
    return;
  }

  if (message?.type === 'CANVY_EXTRACT_PAGE_CONTEXT') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'page-context';
    const context = extractPageContext();

    logContent('Page context extracted.', {
      requestId,
      title: context.title,
      pageType: context.pageType
    });

    sendResponse(context);
    return;
  }

  if (message?.type === 'CANVY_EXTRACT_CONTEXT') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'canvas-context';
    const context = extractCanvasContext();

    logContent('Canvas context extracted.', {
      requestId,
      pageKind: context?.pageKind ?? 'none',
      courseName: context?.courseName ?? ''
    });

    sendResponse(context);
    return;
  }

  if (message?.type === 'CANVY_SCAN_PAGE') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'scan-page';
    const sourceType = message.sourceType === 'tone_sample' ? 'tone_sample' : 'reference';
    const page = scanCurrentPage(sourceType);

    logContent('Page scan completed.', {
      requestId,
      title: page.title,
      pageType: page.pageType,
      mode: page.mode,
      textLength: page.readableText.length
    });

    sendResponse(page);
    return;
  }

  if (message?.type === 'CANVY_SHOW_WORKFLOW_OVERLAY') {
    const workflowState = message.workflowState as WorkflowState | undefined;
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'overlay-show';
    logContent('Overlay message received.', {
      requestId,
      workflowType: workflowState?.currentWorkflow ?? 'none',
      actionId: workflowState?.currentAction ?? 'none'
    });
    if (!workflowState?.outputShell) {
      sendResponse({
        ok: false,
        visible: false,
        reason: 'no_output_payload',
        message: 'The workflow output payload was empty, so the overlay was not shown.'
      } satisfies OverlayUpdateResponse);
      return;
    }

    try {
      const response = showWorkflowOverlay(workflowState);
      logContent('Overlay render response sent.', {
        ...response
      });
      sendResponse(response);
    } catch (error) {
      console.error('[Mako IQ content] Overlay render threw an error.', error);
      sendResponse({
        ok: false,
        visible: false,
        reason: 'overlay_render_failed',
        message: error instanceof Error ? error.message : 'Mako IQ could not show the page overlay.'
      } satisfies OverlayUpdateResponse);
    }
    return;
  }

  if (message?.type === 'CANVY_HIDE_WORKFLOW_OVERLAY') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'overlay-hide';
    logContent('Overlay hide message received.', {
      requestId
    });
    try {
      const response = hideWorkflowOverlay();
      logContent('Overlay hide response sent.', {
        ...response
      });
      sendResponse(response);
    } catch (error) {
      console.error('[Mako IQ content] Overlay hide threw an error.', error);
      sendResponse({
        ok: false,
        visible: false,
        reason: 'overlay_render_failed',
        message: error instanceof Error ? error.message : 'Mako IQ could not hide the page overlay.'
      } satisfies OverlayUpdateResponse);
    }
    return;
  }
}

if (!(globalThis as Record<string, unknown>)[INIT_FLAG]) {
  (globalThis as Record<string, unknown>)[INIT_FLAG] = true;
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  logContent('Content bridge initialized.', {
    url: window.location.href,
    pageType: detectPageType(window.location.href)
  });
}
