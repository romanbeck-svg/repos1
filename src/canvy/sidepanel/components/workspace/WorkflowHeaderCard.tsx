import { WorkflowBadge } from './WorkflowBadge';
import type { WorkflowClassification, WorkflowRoute, WorkflowState } from '../../../shared/types';

interface WorkflowHeaderCardProps {
  workflowState: WorkflowState | null;
  workflowRoute?: WorkflowRoute;
  classification?: WorkflowClassification | null;
}

function formatLabel(value?: string | null) {
  return value ? value.replace(/_/g, ' ') : 'General';
}

function descriptionForWorkflow(workflowType?: string) {
  switch (workflowType) {
    case 'resource':
      return 'Use this page as supporting context for summaries, notes, and later school workflows.';
    case 'file_assignment':
      return 'Organize the visible prompt, capture extra requirements, and prepare assignment help.';
    case 'discussion_post':
      return 'Break down the prompt, save reply requirements, and shape a discussion workflow.';
    case 'quiz':
      return 'Stay in quiz-safe mode and prepare explanation-first study support.';
    default:
      return 'Summarize, explain, and organize the current page from the latest scan and workflow route.';
  }
}

function promptLabel(workflowType?: string) {
  switch (workflowType) {
    case 'file_assignment':
      return 'Detected task';
    case 'discussion_post':
      return 'Detected discussion prompt';
    case 'quiz':
      return 'Detected question or task';
    case 'resource':
      return 'Extracted topic';
    default:
      return 'Prompt or topic';
  }
}

function workflowSubtitle(workflowType?: string) {
  switch (workflowType) {
    case 'file_assignment':
      return 'Assignment workflow';
    case 'discussion_post':
      return 'Discussion workflow';
    case 'quiz':
      return 'Quiz support workflow';
    case 'resource':
      return 'Resource workflow';
    default:
      return 'General workflow';
  }
}

export function WorkflowHeaderCard({ workflowState, workflowRoute, classification }: WorkflowHeaderCardProps) {
  const workflowType = workflowState?.currentWorkflow;

  return (
    <section className="canvy-card">
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">Workspace</div>
          <h3>{workflowState?.sourceTitle ?? 'Workflow workspace'}</h3>
          <p className="canvy-muted">{workflowSubtitle(workflowType)}</p>
        </div>
      </div>
      <div className="canvy-chip-row">
        <WorkflowBadge label={formatLabel(workflowState?.currentWorkflow)} />
        {workflowState ? <WorkflowBadge label={`${Math.round(workflowState.confidence * 100)}% confidence`} /> : null}
        {classification ? <WorkflowBadge label={classification.workflowType.replace(/_/g, ' ')} /> : null}
        {workflowState?.extraInstructions.trim() ? <WorkflowBadge label="instructions active" /> : null}
      </div>
      <p className="canvy-panel-status-copy">
        {workflowState?.recommendedAction ?? workflowRoute?.primaryMessage ?? descriptionForWorkflow(workflowState?.currentWorkflow)}
      </p>
      {workflowState?.promptExtraction?.promptText ? (
        <div className="canvy-panel-output-card">
          <div className="canvy-eyebrow">{promptLabel(workflowType)}</div>
          <p className="canvy-copy-block">{workflowState.promptExtraction.promptText}</p>
        </div>
      ) : null}
      <div className="canvy-panel-inline-result">
        <div className="canvy-eyebrow">What Mako IQ sees here</div>
        <p className="canvy-copy-block">{descriptionForWorkflow(workflowState?.currentWorkflow)}</p>
        {workflowState?.reasons.length ? (
          <ul className="canvy-list">
            {workflowState.reasons.slice(0, 3).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
