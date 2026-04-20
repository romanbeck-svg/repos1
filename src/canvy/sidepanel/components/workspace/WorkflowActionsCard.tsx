import type { CanvyTaskKind, WorkflowActionCard, WorkflowActionId } from '../../../shared/types';

interface WorkflowActionsCardProps {
  workflowType?: string | null;
  actions: WorkflowActionCard[];
  currentActionId?: WorkflowActionId | null;
  disabled?: boolean;
  onActionClick: (actionId: WorkflowActionId, task: CanvyTaskKind) => void;
}

function titleForWorkflow(workflowType?: string | null) {
  switch (workflowType) {
    case 'resource':
      return 'Choose a resource step';
    case 'file_assignment':
      return 'Choose an assignment step';
    case 'discussion_post':
      return 'Choose a discussion step';
    case 'quiz':
      return 'Choose a quiz-support step';
    default:
      return 'Choose the next workflow step';
  }
}

export function WorkflowActionsCard({ workflowType, actions, currentActionId, disabled, onActionClick }: WorkflowActionsCardProps) {
  return (
    <section className="canvy-card">
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">Actions</div>
          <h3>{titleForWorkflow(workflowType)}</h3>
        </div>
      </div>
      <div className="canvy-workflow-action-grid">
        {actions.map((action) => {
          const isSelected = action.id === currentActionId;
          return (
            <button
              key={action.id}
              type="button"
              className={`canvy-workflow-action ${isSelected ? 'canvy-workflow-action-active' : ''}`}
              onClick={() => onActionClick(action.id, action.task)}
              disabled={disabled}
              aria-describedby={`workflow-action-${action.id}-hint`}
            >
              <span className="canvy-panel-action-label">{action.label}</span>
              <span className="canvy-panel-action-info" aria-hidden="true">
                i
              </span>
              <span
                className="canvy-panel-action-tooltip"
                id={`workflow-action-${action.id}-hint`}
                role="tooltip"
              >
                {action.description}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
