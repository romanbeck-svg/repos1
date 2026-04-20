import type { WorkflowState } from '../../shared/types';
import type { WorkflowOverlayViewModel } from './types';

function sanitizeText(value: string | null | undefined, fallback = '') {
  if (!value) {
    return fallback;
  }

  return value.replace(/\s+/g, ' ').trim() || fallback;
}

function sanitizeList(values: string[] | undefined, maxItems = 3) {
  return (values ?? [])
    .map((value) => sanitizeText(value))
    .filter(Boolean)
    .slice(0, maxItems);
}

function splitNotes(value: string | null | undefined, maxItems = 3) {
  return sanitizeList(
    (value ?? '')
      .split('|')
      .map((item) => item.trim()),
    maxItems
  );
}

function extractOverlayAnswer(workflowState: WorkflowState) {
  const shell = workflowState.outputShell;
  if (!shell) {
    return {
      answer: 'Mako IQ updated this page.',
      notes: []
    };
  }

  switch (shell.type) {
    case 'resource':
      return {
        answer: sanitizeText(shell.summary, sanitizeText(shell.intro, 'Mako IQ updated this page.')),
        notes: sanitizeList(shell.keyPoints)
      };
    case 'file_assignment':
      return {
        answer: sanitizeText(shell.draftAnswer, sanitizeText(shell.task, 'Mako IQ updated this page.')),
        notes: splitNotes(shell.explanation)
      };
    case 'discussion_post':
      return {
        answer: sanitizeText(shell.draftResponse, sanitizeText(shell.prompt, 'Mako IQ updated this page.')),
        notes: splitNotes(shell.notes)
      };
    case 'quiz':
      return {
        answer: sanitizeText(shell.answer, sanitizeText(shell.questionSupport, 'Mako IQ updated this page.')),
        notes: splitNotes(shell.explanation)
      };
    default:
      return {
        answer: sanitizeText(shell.summary, sanitizeText(shell.intro, 'Mako IQ updated this page.')),
        notes: sanitizeList(shell.keyPoints)
      };
  }
}

export function mapWorkflowStateToOverlay(workflowState: WorkflowState): WorkflowOverlayViewModel {
  const outputTitle = workflowState.outputShell?.title?.toLowerCase() ?? '';
  const actionLabel = workflowState.currentActionLabel ?? workflowState.currentAction ?? 'Updated output';
  const isTestOverlay =
    actionLabel.toLowerCase().includes('overlay test') ||
    workflowState.sourceTitle.toLowerCase().includes('mako iq test overlay') ||
    outputTitle.includes('mako iq test overlay');
  const { answer, notes } = extractOverlayAnswer(workflowState);

  return {
    workflowType: workflowState.currentWorkflow,
    sourceTitle: workflowState.sourceTitle,
    sourceUrl: workflowState.sourceUrl,
    answer,
    notes,
    isTestOverlay,
    updatedAt: workflowState.updatedAt
  };
}
