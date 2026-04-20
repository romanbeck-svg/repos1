import type { CanvyTaskKind } from '../../shared/types';

interface ActionTilesProps {
  disabled?: boolean;
  onSelect: (task: CanvyTaskKind) => void;
  actions?: Array<{ task: CanvyTaskKind; label: string; description: string }>;
}

const ACTIONS: Array<{ task: CanvyTaskKind; label: string; description: string }> = [
  {
    task: 'analyze_assignment',
    label: 'Analyze assignment',
    description: 'Break down the prompt, rubric, and key requirements.'
  },
  {
    task: 'build_draft',
    label: 'Build draft',
    description: 'Generate a structured editable draft for written work.'
  },
  {
    task: 'explain_page',
    label: 'Explain page',
    description: 'Explain the current assignment, reading, or question.'
  },
  {
    task: 'summarize_reading',
    label: 'Summarize reading',
    description: 'Turn the visible page into study-ready notes.'
  },
  {
    task: 'discussion_post',
    label: 'Help with discussion post',
    description: 'Draft a post, a shorter version, and tone variants.'
  },
  {
    task: 'quiz_assist',
    label: 'Quiz-safe study help',
    description: 'Explain concepts and answer logic without live-answer injection.'
  }
];

export function ActionTiles({ disabled, onSelect, actions = ACTIONS }: ActionTilesProps) {
  return (
    <div className="canvy-action-grid">
      {actions.map((action) => (
        <button
          key={action.task}
          className="canvy-action-tile"
          type="button"
          onClick={() => onSelect(action.task)}
          disabled={disabled}
        >
          <span>{action.label}</span>
          <small>{action.description}</small>
        </button>
      ))}
    </div>
  );
}
