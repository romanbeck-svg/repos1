import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import overlayCss from '../../shared/app.css?inline';
import type { WorkflowState } from '../../shared/types';
import { CanvyOutputOverlay } from './CanvyOutputOverlay';
import { mapWorkflowStateToOverlay } from './mapWorkflowStateToOverlay';
import type { OverlayControllerResult, OverlayControllerState, OverlayRootStatus } from './types';

const OVERLAY_HOST_ID = 'canvy-output-overlay-host';

const OVERLAY_STYLES = `
  :host {
    all: initial;
    color-scheme: dark;
  }

  ${overlayCss}

  .mako-overlay-root {
    font-family: var(--mako-font-body, -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", sans-serif);
    color: var(--mako-text-primary, #F4FBFF);
  }
`;

let root: Root | null = null;
let mountNode: HTMLElement | null = null;
let state: OverlayControllerState = {
  workflowState: null
};

function logOverlay(event: string, payload: Record<string, unknown> = {}) {
  console.info(`[Mako IQ overlay] ${event}`, payload);
}

function ensureOverlayRoot(): OverlayRootStatus | null {
  if (root && mountNode) {
    return {
      hostState: 'reused'
    };
  }

  try {
    let host = document.getElementById(OVERLAY_HOST_ID);
    const createdHost = !host;

    if (!host) {
      host = document.createElement('div');
      host.id = OVERLAY_HOST_ID;
      host.style.position = 'fixed';
      host.style.inset = '0';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      document.documentElement.appendChild(host);
    }

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    if (!shadowRoot.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = OVERLAY_STYLES;
      shadowRoot.appendChild(style);
    }

    mountNode = shadowRoot.querySelector<HTMLElement>('[data-canvy-overlay-root]');
    if (!mountNode) {
      mountNode = document.createElement('div');
      mountNode.setAttribute('data-canvy-overlay-root', 'true');
      shadowRoot.appendChild(mountNode);
    }

    root = createRoot(mountNode);

    return {
      hostState: createdHost ? 'created' : 'reused'
    };
  } catch (error) {
    console.error('[Mako IQ overlay] Overlay root creation failed.', error);
    return null;
  }
}

function renderOverlay(): OverlayControllerResult {
  const rootStatus = ensureOverlayRoot();
  if (!rootStatus) {
    return {
      ok: false,
      visible: false,
      reason: 'overlay_root_creation_failed',
      message: 'Mako IQ could not create the page overlay root.'
    };
  }

  if (!root || !state.workflowState) {
    const overlayRoot = root;
    if (overlayRoot) {
      flushSync(() => {
        overlayRoot.render(null);
      });
    }
    return {
      ok: true,
      visible: false,
      message: 'Mako IQ overlay cleared.',
      hostState: rootStatus.hostState
    };
  }

  try {
    const model = mapWorkflowStateToOverlay(state.workflowState);
    const overlayRoot = root;
    if (!overlayRoot) {
      return {
        ok: false,
        visible: false,
        reason: 'overlay_root_creation_failed',
        message: 'Mako IQ could not access the overlay root after creating it.',
        hostState: rootStatus.hostState
      };
    }

    flushSync(() => {
      overlayRoot.render(
        <CanvyOutputOverlay
          model={model}
          onClose={() => hideWorkflowOverlay()}
        />
      );
    });

    window.requestAnimationFrame(() => {
      logOverlay('Overlay rendered successfully', {
        workflowType: state.workflowState?.currentWorkflow ?? 'none',
        actionId: state.workflowState?.currentAction ?? 'none',
        displayState: model.displayState
      });
    });

    return {
      ok: true,
      visible: true,
      reason: model.displayState === 'fallback' ? 'invalid_ai_output' : undefined,
      message:
        model.displayState === 'answer'
          ? 'Mako IQ rendered a mapped answer and assistant window on the page.'
          : 'Mako IQ rendered the assistant window with a conservative fallback state.',
      hostState: rootStatus.hostState
    };
  } catch (error) {
    console.error('[Mako IQ overlay] Overlay render failure.', error);
    return {
      ok: false,
      visible: false,
      reason: 'overlay_render_failed',
      message: error instanceof Error ? error.message : 'Mako IQ could not render the page overlay.',
      hostState: rootStatus.hostState
    };
  }
}

export function showWorkflowOverlay(workflowState: WorkflowState): OverlayControllerResult {
  state = {
    workflowState
  };
  const result = renderOverlay();
  logOverlay('Workflow overlay shown.', {
    workflowType: workflowState.currentWorkflow,
    actionId: workflowState.currentAction,
    ok: result.ok,
    visible: result.visible
  });
  return result;
}

export function hideWorkflowOverlay(): OverlayControllerResult {
  const previousWorkflowType = state.workflowState?.currentWorkflow;
  state = {
    workflowState: null
  };
  const result = renderOverlay();
  logOverlay('Workflow overlay hidden.', {
    workflowType: previousWorkflowType ?? 'none'
  });
  return result;
}
