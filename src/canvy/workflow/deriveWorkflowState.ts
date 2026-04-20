import { buildWorkflowState } from '../shared/workflow/buildWorkflowState';
import { handleWorkflowAction, handleWorkflowActionAndPersist } from '../shared/workflow/handleWorkflowAction';
import type {
  ApplyWorkflowActionInput,
  BuildWorkflowStateInput
} from '../shared/workflow/types';

export interface DeriveWorkflowStateInput
  extends Omit<BuildWorkflowStateInput, 'assistantMode' | 'currentTitle' | 'currentUrl' | 'taskClassification'> {
  classification: BuildWorkflowStateInput['taskClassification'];
}

export function deriveWorkflowState(input: DeriveWorkflowStateInput) {
  return buildWorkflowState({
    assistantMode: input.classification.mode,
    currentTitle:
      input.latestScan?.pageTitle ??
      input.pageContext?.title ??
      input.classification.metadata.assignmentTitle ??
      input.classification.metadata.sourcePageTitle ??
      'Current page',
    currentUrl: input.latestScan?.url ?? input.pageContext?.url ?? '',
    taskClassification: input.classification,
    workflowRoute: input.workflowRoute,
    latestScan: input.latestScan,
    pageContext: input.pageContext,
    analysis: input.analysis,
    previous: input.previous
  });
}

export interface RunWorkflowActionInput
  extends Omit<ApplyWorkflowActionInput, 'taskClassification' | 'workflowRoute' | 'latestScan' | 'pageContext' | 'analysis'> {
  taskClassification?: ApplyWorkflowActionInput['taskClassification'];
  workflowRoute?: ApplyWorkflowActionInput['workflowRoute'];
  latestScan?: ApplyWorkflowActionInput['latestScan'];
  pageContext?: ApplyWorkflowActionInput['pageContext'];
  analysis?: ApplyWorkflowActionInput['analysis'];
}

export function runWorkflowAction(input: RunWorkflowActionInput) {
  return handleWorkflowAction(input);
}

export async function runWorkflowActionAndPersist(input: RunWorkflowActionInput) {
  return handleWorkflowActionAndPersist(input);
}
