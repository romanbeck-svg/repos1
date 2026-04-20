import { createRoot, type Root } from 'react-dom/client';
import type { WorkflowState } from '../../shared/types';
import { CanvyOutputOverlay } from './CanvyOutputOverlay';
import { mapWorkflowStateToOverlay } from './mapWorkflowStateToOverlay';
import type { OverlayControllerResult, OverlayControllerState, OverlayRootStatus } from './types';

const OVERLAY_HOST_ID = 'canvy-output-overlay-host';

const OVERLAY_STYLES = `
  :host {
    all: initial;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  button,
  input {
    font: inherit;
  }

  .canvy-overlay-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
    font-family: "Aptos", "Segoe UI Variable Text", "Segoe UI", sans-serif;
  }

  .canvy-overlay-shell {
    pointer-events: auto;
    position: fixed;
    top: 18px;
    right: 18px;
    width: min(388px, calc(100vw - 24px));
    display: grid;
    gap: 12px;
    padding: 14px;
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.5);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.26) 0%, rgba(245, 249, 255, 0.2) 100%);
    color: #11233f;
    box-shadow: 0 18px 48px rgba(18, 35, 75, 0.1);
    backdrop-filter: blur(20px) saturate(130%);
    -webkit-backdrop-filter: blur(20px) saturate(130%);
  }

  .canvy-overlay-shell-test {
    background: rgba(20, 25, 37, 0.7);
    color: #f7faff;
    border-color: rgba(255, 210, 77, 0.7);
  }

  .canvy-overlay-close {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.28);
    color: inherit;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
  }

  .canvy-overlay-section {
    display: grid;
    gap: 8px;
  }

  .canvy-overlay-section-secondary {
    padding-top: 4px;
  }

  .canvy-overlay-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(17, 35, 63, 0.66);
  }

  .canvy-overlay-eyebrow-secondary {
    color: rgba(17, 35, 63, 0.58);
  }

  .canvy-overlay-answer,
  .canvy-overlay-list,
  .canvy-overlay-status {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: inherit;
  }

  .canvy-overlay-answer {
    padding-right: 28px;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: pre-wrap;
  }

  .canvy-overlay-status {
    font-size: 12px;
    line-height: 1.45;
    color: rgba(17, 35, 63, 0.72);
  }

  .canvy-overlay-status-error {
    color: #7c2d12;
  }

  .canvy-overlay-list {
    padding-left: 18px;
    color: rgba(17, 35, 63, 0.8);
  }

  .canvy-overlay-list li + li {
    margin-top: 4px;
  }

  .canvy-overlay-composer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
    padding-top: 10px;
    border-top: 1px solid rgba(17, 35, 63, 0.08);
  }

  .canvy-overlay-followup-input {
    flex: 1;
    min-width: 0;
    padding: 11px 12px;
    border: 1px solid rgba(17, 35, 63, 0.1);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.42);
    color: #11233f;
    outline: none;
  }

  .canvy-overlay-followup-input:focus {
    border-color: rgba(19, 115, 255, 0.38);
    box-shadow: 0 0 0 3px rgba(19, 115, 255, 0.12);
  }

  .canvy-overlay-submit,
  .canvy-overlay-cancel {
    border: 0;
    border-radius: 14px;
    padding: 10px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .canvy-overlay-submit {
    background: linear-gradient(135deg, #2d7ff9 0%, #1456cc 100%);
    color: #ffffff;
  }

  .canvy-overlay-cancel {
    background: rgba(17, 35, 63, 0.08);
    color: #173a78;
  }

  .canvy-overlay-submit:disabled,
  .canvy-overlay-cancel:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .canvy-overlay-caret {
    display: inline-block;
    width: 0.72ch;
    margin-left: 1px;
    border-right: 2px solid #1456cc;
    vertical-align: text-bottom;
    animation: canvy-overlay-caret-blink 1s steps(1) infinite;
  }

  @keyframes canvy-overlay-caret-blink {
    0%,
    49% {
      opacity: 1;
    }

    50%,
    100% {
      opacity: 0;
    }
  }

  @media (max-width: 720px) {
    .canvy-overlay-shell {
      top: auto;
      right: 8px;
      bottom: 8px;
      width: calc(100vw - 16px);
      border-radius: 20px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .canvy-overlay-caret {
      animation: none;
    }
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
    root?.render(null);
    return {
      ok: true,
      visible: false,
      message: 'Mako IQ overlay cleared.',
      hostState: rootStatus.hostState
    };
  }

  try {
    const model = mapWorkflowStateToOverlay(state.workflowState);
    root.render(
      <CanvyOutputOverlay
        model={model}
        onClose={() => hideWorkflowOverlay()}
      />
    );

    window.requestAnimationFrame(() => {
      logOverlay('Overlay rendered successfully', {
        workflowType: state.workflowState?.currentWorkflow ?? 'none',
        actionId: state.workflowState?.currentAction ?? 'none'
      });
    });

    return {
      ok: true,
      visible: true,
      message: 'Mako IQ overlay rendered on the page.',
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
