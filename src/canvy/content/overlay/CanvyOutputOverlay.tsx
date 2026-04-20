import { type FormEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { m } from 'motion/react';
import { createDefaultOverlayUiState, STORAGE_KEYS } from '../../shared/constants';
import { GlassButton, IconButton, MotionProvider, StatusPill } from '../../shared/components/ui';
import { useDripReveal, useReducedMotionPreference } from '../../shared/hooks/useDripReveal';
import { sendRuntimeMessage } from '../../shared/runtime';
import type {
  AssignmentSessionState,
  CancelAnalysisResponse,
  CanvySettings,
  OverlayUiState,
  StartAnalysisResponse
} from '../../shared/types';
import type { WorkflowOverlayProps } from './types';

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

function sanitizeText(value: string | null | undefined, fallback = '') {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function sanitizeNotes(values: string[] | undefined, maxItems = 3) {
  return (values ?? [])
    .map((value) => sanitizeText(value))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeUrl(value: string | undefined) {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value, window.location.href);
    url.hash = '';
    return url.href;
  } catch {
    return value.replace(/#.*$/, '');
  }
}

function matchesCurrentPage(candidate: string | undefined, fallback: string | undefined) {
  const currentUrl = normalizeUrl(window.location.href);
  const candidateUrl = normalizeUrl(candidate);
  const fallbackUrl = normalizeUrl(fallback);
  return Boolean(candidateUrl && candidateUrl === currentUrl) || Boolean(fallbackUrl && fallbackUrl === currentUrl);
}

function clampOverlayUi(next: OverlayUiState): OverlayUiState {
  const minLeft = 8;
  const minTop = 8;
  const maxWidth = Math.max(320, window.innerWidth - 16);
  const maxHeight = Math.max(220, window.innerHeight - 16);
  const width = Math.min(Math.max(next.width, 320), maxWidth);
  const height = Math.min(Math.max(next.height, 220), maxHeight);
  const maxLeft = Math.max(minLeft, window.innerWidth - width - 8);
  const maxTop = Math.max(minTop, window.innerHeight - (next.collapsed ? 88 : height) - 8);

  return {
    ...next,
    width,
    height,
    left: Math.min(Math.max(next.left, minLeft), maxLeft),
    top: Math.min(Math.max(next.top, minTop), maxTop)
  };
}

async function persistOverlayUiState(next: OverlayUiState) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.overlayUi]: next
  });
}

