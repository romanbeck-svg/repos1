import type { WorkflowActionCard, WorkflowActionId, WorkflowState } from '../types';
import { buildWorkflowOutput } from './buildWorkflowOutput';
import { classifyWorkflow } from './classifyWorkflow';
import { extractPrompt } from './extractPrompt';
import type { ApplyWorkflowActionInput, BuildWorkflowStateInput } from './types';

const ASSISTANT_PROMPT = 'Is there anything else I need to know before starting?';

export function getWorkflowActionCards(workflowType: WorkflowState['workflowType']): WorkflowActionCard[] {
  switch (workflowType) {
    case 'resource':
      return [
        { id: 'summarize_resource', task: 'summarize_reading', label: 'Summarize', description: 'Create a concise study summary from the current source.', emphasis: 'primary' },
        { id: 'extract_notes', task: 'build_draft', label: 'Notes', description: 'Pull out cleaner notes and key takeaways.' },
        { id: 'save_as_context', task: 'explain_page', label: 'Save context', description: 'Keep this page framed as supporting context for later work.' }
      ];
    case 'file_assignment':
      return [
        { id: 'start_assignment_help', task: 'analyze_assignment', label: 'Assignment help', description: 'Organize the visible prompt and prepare the assignment workflow.', emphasis: 'primary' },
        { id: 'apply_instructions', task: 'build_draft', label: 'Add instructions', description: 'Capture extra requirements before the next draft-help pass.' }
      ];
    case 'discussion_post':
      return [
        { id: 'draft_response', task: 'discussion_post', label: 'Draft reply', description: 'Prepare a structured discussion-response shell.', emphasis: 'primary' },
        { id: 'apply_instructions', task: 'analyze_assignment', label: 'Add instructions', description: 'Capture tone, reply requirements, or other constraints.' }
      ];
    case 'quiz':
      return [
        { id: 'prepare_quiz_support', task: 'quiz_assist', label: 'Quiz support', description: 'Stay in quiz-safe explanation and study mode.', emphasis: 'primary' },
        { id: 'apply_instructions', task: 'explain_page', label: 'Add instructions', description: 'Capture study goals or concept areas to focus on.' }
      ];
    default:
      return [
        { id: 'summarize_page', task: 'summarize_reading', label: 'Summarize', description: 'Turn the current page into a concise summary.', emphasis: 'primary' },
        { id: 'explain_page', task: 'explain_page', label: 'Explain', description: 'Walk through the page in simpler language.' },
        { id: 'extract_key_points', task: 'analyze_assignment', label: 'Key points', description: 'Pull out the most useful ideas from the current page.' }
      ];
  }
}

function resolveAction(actionCards: WorkflowActionCard[], previous?: WorkflowState, preferredActionId?: WorkflowActionId | null) {
  if (preferredActionId) {
    const byId = actionCards.find((action) => action.id === preferredActionId);
    if (byId) {
      return byId;
    }
  }

  if (previous?.currentAction) {
    const byPrevious = actionCards.find((action) => action.id === previous.currentAction);
    if (byPrevious) {
      return byPrevious;
    }
  }

  if (previous?.selectedTask) {
    const byTask = actionCards.find((action) => action.task === previous.selectedTask);
    if (byTask) {
      return byTask;
    }
  }

  return actionCards[0];
}

function resolveSourceTitle(input: BuildWorkflowStateInput) {
  return (
    input.taskClassification.metadata.assignmentTitle ??
    input.taskClassification.metadata.discussionTitle ??
    input.taskClassification.metadata.quizTitle ??
    input.taskClassification.metadata.resourceTitle ??
    input.taskClassification.metadata.sourcePageTitle ??
    input.latestScan?.pageTitle ??
    input.pageContext?.title ??
    input.currentTitle ??
    'Current page'
  );
}

