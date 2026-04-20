import type { WorkflowOutputShell as WorkflowOutputShellType } from '../../shared/types';

interface WorkflowOutputShellProps {
  shell: WorkflowOutputShellType;
}

export function WorkflowOutputShell({ shell }: WorkflowOutputShellProps) {
  const sections =
    shell.type === 'resource'
      ? [
          { title: 'Summary', content: shell.summary },
          { title: 'Key points', content: shell.keyPoints.join(' | ') },
          { title: 'Suggested use', content: shell.suggestedUse }
        ]
      : shell.type === 'file_assignment'
        ? [
            { title: 'Task', content: shell.task },
            { title: 'Draft Answer', content: shell.draftAnswer },
            { title: 'Explanation', content: shell.explanation }
          ]
        : shell.type === 'discussion_post'
          ? [
              { title: 'Prompt', content: shell.prompt },
              { title: 'Draft Response', content: shell.draftResponse },
              { title: 'Notes', content: shell.notes }
            ]
          : shell.type === 'quiz'
            ? [
                { title: 'Question support', content: shell.questionSupport },
                { title: 'Answer', content: shell.answer },
                { title: 'Explanation', content: shell.explanation }
              ]
            : [
                { title: 'Summary', content: shell.summary },
                { title: 'Key points', content: shell.keyPoints.join(' | ') },
                { title: 'Suggested next step', content: shell.suggestedNextStep }
              ];

  return (
    <section className="canvy-card">
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">Output Shell</div>
          <h3>{shell.title}</h3>
        </div>
      </div>
      <p className="canvy-muted">{shell.intro}</p>
      <div className="canvy-panel-output-grid">
        {sections.map((section) => (
          <div key={section.title} className="canvy-panel-output-card">
            <div className="canvy-eyebrow">{section.title}</div>
            <p className="canvy-copy-block">{section.content}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
