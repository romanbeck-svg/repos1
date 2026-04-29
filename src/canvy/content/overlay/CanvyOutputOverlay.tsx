import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createDefaultOverlayUiState, STORAGE_KEYS } from '../../shared/constants';
import {
  FollowUpComposer,
  FloatingPanel,
  GhostButton,
  GlassIconButton,
  Icon,
  InlineNotice,
  StatusPill
} from '../../shared/components/ui';
import { sendRuntimeMessage } from '../../shared/runtime';
import { useReducedMotionPreference } from '../../shared/hooks/useDripReveal';
import type { CanvySettings, OverlayUiState, StartAnalysisResponse } from '../../shared/types';
import type { OverlayQuestionViewModel, WorkflowOverlayProps } from './types';

const HIGHLIGHT_STYLE_ID = 'mako-question-highlight-style';
const HIGHLIGHT_CLASS = 'mako-question-highlight';
const HIGHLIGHT_ACTIVE_CLASS = 'mako-question-highlight--active';
const VIEWPORT_MARGIN = 16;
const BUBBLE_GAP = 18;
const DEFAULT_BUBBLE_WIDTH = 360;
const DEFAULT_BUBBLE_HEIGHT = 232;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 280;
const FOLLOW_UP_PLACEHOLDER = 'Ask a follow-up...';

const HIGHLIGHT_CSS = `
  [data-mako-question-anchor].${HIGHLIGHT_CLASS} {
    position: relative !important;
    border-radius: 18px;
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.14), rgba(15, 23, 32, 0.12)) !important;
    box-shadow:
      0 0 0 1px rgba(34, 211, 238, 0.18),
      0 14px 34px rgba(5, 7, 10, 0.18) !important;
    transition:
      box-shadow 180ms ease,
      background 180ms ease,
      outline-color 180ms ease;
    outline: 1px solid rgba(34, 211, 238, 0.16);
    outline-offset: 4px;
  }

  [data-mako-question-anchor].${HIGHLIGHT_ACTIVE_CLASS} {
    background: linear-gradient(180deg, rgba(34, 211, 238, 0.18), rgba(15, 23, 32, 0.18)) !important;
    box-shadow:
      0 0 0 1px rgba(34, 211, 238, 0.28),
      0 18px 40px rgba(5, 7, 10, 0.24) !important;
    outline-color: rgba(34, 211, 238, 0.26);
  }
`;

type OverlayPlacement = 'right' | 'left' | 'bottom' | 'top' | 'dock-right' | 'dock-left';

interface OverlayPosition {
  left: number;
  top: number;
  placement: OverlayPlacement;
}

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function sanitizeText(value: string | null | undefined, fallback = '') {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isInteractivePointerTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button, input, textarea, select, a, [role="button"]'));
}

function createViewportOverlayUiState() {
  const base = createDefaultOverlayUiState();
  return {
    ...base,
    left: Math.max(VIEWPORT_MARGIN, window.innerWidth - base.width - VIEWPORT_MARGIN),
    top: Math.max(VIEWPORT_MARGIN, 88)
  };
}

function clampWindowPosition(uiState: OverlayUiState) {
  const maxWidth = Math.max(MIN_WINDOW_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = clamp(uiState.width || createViewportOverlayUiState().width, MIN_WINDOW_WIDTH, maxWidth);
  const height = clamp(uiState.height || createViewportOverlayUiState().height, MIN_WINDOW_HEIGHT, maxHeight);
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxTop = Math.max(
    VIEWPORT_MARGIN,
    window.innerHeight - (uiState.collapsed ? 72 : height) - VIEWPORT_MARGIN
  );

  return {
    ...uiState,
    width,
    height,
    left: clamp(uiState.left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(uiState.top, VIEWPORT_MARGIN, maxTop)
  };
}

function findAnchorElement(sourceAnchor: string) {
  const anchor = sanitizeText(sourceAnchor);
  if (!anchor) {
    return null;
  }

  return document.querySelector<HTMLElement>(`[data-mako-question-anchor="${anchor}"]`);
}

function intersectionArea(
  leftRect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
  rightRect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>
) {
  const width = Math.max(0, Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left));
  const height = Math.max(0, Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top));
  return width * height;
}

