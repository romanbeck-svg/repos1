import type { WorkflowOutputShell } from '../../../shared/types';

interface WorkflowOutputCardProps {
  shell: WorkflowOutputShell | null;
}

export function WorkflowOutputCard({ shell }: WorkflowOutputCardProps) {
  if (!shell) {
    return null;
  }

  const chartSummary = shell.chart
    ? [
        `${shell.chart.type.toUpperCase()} | ${shell.chart.title}`,
        shell.chart.labels.length ? `Labels: ${shell.chart.labels.join(', ')}` : '',
        ...shell.chart.datasets.map((dataset) => `${dataset.label}: ${dataset.data.join(', ')}`)
      ]
        .filter(Boolean)
        .join(' | ')
    : '';
  const actionSummary = shell.actions?.length ? shell.actions.join(' | ') : '';

  const entries =
    shell.type === 'resource'
      ? [
          { title: 'Summary', content: shell.summary },
          { title: 'Key points / notes', content: shell.keyPoints.join(' | ') },
          { title: 'Suggested use', content: shell.suggestedUse },
          ...(chartSummary ? [{ title: 'Chart', content: chartSummary }] : []),
          ...(actionSummary ? [{ title: 'Actions', content: actionSummary }] : [])
        ]
      : shell.type === 'file_assignment'
        ? [
            { title: 'Task', content: shell.task },
            { title: 'Draft Answer', content: shell.draftAnswer },
            { title: 'Explanation', content: shell.explanation },
            ...(chartSummary ? [{ title: 'Chart', content: chartSummary }] : []),
            ...(actionSummary ? [{ title: 'Actions', content: actionSummary }] : [])
          ]
        : shell.type === 'discussion_post'
          ? [
              { title: 'Prompt', content: shell.prompt },
              { title: 'Draft Response', content: shell.draftResponse },
              { title: 'Notes', content: shell.notes },
              ...(chartSummary ? [{ title: 'Chart', content: chartSummary }] : []),
              ...(actionSummary ? [{ title: 'Actions', content: actionSummary }] : [])
            ]
          : shell.type === 'quiz'
            ? [
                { title: 'Question support', content: shell.questionSupport },
                { title: 'Answer', content: shell.answer },
                { title: 'Explanation', content: shell.explanation },
                ...(chartSummary ? [{ title: 'Chart', content: chartSummary }] : []),
                ...(actionSummary ? [{ title: 'Actions', content: actionSummary }] : [])
              ]
          : [
              { title: 'Summary', content: shell.summary },
              { title: 'Key points', content: shell.keyPoints.join(' | ') },
              { title: 'Suggested next step', content: shell.suggestedNextStep },
              ...(chartSummary ? [{ title: 'Chart', content: chartSummary }] : []),
              ...(actionSummary ? [{ title: 'Actions', content: actionSummary }] : [])
            ];
  const eyebrow =
    shell.type === 'resource'
      ? 'Resource output'
      : shell.type === 'file_assignment'
        ? 'Assignment output'
        : shell.type === 'discussion_post'
          ? 'Discussion output'
          : shell.type === 'quiz'
            ? 'Quiz support'
            : 'General output';

  return (
    <section className="canvy-card">
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">{eyebrow}</div>
          <h3>{shell.title}</h3>
        </div>
      </div>
      <p className="canvy-muted">{shell.intro}</p>
      <div className="canvy-panel-output-grid">
        {entries.map((section) => (
          <div key={section.title} className="canvy-panel-output-card">
            <div className="canvy-eyebrow">{section.title}</div>
            <p className="canvy-copy-block">{section.content}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
