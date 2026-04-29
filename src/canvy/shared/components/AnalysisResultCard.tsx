import { useEffect, useMemo, useState } from 'react';
import type { AnalysisRunSnapshot, PageAnalysisResult } from '../types';
import { useDripReveal } from '../hooks/useDripReveal';
import {
  AnswerCard,
  EmptyState,
  FailureState,
  GlassButton,
  GlassPanel,
  LoadingState,
  StatusPill,
  SuggestedNotesCard
} from './ui';

interface AnalysisResultCardProps {
  analysis?: PageAnalysisResult | null;
  analysisRun?: AnalysisRunSnapshot | null;
  emptyTitle?: string;
  emptyBody?: string;
  compact?: boolean;
  onCancel?: (() => void) | null;
}

function sanitizeText(value: string | null | undefined, fallback = '') {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function getResultTone(analysis: PageAnalysisResult) {
  if (analysis.resultState === 'success') {
    return 'success' as const;
  }

  if (analysis.resultState === 'no_questions' || analysis.resultState === 'insufficient_context') {
    return 'warning' as const;
  }

  return 'danger' as const;
}

function getResultLabel(analysis: PageAnalysisResult) {
  switch (analysis.resultState) {
    case 'success':
      return analysis.overlayEligible ? 'Mapped' : 'Workspace only';
    case 'no_questions':
      return 'No questions';
    case 'insufficient_context':
      return 'Need context';
    default:
      return 'Review in workspace';
  }
}

function buildSuggestedNotes(analysis: PageAnalysisResult, context: string) {
  const notes = new Set<string>();

  if (context) {
    notes.add(context);
  }

  analysis.actions.forEach((item) => notes.add(sanitizeText(item)));
  analysis.suggestedNextActions.forEach((item) => notes.add(sanitizeText(item)));
  analysis.importantDetails.forEach((item) => notes.add(sanitizeText(item)));

  return Array.from(notes).filter(Boolean).slice(0, 4);
}

export function AnalysisResultCard({
  analysis,
  analysisRun,
  emptyTitle = 'Ready when you are',
  emptyBody = 'Ask a question, run a quick action, or open the workspace for a deeper pass.',
  compact = false,
  onCancel
}: AnalysisResultCardProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const isRunning =
    analysisRun &&
    analysisRun.phase !== 'completed' &&
    analysisRun.phase !== 'error' &&
    analysisRun.phase !== 'cancelled';
  const shouldShowRunState = Boolean(analysisRun && (isRunning || !analysis));
  const runTitle = analysisRun?.partialTitle || analysisRun?.pageTitle || 'Preparing an answer';
  const runText = analysisRun?.partialText ?? '';
  const revealedTitle = useDripReveal(runTitle, Boolean(isRunning && runTitle));
  const revealedText = useDripReveal(runText, Boolean(isRunning && runText));
  const questions = useMemo(
    () =>
      (analysis?.questions ?? []).map((question) => ({
        ...question,
        question: sanitizeText(question.question),
        answer: sanitizeText(question.answer),
        context: sanitizeText(question.context)
      })),
    [analysis?.questions]
  );
  const questionKey = questions.map((question) => `${question.id}:${question.status}`).join('|');
  const activeQuestion = questions[activeIndex] ?? questions[0] ?? null;
  const suggestedNotes = analysis && activeQuestion ? buildSuggestedNotes(analysis, activeQuestion.context) : [];

  useEffect(() => {
    const firstAnsweredIndex = questions.findIndex((question) => question.answered);
    setActiveIndex(firstAnsweredIndex >= 0 ? firstAnsweredIndex : 0);
  }, [questionKey, questions]);

  if (analysis && !shouldShowRunState) {
    const resultTone = getResultTone(analysis);
    const resultLabel = getResultLabel(analysis);

    if (analysis.resultState === 'success' && activeQuestion) {
      return (
        <div className="mako-result-stack">
          <AnswerCard
            eyebrow="Recommended answer"
            title={activeQuestion.question || analysis.title}
            subtitle={analysis.sourceTitle}
            answer={activeQuestion.answered ? activeQuestion.answer : 'I need more visible context on the page before answering directly.'}
            meta={<StatusPill label={resultLabel} tone={resultTone} />}
            className={compact ? 'mako-answer-card--compact' : undefined}
            footer={
              <div className="mako-answer-card__meta-row">
                <div className="mako-chip-row">
                  <StatusPill label={activeQuestion.answered ? 'Answered' : 'Partial'} tone={activeQuestion.answered ? 'success' : 'warning'} />
                  <StatusPill label={analysis.extractionMode.toUpperCase()} tone="accent" />
                  {analysis.overlayEligible ? <StatusPill label="Overlay ready" tone="neutral" /> : null}
                </div>

                {questions.length > 1 ? (
                  <div className="mako-result__chips" aria-label="Detected questions">
                    {questions.map((question, index) => (
                      <button
                        key={question.id}
                        type="button"
                        className={`mako-result__chip ${index === activeIndex ? 'mako-result__chip--active' : ''}`}
                        onClick={() => setActiveIndex(index)}
                      >
                        Q{index + 1}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            }
          />

          <SuggestedNotesCard
            notes={suggestedNotes}
            description="Supporting context stays secondary so the answer remains primary."
            emptyMessage="No extra notes are needed for this answer."
          />
        </div>
      );
    }

    return (
      <FailureState
        title="The answer is staying in the workspace"
        body={sanitizeText(analysis.message, 'I could not confidently map a clean answer onto this page yet.')}
        tone={resultTone === 'danger' ? 'danger' : 'warning'}
        action={
          <div className="mako-chip-row">
            <StatusPill label={resultLabel} tone={resultTone} />
            <StatusPill label={analysis.extractionMode.toUpperCase()} tone="accent" />
            {analysis.validation.echoGuardHit ? <StatusPill label="Echo blocked" tone="warning" /> : null}
          </div>
        }
      />
    );
  }

  if (analysisRun) {
    return (
      <div className="mako-result-stack">
        <LoadingState
          title={revealedTitle.displayed}
          body={analysisRun.statusLabel}
          action={
            isRunning && onCancel ? (
              <GlassButton variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </GlassButton>
            ) : null
          }
        />

        {runText ? (
          <GlassPanel tone="quiet" className="mako-stream-panel">
            <p className="mako-stream-panel__text">{revealedText.displayed}</p>
          </GlassPanel>
        ) : null}

        {analysisRun.error ? (
          <FailureState title="The latest answer hit a problem" body={analysisRun.error} tone="danger" />
        ) : null}
      </div>
    );
  }

  return <EmptyState title={emptyTitle} body={emptyBody} />;
}
