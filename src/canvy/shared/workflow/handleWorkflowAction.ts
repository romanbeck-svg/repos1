import { applyWorkflowAction } from './buildWorkflowState';
import type { ApplyWorkflowActionInput } from './types';
import { persistWorkflowState } from './workflowStorage';

export function handleWorkflowAction(input: ApplyWorkflowActionInput) {
  const nextState = applyWorkflowAction(input);
  console.info('[Canvy workflow] Action clicked.', {
    actionId: nextState.currentAction,
    actionLabel: nextState.currentActionLabel,
    workflowType: nextState.currentWorkflow
  });
  return nextState;
}

export async function handleWorkflowActionAndPersist(input: ApplyWorkflowActionInput) {
  const nextState = handleWorkflowAction(input);
  await persistWorkflowState(nextState);
  return nextState;
}
