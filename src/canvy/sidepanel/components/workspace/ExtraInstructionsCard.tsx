interface ExtraInstructionsCardProps {
  prompt: string;
  instructions: string;
  busy: boolean;
  submitLabel: string;
  showPrompt: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function ExtraInstructionsCard({
  prompt,
  instructions,
  busy,
  submitLabel,
  showPrompt,
  onChange,
  onSubmit
}: ExtraInstructionsCardProps) {
  if (!showPrompt) {
    return null;
  }

  const trimmedInstructions = instructions.trim();

  return (
    <section className="canvy-card">
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">Before Starting</div>
          <h3>Is there anything else I need to know before starting?</h3>
        </div>
      </div>
      <p className="canvy-muted">{prompt}</p>
      {trimmedInstructions ? <div className="canvy-panel-inline-note">Instructions are active for this workflow and will be used in the output shell.</div> : null}
      <textarea
        className="canvy-textarea"
        value={instructions}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Examples: keep this concise, use citation placeholders, focus on the rubric, or match a more conversational tone."
        rows={4}
      />
      <button className="canvy-primary" type="button" disabled={busy} onClick={onSubmit}>
        {busy ? 'Saving...' : submitLabel}
      </button>
    </section>
  );
}