export function buildWorkflowState(input: BuildWorkflowStateInput): WorkflowState {
  const workflowClassification = classifyWorkflow({
    assistantMode: input.assistantMode,
    currentTitle: input.currentTitle,
    currentUrl: input.currentUrl,
    pageContext: input.pageContext,
    latestScan: input.latestScan,
    taskClassification: input.taskClassification
  });
  const promptExtraction = extractPrompt({
    assistantMode: input.assistantMode,
    currentTitle: input.currentTitle,
    currentUrl: input.currentUrl,
    pageContext: input.pageContext,
    latestScan: input.latestScan,
    taskClassification: input.taskClassification,
    workflowClassification
  });
  const actionCards = getWorkflowActionCards(workflowClassification.workflowType);
  const activeAction = resolveAction(actionCards, input.previous);
  const sourceTitle = resolveSourceTitle(input);
  const sourceUrl = input.latestScan?.url ?? input.pageContext?.url ?? input.currentUrl;
  const extraInstructions = input.previous?.extraInstructions ?? '';
  const outputShell = buildWorkflowOutput({
    workflowType: workflowClassification.workflowType,
    action: activeAction,
    workflowClassification,
    promptExtraction,
    taskClassification: input.taskClassification,
    workflowRoute: input.workflowRoute,
    latestScan: input.latestScan,
    pageContext: input.pageContext,
    analysis: input.analysis,
    extraInstructions
  });
  const updatedAt = new Date().toISOString();
  const workflowState: WorkflowState = {
    currentWorkflow: workflowClassification.workflowType,
    classification: workflowClassification,
    promptExtraction,
    latestScanId: input.latestScan?.scannedAt ?? null,
    currentAction: activeAction.id,
    currentActionLabel: activeAction.label,
    currentActionTask: activeAction.task,
    lastUpdatedAt: Date.now(),
    workflowType: workflowClassification.workflowType,
    confidence: workflowClassification.confidence,
    reasons: workflowClassification.reasons,
    recommendedAction: activeAction.description ?? input.workflowRoute.primaryMessage,
    assistantPrompt: ASSISTANT_PROMPT,
    extraInstructions,
    selectedTask: activeAction.task,
    actionCards,
    outputShell,
    sourceTitle,
    sourceUrl,
    updatedAt
  };

  console.info('[Canvy workflow] Workflow state built.', {
    workflowType: workflowState.currentWorkflow,
    latestScanId: workflowState.latestScanId,
    currentAction: workflowState.currentAction,
    hasPrompt: Boolean(workflowState.promptExtraction?.promptText),
    hasInstructions: Boolean(workflowState.extraInstructions.trim())
  });

  return workflowState;
}

export function applyWorkflowAction(input: ApplyWorkflowActionInput): WorkflowState {
  const actionCards = input.workflowState.actionCards;
  const nextAction =
    (input.actionId ? actionCards.find((action) => action.id === input.actionId) : undefined) ??
    (input.task ? actionCards.find((action) => action.task === input.task) : undefined) ??
    actionCards[0];
  const extraInstructions = input.extraInstructions.trim();
  const outputShell =
    nextAction && input.workflowState.classification
      ? buildWorkflowOutput({
          workflowType: input.workflowState.currentWorkflow,
          action: nextAction,
          workflowClassification: input.workflowState.classification,
          promptExtraction: input.promptExtraction ?? input.workflowState.promptExtraction,
          taskClassification: input.taskClassification,
          workflowRoute: input.workflowRoute,
          latestScan: input.latestScan,
          pageContext: input.pageContext,
          analysis: input.analysis,
          extraInstructions
        })
      : input.workflowState.outputShell;
  const updatedAt = new Date().toISOString();
  const nextState: WorkflowState = {
    ...input.workflowState,
    promptExtraction: input.promptExtraction ?? input.workflowState.promptExtraction,
    currentAction: nextAction?.id ?? input.workflowState.currentAction,
    currentActionLabel: nextAction?.label ?? input.workflowState.currentActionLabel,
    currentActionTask: nextAction?.task ?? input.workflowState.currentActionTask,
    extraInstructions,
    selectedTask: nextAction?.task ?? input.workflowState.selectedTask,
    recommendedAction: nextAction?.description ?? input.workflowState.recommendedAction,
    outputShell,
    updatedAt,
    lastUpdatedAt: Date.now()
  };

  console.info('[Canvy workflow] Workflow action applied.', {
    workflowType: nextState.currentWorkflow,
    actionId: nextState.currentAction,
    hasInstructions: Boolean(nextState.extraInstructions.trim())
  });

  return nextState;
}
