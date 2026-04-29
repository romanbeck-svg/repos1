import { extractCanvasContext } from './canvas';
import { hideAssistantPanel, showAssistantPanel } from './assistantPanel';
import { hideWorkflowOverlay, showWorkflowOverlay } from './overlay/overlayRoot';
import { extractPageContext } from './pageContext';
import { scanCurrentPage } from './scan';
import { handleQuizNavigationMessage, initializeQuizModeController } from './quiz/quizModeController';
import { buildScreenPageSignature, extractScreenTextContext } from './screenContext';
import { initializeScreenPageWatcher } from './screenPageWatcher';
import { clearAnswerBubbles, readViewport, renderAnswerBubbles, renderScreenScanStatus } from './screenBubbles';
import { detectPageType } from '../shared/lms';
import type { OverlayUpdateResponse, PingResponse, ScreenBubbleRenderPayload, WorkflowState } from '../shared/types';

const INIT_FLAG = '__makoIqContentInitialized';
const SCANNING_CLASS = 'mako-iq-scanning';
const SCANNING_STYLE_ID = 'mako-iq-scanning-style';
const SCANNING_STYLE = `
  html.${SCANNING_CLASS} #mako-iq-assistant-root,
  html.${SCANNING_CLASS} #mako-iq-overlay-root,
  html.${SCANNING_CLASS} #canvy-output-overlay-host,
  html.${SCANNING_CLASS} #walt-overlay-root {
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
`;

function logContent(event: string, payload: Record<string, unknown> = {}) {
  console.info(`[Mako IQ content] ${event}`, payload);
}

function waitForNextFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function setMakoUiHiddenForScan(hidden: boolean) {
  let style = document.getElementById(SCANNING_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = SCANNING_STYLE_ID;
    style.textContent = SCANNING_STYLE;
    document.documentElement.appendChild(style);
  }

  document.documentElement.classList.toggle(SCANNING_CLASS, hidden);
  await waitForNextFrame();
  if (hidden) {
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }
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

  if (message?.type === 'QUIZ_NAVIGATION_CHANGED') {
    const response = handleQuizNavigationMessage({
      url: typeof message.url === 'string' ? message.url : window.location.href,
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now()
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

  if (message?.type === 'SCREEN_SET_MAKO_UI_HIDDEN') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'screen-hide-ui';
    const hidden = Boolean(message.hidden);
    void setMakoUiHiddenForScan(hidden)
      .then(() => {
        logContent(hidden ? 'Mako UI hidden for screen scan.' : 'Mako UI restored after screen scan.', {
          requestId
        });
        sendResponse({
          ok: true,
          requestId,
          hidden
        });
      })
      .catch((error) => {
        console.error('[Mako IQ content] Could not update scan visibility.', error);
        sendResponse({
          ok: false,
          requestId,
          hidden: document.documentElement.classList.contains(SCANNING_CLASS),
          message: error instanceof Error ? error.message : 'Could not update scan visibility.'
        });
      });
    return true;
  }

  if (message?.type === 'SCREEN_GET_VIEWPORT') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'screen-viewport';
    const viewport = readViewport();
    logContent('Viewport read for screen analysis.', {
      requestId,
      width: viewport.width,
      height: viewport.height,
      devicePixelRatio: viewport.devicePixelRatio
    });
    sendResponse(viewport);
    return;
  }

  if (message?.type === 'SCREEN_EXTRACT_COMPACT_CONTEXT') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'screen-context';
    const context = extractScreenTextContext();
    logContent('Compact screen context extracted.', {
      requestId,
      textLength: context.visibleText.length,
      questionCandidateCount: context.questionCandidates.length
    });
    sendResponse(context);
    return;
  }

  if (message?.type === 'SCREEN_GET_PAGE_SIGNATURE') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'screen-page-signature';
    const pageSignature = buildScreenPageSignature();
    logContent('Screen page signature read.', {
      requestId,
      signatureLength: pageSignature.length
    });
    sendResponse({
      ok: true,
      requestId,
      pageSignature,
      url: window.location.href
    });
    return;
  }

  if (message?.type === 'RENDER_ANSWER_BUBBLES') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'render-answer-bubbles';
    const payload = message.payload as ScreenBubbleRenderPayload;
    logContent('Answer bubble render message received.', {
      requestId,
      itemCount: payload?.analysis?.items?.length ?? 0
    });
    void renderAnswerBubbles({
      ...payload,
      scanId: payload?.scanId ?? requestId
    })
      .then(sendResponse)
      .catch((error) => {
        console.error('[Mako IQ content] Answer bubble render failed.', error);
        sendResponse({
          ok: false,
          visible: false,
          reason: 'overlay_render_failed',
          message: error instanceof Error ? error.message : 'Mako IQ could not render answer bubbles.'
        } satisfies OverlayUpdateResponse);
      });
    return true;
  }

  if (message?.type === 'RENDER_SCREEN_SCAN_STATUS') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'screen-status';
    const status =
      message.status === 'thinking' ||
      message.status === 'success' ||
      message.status === 'partial' ||
      message.status === 'error' ||
      message.status === 'idle'
        ? message.status
        : 'scanning';
    const text =
      typeof message.message === 'string' && message.message.trim()
        ? message.message
        : status === 'thinking'
          ? 'Thinking...'
          : 'Scanning page...';
    logContent('Screen scan status render message received.', {
      requestId,
      status
    });
    try {
      sendResponse(
        renderScreenScanStatus(status, text, {
          requestId,
          questionHash: typeof message.questionHash === 'string' ? message.questionHash : undefined
        })
      );
    } catch (error) {
      console.error('[Mako IQ content] Screen scan status render failed.', error);
      sendResponse({
        ok: false,
        visible: false,
        reason: 'overlay_render_failed',
        message: error instanceof Error ? error.message : 'Mako IQ could not render scan status.'
      } satisfies OverlayUpdateResponse);
    }
    return;
  }

  if (message?.type === 'CLEAR_ANSWER_BUBBLES') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'clear-answer-bubbles';
    logContent('Answer bubble clear message received.', {
      requestId
    });
    try {
      sendResponse(clearAnswerBubbles());
    } catch (error) {
      console.error('[Mako IQ content] Answer bubble clear failed.', error);
      sendResponse({
        ok: false,
        visible: false,
        reason: 'overlay_render_failed',
        message: error instanceof Error ? error.message : 'Mako IQ could not clear answer bubbles.'
      } satisfies OverlayUpdateResponse);
    }
    return;
  }

  if (message?.type === 'SHOW_MAKO_ASSISTANT_PANEL') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'assistant-panel-show';
    logContent('Assistant panel show message received.', {
      requestId,
      autoScan: Boolean(message.autoScan)
    });
    hideWorkflowOverlay();
    void showAssistantPanel({ autoScan: Boolean(message.autoScan) })
      .then(sendResponse)
      .catch((error) => {
        console.error('[Mako IQ content] Assistant panel render failed.', error);
        sendResponse({
          ok: false,
          visible: false,
          reason: 'overlay_render_failed',
          message: error instanceof Error ? error.message : 'Mako IQ could not open the assistant panel.'
        } satisfies OverlayUpdateResponse);
      });
    return true;
  }

  if (message?.type === 'HIDE_MAKO_ASSISTANT_PANEL') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : 'assistant-panel-hide';
    logContent('Assistant panel hide message received.', {
      requestId
    });
    try {
      sendResponse(hideAssistantPanel());
    } catch (error) {
      console.error('[Mako IQ content] Assistant panel hide failed.', error);
      sendResponse({
        ok: false,
        visible: false,
        reason: 'overlay_render_failed',
        message: error instanceof Error ? error.message : 'Mako IQ could not close the assistant panel.'
      } satisfies OverlayUpdateResponse);
    }
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
      hideAssistantPanel();
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
  initializeQuizModeController();
  initializeScreenPageWatcher();
  logContent('Content bridge initialized.', {
    url: window.location.href,
    pageType: detectPageType(window.location.href)
  });
}