export function CanvyOutputOverlay({ model, onClose }: WorkflowOverlayProps) {
  const [session, setSession] = useState<AssignmentSessionState | null>(null);
  const [settings, setSettings] = useState<CanvySettings | null>(null);
  const [overlayUi, setOverlayUi] = useState<OverlayUiState>(createDefaultOverlayUiState());
  const [followUp, setFollowUp] = useState('');
  const [submitPending, setSubmitPending] = useState(false);
  const [notice, setNotice] = useState('');
  const windowRef = useRef<HTMLElement | null>(null);
  const resizePersistTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originLeft: number; originTop: number } | null>(null);
  const reducedMotion = useReducedMotionPreference();

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      try {
        const stored = await chrome.storage.local.get([STORAGE_KEYS.session, STORAGE_KEYS.settings, STORAGE_KEYS.overlayUi]);
        if (!mounted) {
          return;
        }

        setSession((stored[STORAGE_KEYS.session] as AssignmentSessionState | undefined) ?? null);
        setSettings((stored[STORAGE_KEYS.settings] as CanvySettings | undefined) ?? null);
        setOverlayUi(
          clampOverlayUi((stored[STORAGE_KEYS.overlayUi] as OverlayUiState | undefined) ?? createDefaultOverlayUiState())
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

      if (changes[STORAGE_KEYS.session]) {
        setSession((changes[STORAGE_KEYS.session].newValue as AssignmentSessionState | undefined) ?? null);
      }

      if (changes[STORAGE_KEYS.settings]) {
        setSettings((changes[STORAGE_KEYS.settings].newValue as CanvySettings | undefined) ?? null);
      }

      if (changes[STORAGE_KEYS.overlayUi]) {
        const next = (changes[STORAGE_KEYS.overlayUi].newValue as OverlayUiState | undefined) ?? createDefaultOverlayUiState();
        setOverlayUi(clampOverlayUi(next));
      }
    };

    const onWindowResize = () => {
      setOverlayUi((current) => clampOverlayUi(current));
    };

    void hydrate();
    chrome.storage.onChanged.addListener(onStorageChanged);
    window.addEventListener('resize', onWindowResize);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
      window.removeEventListener('resize', onWindowResize);
      if (resizePersistTimerRef.current) {
        window.clearTimeout(resizePersistTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const node = windowRef.current;
    if (!node || overlayUi.collapsed) {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);

      if (Math.abs(width - overlayUi.width) < 2 && Math.abs(height - overlayUi.height) < 2) {
        return;
      }

      setOverlayUi((current) => {
        const next = clampOverlayUi({
          ...current,
          width,
          height
        });

        if (resizePersistTimerRef.current) {
          window.clearTimeout(resizePersistTimerRef.current);
        }

        resizePersistTimerRef.current = window.setTimeout(() => {
          void persistOverlayUiState(next);
        }, 120);

        return next;
      });
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [overlayUi.collapsed, overlayUi.height, overlayUi.width]);

  const sessionMatchesPage = useMemo(() => {
    if (!session) {
      return false;
    }

    return matchesCurrentPage(
      session.pageState.currentPage.url ?? session.pageContext?.url ?? session.lastAnalysis?.sourceUrl,
      model.sourceUrl
    );
  }, [model.sourceUrl, session]);

  const liveAnalysis = sessionMatchesPage ? session?.pageState.analysis ?? session?.lastAnalysis ?? null : null;
  const analysisRun = sessionMatchesPage ? session?.analysisRun ?? null : null;
  const isRunning = Boolean(
    analysisRun &&
      analysisRun.phase !== 'completed' &&
      analysisRun.phase !== 'error' &&
      analysisRun.phase !== 'cancelled'
  );
  const motionEnabled = settings?.motionEnabled ?? true;
  const derivedAnswer = isRunning
    ? sanitizeText(analysisRun?.partialText, sanitizeText(analysisRun?.statusLabel, model.answer))
    : sanitizeText(liveAnalysis?.text, model.answer);
  const derivedNotes = isRunning ? [] : sanitizeNotes(liveAnalysis?.bullets?.length ? liveAnalysis.bullets : model.notes);
  const statusMessage =
    notice ||
    (analysisRun?.error ? analysisRun.error : isRunning ? sanitizeText(analysisRun?.statusLabel, 'Scanning...') : '');
  const revealedAnswer = useDripReveal(derivedAnswer, Boolean(isRunning && motionEnabled && derivedAnswer));
  const showCaret = Boolean(isRunning && derivedAnswer && !revealedAnswer.reducedMotion && motionEnabled);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const instruction = sanitizeText(formData.get('followUp')?.toString(), followUp).trim();
    if (!instruction || submitPending) {
      return;
    }

    setSubmitPending(true);
    setNotice('');

    try {
      const response = await sendRuntimeMessage<StartAnalysisResponse>({
        type: 'CANVY_START_ANALYSIS_RUN',
        requestId: createRequestId(),
        instruction
      });

      if (!response.ok) {
        setNotice(response.error ?? response.message ?? 'Could not start the follow-up.');
        return;
      }

      setFollowUp('');
    } catch (error) {
      console.error('[Mako IQ overlay] Follow-up submit failed.', error);
      setNotice('Could not start the follow-up.');
    } finally {
      setSubmitPending(false);
    }
  }

  async function handleCancel() {
    setSubmitPending(true);

    try {
      const response = await sendRuntimeMessage<CancelAnalysisResponse>({
        type: 'CANVY_CANCEL_ANALYSIS',
        requestId: createRequestId()
      });
      setNotice(response.message);
    } catch (error) {
      console.error('[Mako IQ overlay] Cancel request failed.', error);
      setNotice('Could not cancel the current answer.');
    } finally {
      setSubmitPending(false);
    }
  }

  async function handleToggleCollapsed() {
    const next = clampOverlayUi({
      ...overlayUi,
      collapsed: !overlayUi.collapsed
    });
    setOverlayUi(next);
    await persistOverlayUiState(next);
  }

  function handleDragStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: overlayUi.left,
      originTop: overlayUi.top
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  async function commitDraggedPosition(next: OverlayUiState) {
    const clamped = clampOverlayUi(next);
    setOverlayUi(clamped);
    await persistOverlayUiState(clamped);
  }

  function handleDragMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const next = clampOverlayUi({
      ...overlayUi,
      left: drag.originLeft + (event.clientX - drag.startX),
      top: drag.originTop + (event.clientY - drag.startY)
    });
    setOverlayUi(next);
  }

  function handleDragEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const next = clampOverlayUi({
      ...overlayUi,
      left: drag.originLeft + (event.clientX - drag.startX),
      top: drag.originTop + (event.clientY - drag.startY)
    });
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    void commitDraggedPosition(next);
  }

  const hasErrorNotice = Boolean(analysisRun?.error || /could not/i.test(notice));

  return (
    <MotionProvider>
      <div className="mako-overlay-root" aria-live="polite">
        <m.section
          ref={windowRef}
          className={`mako-overlay-window ${overlayUi.collapsed ? 'mako-overlay-window--collapsed' : ''}`}
          style={{
            left: overlayUi.left,
            top: overlayUi.top,
            width: overlayUi.width,
            height: overlayUi.collapsed ? undefined : overlayUi.height
          }}
          initial={motionEnabled && !reducedMotion ? { opacity: 0, scale: 0.96, y: 12 } : false}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0.9, 0.24, 1] }}
          aria-label="Mako IQ page answer"
        >
          <div className="mako-overlay-window__topbar">
            <div
              className="mako-overlay-window__drag mako-overlay-window__headline"
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
            >
              <div className="mako-overlay-window__caption">Recommended answer</div>
              <h2 className="mako-overlay-window__title">{sanitizeText(model.sourceTitle, 'Current page')}</h2>
            </div>

            <div className="mako-actions-row">
              <StatusPill label={isRunning ? 'Live' : 'Page'} tone={isRunning ? 'accent' : 'neutral'} />
              <IconButton
                icon={overlayUi.collapsed ? '+' : '-'}
                label={overlayUi.collapsed ? 'Expand overlay' : 'Collapse overlay'}
                onClick={() => void handleToggleCollapsed()}
              />
              <IconButton icon="x" label="Close Mako IQ overlay" onClick={onClose} />
            </div>
          </div>

          {statusMessage ? (
            <p className={`mako-overlay-window__status ${hasErrorNotice ? 'mako-overlay-window__status--danger' : ''}`}>
              {statusMessage}
            </p>
          ) : null}

          <div className="mako-overlay-window__body">
            <p className="mako-overlay-window__answer">
              {revealedAnswer.displayed}
              {showCaret ? <span className="mako-typing-caret" aria-hidden="true" /> : null}
            </p>

            {derivedNotes.length ? (
              <div className="mako-stack">
                <div className="mako-eyebrow">Suggested notes</div>
                <ul className="mako-overlay-window__notes">
                  {derivedNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <form className="mako-overlay-window__composer" onSubmit={handleSubmit}>
              <input
                className="mako-overlay-input"
                name="followUp"
                type="text"
                value={followUp}
                onChange={(event) => setFollowUp(event.target.value)}
                placeholder="Ask a follow-up..."
                aria-label="Ask a follow-up"
              />
              <div className="mako-overlay-window__actions">
                <GlassButton type="submit" variant="primary" disabled={submitPending || !followUp.trim()}>
                  Ask
                </GlassButton>
                {isRunning ? (
                  <GlassButton type="button" variant="secondary" onClick={() => void handleCancel()} disabled={submitPending}>
                    Cancel
                  </GlassButton>
                ) : null}
              </div>
            </form>
          </div>

          <div className="mako-overlay-window__meta">
            Drag from the header. Resize from the corner. Mako IQ keeps this layout for later pages.
          </div>
        </m.section>
      </div>
    </MotionProvider>
  );
}
