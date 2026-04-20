import { AnimatePresence, m } from 'motion/react';
import type { AnalysisRunSnapshot, PageAnalysisResult } from '../types';
import { useDripReveal } from '../hooks/useDripReveal';
import { GlassButton, GlassSurface, SectionHeader, StatusPill } from './ui';

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
  emptyTitle = 'No answer yet',
  emptyBody = 'Run an analysis to see the primary answer here first, with notes only when they add value.',
  compact = false,
  onCancel
}: AnalysisResultCardProps) {
  const isRunning =
    analysisRun &&
    analysisRun.phase !== 'completed' &&
    analysisRun.phase !== 'error' &&
    analysisRun.phase !== 'cancelled';
  const shouldShowRunState = Boolean(analysisRun && (isRunning || !analysis));
  const runTitle = analysisRun?.partialTitle || analysisRun?.pageTitle || 'Preparing the recommended answer';
  const runText = analysisRun?.partialText ?? '';
  const revealedTitle = useDripReveal(runTitle, Boolean(isRunning && runTitle));
  const revealedText = useDripReveal(runText, Boolean(isRunning && runText));
  const showCaret = Boolean(isRunning && runText && !revealedText.reducedMotion);

  if (analysis && !shouldShowRunState) {
    return (
      <GlassSurface className="mako-result" tone={compact ? 'soft' : 'elevated'}>
        <SectionHeader
          eyebrow="Recommended answer"
          title={analysis.title}
          description={analysis.sourceTitle}
          meta={<StatusPill label="Ready" tone="success" />}
        />

        <p className="mako-result__body">{analysis.text}</p>

        {analysis.bullets.length ? (
          <div className="mako-stack">
            <div className="mako-eyebrow">Suggested notes</div>
            <ul className="mako-result__list">
              {analysis.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mako-result__footer">
          {analysis.cacheStatus ? <StatusPill label={analysis.cacheStatus.replace('_', ' ')} tone="accent" /> : null}
          {analysis.suggestedNextActions[0] ? <span className="mako-muted">{analysis.suggestedNextActions[0]}</span> : null}
        </div>
      </GlassSurface>
    );
  }

  if (analysisRun) {
    return (
      <GlassSurface className="mako-result" tone={compact ? 'soft' : 'elevated'}>
        <SectionHeader
          eyebrow="Recommended answer"
          title={revealedTitle.displayed}
          description={analysisRun.statusLabel}
          meta={<StatusPill label={isRunning ? 'Live' : analysisRun.error ? 'Issue' : 'Finished'} tone={analysisRun.error ? 'danger' : isRunning ? 'accent' : 'success'} />}
        />

        <AnimatePresence initial={false}>
          {isRunning ? (
            <m.div
              key="progress"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mako-loading-bar"
            />
          ) : null}
        </AnimatePresence>

        {runText ? (
          <div className="mako-result__body">
            {revealedText.displayed}
            {showCaret ? <span className="mako-typing-caret" aria-hidden="true" /> : null}
          </div>
        ) : null}

        {analysisRun.error ? <div className="mako-notice mako-notice--warning">{analysisRun.error}</div> : null}

        {isRunning && onCancel ? (
          <div className="mako-result__footer">
            <GlassButton variant="secondary" onClick={onCancel}>
              Cancel
            </GlassButton>
          </div>
        ) : null}
      </GlassSurface>
    );
  }

  return (
    <GlassSurface className="mako-result" tone={compact ? 'soft' : 'default'}>
      <SectionHeader eyebrow="Recommended answer" title={emptyTitle} description={emptyBody} />
    </GlassSurface>
  );
}
