import { getSession, saveSession } from '../storage';
import type { WorkflowState } from '../types';

export async function loadWorkflowState() {
  const session = await getSession();
  return session.workflowState ?? null;
}

export async function persistWorkflowState(workflowState: WorkflowState) {
  console.info('[Canvy workflow storage] Persisting workflow state.', {
    workflowType: workflowState.currentWorkflow,
    currentAction: workflowState.currentAction,
    hasInstructions: Boolean(workflowState.extraInstructions)
  });
  const nextSession = await saveSession({
    workflowState
  });
  console.info('[Canvy workflow storage] Workflow state persisted.', {
    workflowType: nextSession.workflowState?.currentWorkflow,
    latestScanId: nextSession.workflowState?.latestScanId
  });
  return nextSession;
}

export async function persistWorkflowInstructions(extraInstructions: string) {
  const session = await getSession();
  if (!session.workflowState) {
    return null;
  }

  console.info('[Canvy workflow storage] Extra instructions saved.', {
    hasInstructions: Boolean(extraInstructions.trim()),
    instructionLength: extraInstructions.trim().length
  });

  return persistWorkflowState({
    ...session.workflowState,
    extraInstructions: extraInstructions.trim(),
    updatedAt: new Date().toISOString(),
    lastUpdatedAt: Date.now()
  });
}
