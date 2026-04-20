import type { AnalysisRunSnapshot, PageAnalysisResult } from '../types';
import { useDripReveal } from '../hooks/useDripReveal';

interface AnalysisResultCardProps {
  analysis?: PageAnalysisResult | null;
  analysisRun?: AnalysisRunSnapshot | null;
  emptyTitle?: string;
  emptyBody?: string;
  compact?: boolean;
  onCancel?: (() => void) | null;
}

export function AnalysisResultCard({
  analysis,
  analysisRun,
  emptyTitle = 'No analysis yet',
  emptyBody = 'Start an analysis to see Mako IQ summarize and explain the current page.',
  compact = false,
  onCancel
}: AnalysisResultCardProps) {
  const isRunning =
    analysisRun &&
    analysisRun.phase !== 'completed' &&
    analysisRun.phase !== 'error' &&
    analysisRun.phase !== 'cancelled';
  const shouldShowRunState = Boolean(analysisRun && (isRunning || !analysis));
  const runTitle = analysisRun?.partialTitle || analysisRun?.pageTitle || 'Scanning the current page';
  const runText = analysisRun?.partialText ?? '';
  const revealedTitle = useDripReveal(runTitle, Boolean(isRunning && runTitle));
  const revealedText = useDripReveal(runText, Boolean(isRunning && runText));
  const showCaret = Boolean(isRunning && runText && !revealedText.reducedMotion);

  if (analysis && !shouldShowRunState) {
    return (
      <section className={`canvy-card canvy-analysis-card ${compact ? 'canvy-analysis-card-compact' : ''}`}>
        <div className="canvy-card-head">
          <div>
            <div className="canvy-eyebrow">Recommended answer</div>
            <h3>{analysis.title}</h3>
          </div>
        </div>

        <div className="canvy-copy-block canvy-analysis-lead-copy">{analysis.text}</div>

        {analysis.bullets.length ? (
          <div className="canvy-analysis-section">
            <div className="canvy-eyebrow">Suggested notes</div>
            <ul className="canvy-list canvy-analysis-list">
              {analysis.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    );
  }

  if (analysisRun) {
    return (
      <section className={`canvy-card canvy-analysis-card ${compact ? 'canvy-analysis-card-compact' : ''}`}>
        <div className="canvy-card-head">
          <div>
            <div className="canvy-eyebrow">Recommended answer</div>
            <h3>{revealedTitle.displayed}</h3>
          </div>
        </div>

        <p className="canvy-muted">{analysisRun.statusLabel}</p>
        {isRunning ? <div className="canvy-loading-bar" /> : null}

        {runText ? (
          <div className="canvy-copy-block canvy-analysis-live-copy">
            {revealedText.displayed}
            {showCaret ? <span className="canvy-typing-caret" aria-hidden="true" /> : null}
          </div>
        ) : null}

        {analysisRun.error ? <div className="canvy-inline-warning">{analysisRun.error}</div> : null}

        {isRunning && onCancel ? (
          <div className="canvy-action-row">
            <button className="canvy-secondary" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className={`canvy-card canvy-analysis-card ${compact ? 'canvy-analysis-card-compact' : ''}`}>
      <div className="canvy-eyebrow">Recommended answer</div>
      <h3>{emptyTitle}</h3>
      <p className="canvy-muted">{emptyBody}</p>
    </section>
  );
}
