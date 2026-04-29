import type { OverlayFailureReason, WorkflowOutputShell, WorkflowState } from '../../shared/types';
import type { OverlayQuestionViewModel, WorkflowOverlayViewModel } from './types';

function sanitizeText(value: string | null | undefined, fallback = '') {
  if (!value) {
    return fallback;
  }

  return value.replace(/\s+/g, ' ').trim() || fallback;
}

function uniqueList(values: Array<string | null | undefined>, maxItems = 4) {
  return Array.from(
    new Set(
      values
        .map((value) => sanitizeText(value))
        .filter(Boolean)
    )
  ).slice(0, maxItems);
}

function splitNotes(value: string | null | undefined, maxItems = 3) {
  return uniqueList(
    (value ?? '')
      .split('|')
      .map((item) => item.trim()),
    maxItems
  );
}

function extractShellNotes(shell: WorkflowOutputShell | null | undefined) {
  if (!shell) {
    return [];
  }

  switch (shell.type) {
    case 'resource':
    case 'general':
      return uniqueList(shell.keyPoints);
    case 'file_assignment':
      return splitNotes(shell.explanation);
    case 'discussion_post':
      return splitNotes(shell.notes);
    case 'quiz':
      return splitNotes(shell.explanation);
    default:
      return [];
  }
}

function buildQuestionModels(workflowState: WorkflowState): OverlayQuestionViewModel[] {
  const analysis = workflowState.pageAnalysis;
  if (!analysis) {
    return [];
  }

  const shellNotes = extractShellNotes(workflowState.outputShell);

  return analysis.questions
    .filter((question) => question.answered && sanitizeText(question.answer) && sanitizeText(question.source_anchor))
    .map((question) => ({
      id: question.id,
      question: sanitizeText(question.question, 'Mapped page question'),
      answer: sanitizeText(question.answer),
      notes: uniqueList([
        question.context,
        ...analysis.actions,
        ...analysis.suggestedNextActions,
        ...shellNotes
      ]),
      sourceAnchor: sanitizeText(question.source_anchor)
    }));
}

function getFallbackTone(reason?: OverlayFailureReason) {
  if (reason === 'echo_guard' || reason === 'invalid_ai_output') {
    return 'danger' as const;
  }

  return 'warning' as const;
}

function buildFallbackCopy(workflowState: WorkflowState) {
  const analysis = workflowState.pageAnalysis;
  const reason = analysis?.overlaySuppressedReason;

  if (!analysis) {
    return {
      tone: 'accent' as const,
      label: 'Workspace answer ready',
      title: 'The on-page answer is staying conservative',
      message: 'I have the latest workspace output, but I do not have a page-safe mapped answer to place here yet.',
      notes: [
        'Open the workspace for the full response.',
        'Ask a more specific follow-up if you want a tighter answer.',
        'Refresh context if the page changed or you moved to a new section.'
      ]
    };
  }

  if (analysis.resultState === 'no_questions') {
    return {
      tone: 'warning' as const,
      label: 'No mapped question',
      title: 'I could not find a clear question to answer here',
      message: 'The page did not expose a question block that I could confidently map, so the answer is staying in the workspace.',
      notes: [
        'Use the workspace for the full response.',
        'Try Find questions from the workspace tools.',
        'Refresh context if the visible section changed.'
      ]
    };
  }

  if (analysis.resultState === 'insufficient_context') {
    return {
      tone: 'warning' as const,
      label: 'Need more context',
      title: 'I need a little more visible context before placing an answer',
      message: sanitizeText(
        analysis.message,
        'I could not confidently place an answer on the page with the current visible context.'
      ),
      notes: [
        'Scroll to the relevant prompt or question, then refresh context.',
        'Open the workspace if you want the full answer right now.',
        'Ask a follow-up that names the specific section you care about.'
      ]
    };
  }

  if (reason === 'echo_guard' || analysis.validation.echoGuardHit) {
    return {
      tone: 'danger' as const,
      label: 'Overlay held back',
      title: 'I kept the page overlay conservative on purpose',
      message: 'The result was not safe enough to render as a mapped on-page answer, so I left it in the workspace instead of echoing the page back.',
      notes: [
        'Open the workspace for the full output.',
        'Try a more specific follow-up question.',
        'Refresh context if the visible page state changed.'
      ]
    };
  }

  return {
    tone: getFallbackTone(reason),
    label: 'Workspace review',
    title: 'I could not confidently map this answer onto the page',
    message: sanitizeText(
      analysis.message,
      'The result is staying in the workspace because it was not trustworthy enough for the on-page overlay.'
    ),
    notes: [
      'Open the workspace for the full response.',
      'Refresh context if you moved to a different section.',
      'Use a narrower follow-up question for a cleaner mapped answer.'
    ]
  };
}

export function mapWorkflowStateToOverlay(workflowState: WorkflowState): WorkflowOverlayViewModel {
  const outputTitle = workflowState.outputShell?.title?.toLowerCase() ?? '';
  const actionLabel = workflowState.currentActionLabel ?? workflowState.currentAction ?? 'Updated output';
  const isTestOverlay =
    actionLabel.toLowerCase().includes('overlay test') ||
    workflowState.sourceTitle.toLowerCase().includes('mako iq test overlay') ||
    outputTitle.includes('mako iq test overlay');
  const questions = buildQuestionModels(workflowState);
  const analysis = workflowState.pageAnalysis;
  const isMappedAnswerReady =
    Boolean(analysis?.aiTaggedSuccessfully) &&
    Boolean(analysis?.overlayEligible) &&
    questions.length > 0;
  const fallback = buildFallbackCopy(workflowState);

  return {
    workflowType: workflowState.currentWorkflow,
    sourceTitle: workflowState.sourceTitle,
    sourceUrl: workflowState.sourceUrl,
    displayState: isMappedAnswerReady && !isTestOverlay ? 'answer' : 'fallback',
    statusLabel: isMappedAnswerReady ? 'Mapped answer ready' : fallback.label,
    statusTone: isMappedAnswerReady ? 'success' : fallback.tone,
    questions,
    fallbackTitle: fallback.title,
    fallbackMessage: fallback.message,
    fallbackNotes: fallback.notes,
    isTestOverlay,
    updatedAt: workflowState.updatedAt
  };
}