function buildBubbleRect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
}

function clampBubblePosition(left: number, top: number, width: number, height: number) {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);

  return {
    left: clamp(left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(top, VIEWPORT_MARGIN, maxTop)
  };
}

function computeAnchoredPosition(anchorRect: DOMRect, bubbleWidth: number, bubbleHeight: number): OverlayPosition {
  const candidates: Array<{ placement: OverlayPlacement; left: number; top: number }> = [
    {
      placement: 'right',
      left: anchorRect.right + BUBBLE_GAP,
      top: anchorRect.top + anchorRect.height / 2 - bubbleHeight / 2
    },
    {
      placement: 'left',
      left: anchorRect.left - bubbleWidth - BUBBLE_GAP,
      top: anchorRect.top + anchorRect.height / 2 - bubbleHeight / 2
    },
    {
      placement: 'bottom',
      left: anchorRect.left + anchorRect.width / 2 - bubbleWidth / 2,
      top: anchorRect.bottom + BUBBLE_GAP
    },
    {
      placement: 'top',
      left: anchorRect.left + anchorRect.width / 2 - bubbleWidth / 2,
      top: anchorRect.top - bubbleHeight - BUBBLE_GAP
    }
  ];

  let best = {
    placement: 'dock-right' as OverlayPlacement,
    left: Math.max(VIEWPORT_MARGIN, window.innerWidth - bubbleWidth - VIEWPORT_MARGIN),
    top: clamp(
      anchorRect.top,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, window.innerHeight - bubbleHeight - VIEWPORT_MARGIN)
    ),
    score: Number.POSITIVE_INFINITY
  };

  for (const candidate of candidates) {
    const clamped = clampBubblePosition(candidate.left, candidate.top, bubbleWidth, bubbleHeight);
    const bubbleRect = buildBubbleRect(clamped.left, clamped.top, bubbleWidth, bubbleHeight);
    const overlap = intersectionArea(anchorRect, bubbleRect);
    const displacement = Math.abs(clamped.left - candidate.left) + Math.abs(clamped.top - candidate.top);
    const score = overlap * 4 + displacement;

    if (score < best.score) {
      best = {
        placement: candidate.placement,
        left: clamped.left,
        top: clamped.top,
        score
      };
    }
  }

  if (best.score > 3_500) {
    const prefersLeftDock = anchorRect.left > window.innerWidth / 2;
    const dockLeft = prefersLeftDock
      ? VIEWPORT_MARGIN
      : Math.max(VIEWPORT_MARGIN, window.innerWidth - bubbleWidth - VIEWPORT_MARGIN);

    return {
      placement: prefersLeftDock ? 'dock-left' : 'dock-right',
      left: dockLeft,
      top: clamp(
        anchorRect.top,
        VIEWPORT_MARGIN,
        Math.max(VIEWPORT_MARGIN, window.innerHeight - bubbleHeight - VIEWPORT_MARGIN)
      )
    };
  }

  return {
    placement: best.placement,
    left: best.left,
    top: best.top
  };
}

function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

