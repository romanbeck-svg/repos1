import type { CanvyTaskKind } from '../../shared/types';

interface ComposerProps {
  instructions: string;
  selectedTask: CanvyTaskKind | null;
  submitLabel?: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

const LABELS: Record<CanvyTaskKind, string> = {
  analyze_assignment: 'Analyze assignment',
  build_draft: 'Build draft',
  explain_page: 'Explain page',
  summarize_reading: 'Summarize reading',
  discussion_post: 'Help with discussion post',
  quiz_assist: 'Quiz-safe study help'
};

export function Composer({ instructions, selectedTask, submitLabel, busy, onChange, onSubmit }: ComposerProps) {
  const buttonLabel = submitLabel || (selectedTask ? LABELS[selectedTask] : 'Choose an action');

  return (
    <section className="canvy-card">
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">Before Processing</div>
          <h3>Are there any extra instructions before I continue?</h3>
        </div>
      </div>
      <textarea
        className="canvy-textarea"
        value={instructions}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Examples: keep this concise, use APA placeholders, aim for a more casual tone, focus on the rubric."
        rows={4}
      />
      <button className="canvy-primary" type="button" disabled={!selectedTask || busy} onClick={onSubmit}>
        {busy ? 'Working...' : buttonLabel}
      </button>
    </section>
  );
}
