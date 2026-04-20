import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { STORAGE_KEYS } from '../../shared/constants';
import { useDripReveal } from '../../shared/hooks/useDripReveal';
import { sendRuntimeMessage } from '../../shared/runtime';
import type {
  AssignmentSessionState,
  CancelAnalysisResponse,
  CanvySettings,
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

export function CanvyOutputOverlay({ model, onClose }: WorkflowOverlayProps) {
  const [session, setSession] = useState<AssignmentSessionState | null>(null);
  const [settings, setSettings] = useState<CanvySettings | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [submitPending, setSubmitPending] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      try {
        const stored = await chrome.storage.local.get([STORAGE_KEYS.session, STORAGE_KEYS.settings]);
        if (!mounted) {
          return;
        }

        setSession((stored[STORAGE_KEYS.session] as AssignmentSessionState | undefined) ?? null);
        setSettings((stored[STORAGE_KEYS.settings] as CanvySettings | undefined) ?? null);
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
    };

    void hydrate();
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

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

  const hasErrorNotice = Boolean(analysisRun?.error || /could not/i.test(notice));

  return (
    <div className="canvy-overlay-layer" aria-live="polite">
      <section
        className={`canvy-overlay-shell ${model.isTestOverlay ? 'canvy-overlay-shell-test' : ''}`}
        aria-label="Mako IQ page answer"
      >
        <button
          type="button"
          className="canvy-overlay-close"
          onClick={onClose}
          aria-label="Close Mako IQ overlay"
        >
          x
        </button>

        <div className="canvy-overlay-section">
          <div className="canvy-overlay-eyebrow">Recommended answer</div>
          <div className="canvy-overlay-answer">
            {revealedAnswer.displayed}
            {showCaret ? <span className="canvy-overlay-caret" aria-hidden="true" /> : null}
          </div>
        </div>

        {statusMessage ? (
          <div className={`canvy-overlay-status ${hasErrorNotice ? 'canvy-overlay-status-error' : ''}`}>
            {statusMessage}
          </div>
        ) : null}

        {derivedNotes.length ? (
          <div className="canvy-overlay-section canvy-overlay-section-secondary">
            <div className="canvy-overlay-eyebrow canvy-overlay-eyebrow-secondary">Suggested notes</div>
            <ul className="canvy-overlay-list">
              {derivedNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <form className="canvy-overlay-composer" onSubmit={handleSubmit}>
          <input
            className="canvy-overlay-followup-input"
            name="followUp"
            type="text"
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder="Ask a follow-up..."
            aria-label="Ask a follow-up"
          />
          <button
            type="submit"
            className="canvy-overlay-submit"
            disabled={submitPending || !followUp.trim()}
          >
            Ask
          </button>
          {isRunning ? (
            <button
              type="button"
              className="canvy-overlay-cancel"
              onClick={() => void handleCancel()}
              disabled={submitPending}
            >
              Cancel
            </button>
          ) : null}
        </form>
      </section>
    </div>
  );
}
