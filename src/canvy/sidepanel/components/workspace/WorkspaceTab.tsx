import type {
  CanvyTaskKind,
  SessionMessage,
  TaskClassification,
  WorkflowActionId,
  WorkflowRoute,
  WorkflowState
} from '../../../shared/types';
import { ExtraInstructionsCard } from './ExtraInstructionsCard';
import { WorkflowActionsCard } from './WorkflowActionsCard';
import { WorkflowHeaderCard } from './WorkflowHeaderCard';
import { WorkflowOutputCard } from './WorkflowOutputCard';

interface WorkspaceTabProps {
  configured: boolean;
  busy: boolean;
  workflowState: WorkflowState | null;
  latestClassification?: TaskClassification;
  latestWorkflowRoute?: WorkflowRoute;
  messages: SessionMessage[];
  instructions: string;
  currentActionId?: WorkflowActionId | null;
  onConfigure: () => void;
  onInstructionsChange: (value: string) => void;
  onActionClick: (actionId: WorkflowActionId, task: CanvyTaskKind) => void;
  onApplyInstructions: () => void;
}

function shouldShowInstructions(workflowType?: string) {
  return workflowType === 'file_assignment' || workflowType === 'discussion_post' || workflowType === 'quiz';
}

function activityTitle(workflowType?: string) {
  switch (workflowType) {
    case 'resource':
      return 'Resource workflow updates';
    case 'file_assignment':
      return 'Assignment workflow updates';
    case 'discussion_post':
      return 'Discussion workflow updates';
    case 'quiz':
      return 'Quiz-support workflow updates';
    default:
      return 'Workflow updates';
  }
}

export function WorkspaceTab({
  configured,
  busy,
  workflowState,
  latestClassification,
  latestWorkflowRoute,
  messages,
  instructions,
  currentActionId,
  onConfigure,
  onInstructionsChange,
  onActionClick,
  onApplyInstructions
}: WorkspaceTabProps) {
  return (
    <>
      {!configured ? (
        <section className="canvy-card">
          <div className="canvy-eyebrow">Configure</div>
          <h3>Hey there, I&apos;m Canvy, your page-aware assistant.</h3>
          <p>
            I&apos;m going to read over your past work so I can understand your writing tone, style, and structure. Scan a page first, then run setup so Canvy can calibrate your workflow output.
          </p>
          <button className="canvy-primary" type="button" onClick={onConfigure} disabled={busy}>
            {busy ? 'Configuring...' : 'Configure Canvy'}
          </button>
        </section>
      ) : null}

      <WorkflowHeaderCard workflowState={workflowState} workflowRoute={latestWorkflowRoute} classification={workflowState?.classification ?? null} />

      <WorkflowOutputCard shell={workflowState?.outputShell ?? null} />

      <WorkflowActionsCard
        workflowType={workflowState?.currentWorkflow}
        actions={workflowState?.actionCards ?? []}
        currentActionId={currentActionId ?? workflowState?.currentAction}
        disabled={busy}
        onActionClick={onActionClick}
      />

      <ExtraInstructionsCard
        prompt={workflowState?.assistantPrompt ?? 'Is there anything else I need to know before starting?'}
        instructions={instructions}
        busy={busy}
        submitLabel="Apply instructions"
        showPrompt={shouldShowInstructions(workflowState?.currentWorkflow)}
        onChange={onInstructionsChange}
        onSubmit={onApplyInstructions}
      />

      <section className="canvy-card">
        <div className="canvy-eyebrow">Recent Activity</div>
        <h3>{activityTitle(workflowState?.currentWorkflow)}</h3>
        {workflowState?.classification?.detectedSignals.length ? (
          <div className="canvy-panel-inline-note">
            Signals: <strong>{workflowState.classification.detectedSignals.slice(0, 4).join(' | ')}</strong>
          </div>
        ) : null}
        <div className="canvy-message-thread">
          {messages.slice(-6).map((message) => (
            <div
              key={message.id}
              className={`canvy-message ${message.role === 'assistant' ? 'canvy-message-assistant' : 'canvy-message-user'}`}
            >
              <div className="canvy-eyebrow">{message.role === 'assistant' ? 'Canvy' : 'You'}</div>
              <p>{message.text}</p>
            </div>
          ))}
        </div>
        {!messages.length ? <p className="canvy-muted">Workflow activity will appear here after you start a workflow action.</p> : null}
        {latestClassification && !workflowState ? (
          <div className="canvy-inline-warning">A page was classified, but the workflow shell has not been built yet. Refresh or scan the page again.</div>
        ) : null}
      </section>
    </>
  );
}