function TestOverlay({ model, onClose }: WorkflowOverlayProps) {
  return (
    <div className="mako-overlay-root">
      <section
        className="mako-overlay-window"
        style={{
          left: Math.max(VIEWPORT_MARGIN, window.innerWidth - 420 - VIEWPORT_MARGIN),
          top: VIEWPORT_MARGIN
        }}
      >
        <div className="mako-overlay-window__topbar">
          <div className="mako-overlay-window__headline">
            <div className="mako-overlay-window__caption">Mako IQ</div>
            <h2 className="mako-overlay-window__title">Overlay test</h2>
          </div>
          <GlassIconButton icon={<Icon name="close" size={15} />} label="Close Mako IQ overlay" onClick={onClose} />
        </div>

        <div className="mako-overlay-window__section">
          <div className="mako-overlay-window__section-label">Recommended answer</div>
          <p className="mako-overlay-window__answer">
            {sanitizeText(model.fallbackMessage, 'The overlay renderer is responding.')}
          </p>
        </div>

        <div className="mako-overlay-window__section">
          <div className="mako-overlay-window__section-label">Suggested notes</div>
          <ul className="mako-overlay-window__notes">
            {(model.fallbackNotes.length ? model.fallbackNotes : ['The floating assistant is rendering inside the page.']).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function OverlayAnswerBubble({
  activeQuestion,
  model,
  position,
  activeIndex,
  totalQuestions,
  onPrevious,
  onNext,
  followUpValue,
  onFollowUpChange,
  onFollowUpSubmit,
  isSubmitting,
  onOpenWorkspace,
  onPinAssistant,
  onClose
}: {
  activeQuestion: OverlayQuestionViewModel;
  model: WorkflowOverlayProps['model'];
  position: OverlayPosition;
  activeIndex: number;
  totalQuestions: number;
  followUpValue: string;
  onFollowUpChange: (value: string) => void;
  onFollowUpSubmit: () => void;
  isSubmitting: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onOpenWorkspace: () => void;
  onPinAssistant: () => void;
  onClose: () => void;
}) {
  return (
    <FloatingPanel
      animated={false}
      tone="elevated"
      className="mako-overlay-bubble"
      data-placement={position.placement}
      style={{ left: position.left, top: position.top }}
      aria-label="Mako IQ mapped answer"
    >
      <div className="mako-overlay-bubble__header">
        <div>
          <div className="mako-overlay-bubble__eyebrow">Recommended answer</div>
          <div className="mako-overlay-bubble__meta">
            {activeIndex + 1} of {totalQuestions} | {model.sourceTitle}
          </div>
          <StatusPill label={model.statusLabel} tone={model.statusTone} />
        </div>

        <div className="mako-overlay-bubble__controls">
          {totalQuestions > 1 ? (
            <>
              <GlassIconButton icon={<Icon name="chevron-left" size={14} />} label="Previous question" onClick={onPrevious} />
              <GlassIconButton icon={<Icon name="chevron-right" size={14} />} label="Next question" onClick={onNext} />
            </>
          ) : null}
          <GlassIconButton icon={<Icon name="pin" size={14} />} label="Pin assistant window" onClick={onPinAssistant} />
          <GlassIconButton icon={<Icon name="workspace" size={14} />} label="Open full workspace" onClick={onOpenWorkspace} />
          <GlassIconButton icon={<Icon name="close" size={14} />} label="Close overlay" onClick={onClose} />
        </div>
      </div>

      <p className="mako-overlay-bubble__question">{activeQuestion.question}</p>
      <p className="mako-overlay-bubble__answer">{activeQuestion.answer}</p>

      <div className="mako-overlay-bubble__notes-block">
        <div className="mako-overlay-bubble__notes-label">Suggested notes</div>
        <ul className="mako-overlay-bubble__notes">
          {activeQuestion.notes.slice(0, 3).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>

      <FollowUpComposer
        id="mako-overlay-bubble-followup"
        className="mako-overlay-bubble__composer"
        inputClassName="mako-overlay-input"
        label="Ask another question"
        value={followUpValue}
        onChange={onFollowUpChange}
        onSubmit={onFollowUpSubmit}
        submitLabel="Ask"
        disabled={isSubmitting || !followUpValue.trim()}
        loading={isSubmitting}
        placeholder={FOLLOW_UP_PLACEHOLDER}
        footer={undefined}
      />
    </FloatingPanel>
  );
}

export function CanvyOutputOverlay({ model, onClose }: WorkflowOverlayProps) {
  const reducedMotion = useReducedMotionPreference();
  const [settings, setSettings] = useState<CanvySettings | null>(null);
  const [uiState, setUiState] = useState<OverlayUiState>(createViewportOverlayUiState());
  const [activeIndex, setActiveIndex] = useState(0);
  const [bubblePosition, setBubblePosition] = useState<OverlayPosition>({
    left: Math.max(VIEWPORT_MARGIN, window.innerWidth - DEFAULT_BUBBLE_WIDTH - VIEWPORT_MARGIN),
    top: VIEWPORT_MARGIN,
    placement: 'dock-right'
  });
  const [followUpValue, setFollowUpValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [transientStatus, setTransientStatus] = useState('');
  const bubbleRef = useRef<HTMLElement | null>(null);
  const windowRef = useRef<HTMLElement | null>(null);
  const uiStateRef = useRef<OverlayUiState>(uiState);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
  } | null>(null);

  const motionEnabled = (settings?.motionEnabled ?? true) && !reducedMotion;
  const hasMappedAnswer = model.displayState === 'answer' && model.questions.length > 0;
  const activeQuestion = model.questions[activeIndex] ?? model.questions[0] ?? null;
  const windowStatus = transientStatus || model.statusLabel;

  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      try {
        const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.overlayUi]);
        if (!mounted) {
          return;
        }

        setSettings((stored[STORAGE_KEYS.settings] as CanvySettings | undefined) ?? null);
        setUiState(
          clampWindowPosition({
            ...createViewportOverlayUiState(),
            ...((stored[STORAGE_KEYS.overlayUi] as OverlayUiState | undefined) ?? {})
          })
        );
      } catch (error) {
        console.error('[Mako IQ overlay] Failed to read overlay state.', error);
      }
    }

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName
    ) => {
      if (areaName !== 'local') {
        return;
      }

      if (changes[STORAGE_KEYS.settings]) {
        setSettings((changes[STORAGE_KEYS.settings].newValue as CanvySettings | undefined) ?? null);
      }

      if (changes[STORAGE_KEYS.overlayUi]) {
        setUiState(
          clampWindowPosition({
            ...createViewportOverlayUiState(),
            ...((changes[STORAGE_KEYS.overlayUi].newValue as OverlayUiState | undefined) ?? {})
          })
        );
      }
    };

    void hydrate();
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
    setTransientStatus('');
  }, [model.updatedAt]);

  useEffect(() => {
    if (!model.isTestOverlay && hasMappedAnswer) {
      ensureHighlightStyle();
    }
  }, [hasMappedAnswer, model.isTestOverlay]);

  useEffect(() => {
    if (model.isTestOverlay || !hasMappedAnswer) {
      return undefined;
    }

    const elements = Array.from(
      new Set(
        model.questions
          .map((question) => findAnchorElement(question.sourceAnchor))
          .filter((element): element is HTMLElement => Boolean(element))
      )
    );
    const activeElement = activeQuestion ? findAnchorElement(activeQuestion.sourceAnchor) : null;

    for (const element of elements) {
      element.classList.add(HIGHLIGHT_CLASS);
    }

    activeElement?.classList.add(HIGHLIGHT_ACTIVE_CLASS);

    return () => {
      for (const element of elements) {
        element.classList.remove(HIGHLIGHT_CLASS);
        element.classList.remove(HIGHLIGHT_ACTIVE_CLASS);
      }
    };
  }, [activeQuestion, hasMappedAnswer, model.isTestOverlay, model.questions]);

  useEffect(() => {
    const onResize = () => {
      setUiState((current) => clampWindowPosition(current));
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    if (model.isTestOverlay || !hasMappedAnswer || !activeQuestion) {
      return undefined;
    }

    const anchor = findAnchorElement(activeQuestion.sourceAnchor);
    const bubble = bubbleRef.current;

    if (!anchor || !bubble) {
      return undefined;
    }

    let resizeObserver: ResizeObserver | null = null;

    const updatePosition = () => {
      const currentAnchor = findAnchorElement(activeQuestion.sourceAnchor);
      const currentBubble = bubbleRef.current;
      if (!currentAnchor || !currentBubble) {
        return;
      }

      const anchorRect = currentAnchor.getBoundingClientRect();
      const bubbleWidth = Math.max(DEFAULT_BUBBLE_WIDTH, currentBubble.offsetWidth || 0);
      const bubbleHeight = Math.max(DEFAULT_BUBBLE_HEIGHT, currentBubble.offsetHeight || 0);
      setBubblePosition(computeAnchoredPosition(anchorRect, bubbleWidth, bubbleHeight));
    };

    updatePosition();
    const rafId = window.requestAnimationFrame(updatePosition);
    const onViewportChange = () => updatePosition();

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    resizeObserver = new ResizeObserver(() => updatePosition());
    resizeObserver.observe(bubble);
    resizeObserver.observe(anchor);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      resizeObserver?.disconnect();
    };
  }, [activeQuestion, hasMappedAnswer, model.isTestOverlay]);

  async function persistOverlayUi(nextState: OverlayUiState) {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.overlayUi]: nextState
      });
    } catch (error) {
      console.error('[Mako IQ overlay] Failed to persist overlay position.', error);
    }
  }

  function handleWindowPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || uiState.collapsed || isInteractivePointerTarget(event.target)) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: uiState.left,
      originTop: uiState.top
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleWindowPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const nextState = clampWindowPosition({
      ...uiStateRef.current,
      left: drag.originLeft + (event.clientX - drag.startX),
      top: drag.originTop + (event.clientY - drag.startY)
    });
    setUiState(nextState);
  }

  function handleWindowPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    void persistOverlayUi(uiStateRef.current);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || uiState.collapsed) {
      return;
    }

    event.stopPropagation();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originWidth: uiState.width,
      originHeight: uiState.height
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = resizeStateRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }

    const nextState = clampWindowPosition({
      ...uiStateRef.current,
      width: resize.originWidth + (event.clientX - resize.startX),
      height: resize.originHeight + (event.clientY - resize.startY)
    });
    setUiState(nextState);
  }

  function handleResizePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = resizeStateRef.current;
    if (!resize || resize.pointerId !== event.pointerId) {
      return;
    }

    resizeStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    void persistOverlayUi(uiStateRef.current);
  }

  function handleToggleCollapsed() {
    const nextState = clampWindowPosition({
      ...uiStateRef.current,
      collapsed: !uiStateRef.current.collapsed
    });
    setUiState(nextState);
    void persistOverlayUi(nextState);
  }

  function handlePinAssistant() {
    const nextState = clampWindowPosition({
      ...uiStateRef.current,
      collapsed: false
    });
    setUiState(nextState);
    void persistOverlayUi(nextState);
  }

  async function handleOpenWorkspace() {
    try {
      await sendRuntimeMessage({
        type: 'OPEN_SIDEPANEL',
        requestId: createRequestId()
      });
    } catch (error) {
      setTransientStatus(sanitizeText(error instanceof Error ? error.message : 'Could not open the workspace.'));
    }
  }

  async function handleFollowUpSubmit() {
    const instruction = followUpValue.trim();
    if (!instruction) {
      return;
    }

    setIsSubmitting(true);
    setTransientStatus('Working on a fresh answer...');

    try {
      const response = await sendRuntimeMessage<StartAnalysisResponse>({
        type: 'CANVY_START_ANALYSIS_RUN',
        requestId: createRequestId(),
        instruction
      });

      if (!response.ok) {
        setTransientStatus(response.error ?? response.message ?? 'Could not start the follow-up.');
        return;
      }

      setFollowUpValue('');
    } catch (error) {
      setTransientStatus(sanitizeText(error instanceof Error ? error.message : 'Could not start the follow-up.'));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (model.isTestOverlay) {
    return <TestOverlay model={model} onClose={onClose} />;
  }

  return (
    <div className={`mako-overlay-root ${motionEnabled ? '' : 'mako-app--no-motion'}`} aria-live="polite">
      {hasMappedAnswer && activeQuestion ? (
        <OverlayAnswerBubble
          activeQuestion={activeQuestion}
          model={model}
          position={bubblePosition}
          activeIndex={activeIndex}
          totalQuestions={model.questions.length}
          onPrevious={() =>
            setActiveIndex((current) => (current - 1 + model.questions.length) % model.questions.length)
          }
          onNext={() => setActiveIndex((current) => (current + 1) % model.questions.length)}
          followUpValue={followUpValue}
          onFollowUpChange={setFollowUpValue}
          onFollowUpSubmit={() => void handleFollowUpSubmit()}
          isSubmitting={isSubmitting}
          onOpenWorkspace={() => void handleOpenWorkspace()}
          onPinAssistant={handlePinAssistant}
          onClose={onClose}
        />
      ) : null}

      <section
        ref={windowRef}
        className={`mako-overlay-window ${uiState.collapsed ? 'mako-overlay-window--collapsed' : ''}`}
        style={{
          left: uiState.left,
          top: uiState.top,
          width: uiState.width,
          height: uiState.collapsed ? undefined : uiState.height
        }}
      >
        <div
          className="mako-overlay-window__topbar mako-overlay-window__drag"
          onPointerDown={handleWindowPointerDown}
          onPointerMove={handleWindowPointerMove}
          onPointerUp={handleWindowPointerUp}
          onPointerCancel={handleWindowPointerUp}
        >
          <div className="mako-overlay-window__headline">
            <div className="mako-overlay-window__caption">Mako IQ assistant</div>
            <h2 className="mako-overlay-window__title">
              {hasMappedAnswer && activeQuestion ? activeQuestion.question : model.fallbackTitle}
            </h2>
            <div className="mako-overlay-window__status-row">
              <StatusPill label={windowStatus} tone={model.statusTone} />
              {model.sourceTitle ? <span className="mako-overlay-window__source">{model.sourceTitle}</span> : null}
            </div>
          </div>

          <div className="mako-overlay-window__controls">
            <GlassIconButton
              icon={<Icon name="workspace" size={15} />}
              label="Open full workspace"
              onClick={() => void handleOpenWorkspace()}
            />
            <GlassIconButton
              icon={<Icon name="minimize" size={15} />}
              label={uiState.collapsed ? 'Expand assistant' : 'Minimize assistant'}
              onClick={handleToggleCollapsed}
            />
            <GlassIconButton icon={<Icon name="close" size={15} />} label="Close assistant" onClick={onClose} />
          </div>
        </div>

        <div className="mako-overlay-window__body">
          {transientStatus && !isSubmitting ? <InlineNotice tone="warning">{transientStatus}</InlineNotice> : null}

          <div className="mako-overlay-window__section">
            <div className="mako-overlay-window__section-label">Recommended answer</div>
            <p className="mako-overlay-window__answer">
              {hasMappedAnswer && activeQuestion ? activeQuestion.answer : model.fallbackMessage}
            </p>
          </div>

          <div className="mako-overlay-window__section">
            <div className="mako-overlay-window__section-label">Suggested notes</div>
            <ul className="mako-overlay-window__notes">
              {(hasMappedAnswer && activeQuestion ? activeQuestion.notes : model.fallbackNotes).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>

          {hasMappedAnswer && model.questions.length > 1 ? (
            <div className="mako-overlay-window__chips" aria-label="Mapped questions">
              {model.questions.map((question, index) => (
                <button
                  key={question.id}
                  type="button"
                  className={`mako-overlay-window__chip ${index === activeIndex ? 'mako-overlay-window__chip--active' : ''}`}
                  onClick={() => setActiveIndex(index)}
                >
                  Q{index + 1}
                </button>
              ))}
            </div>
          ) : null}

          <FollowUpComposer
            id="mako-overlay-followup"
            className="mako-overlay-window__composer"
            inputClassName="mako-overlay-input"
            label="Ask another question"
            value={followUpValue}
            onChange={setFollowUpValue}
            onSubmit={() => void handleFollowUpSubmit()}
            submitLabel={isSubmitting ? 'Working...' : 'Ask'}
            disabled={isSubmitting || !followUpValue.trim()}
            loading={isSubmitting}
            placeholder={FOLLOW_UP_PLACEHOLDER}
            footer={
              <div className="mako-overlay-window__actions">
                <GhostButton
                  size="sm"
                  onClick={() => void handleOpenWorkspace()}
                  leadingIcon={<Icon name="workspace" size={14} />}
                >
                  Open workspace
                </GhostButton>
              </div>
            }
          />
        </div>

        {!uiState.collapsed ? (
          <button
            type="button"
            className="mako-overlay-window__resize"
            aria-label="Resize assistant"
            title="Resize assistant"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
          />
        ) : null}
      </section>
    </div>
  );
}
