import type { ReactNode } from 'react';

interface OutputSectionProps {
  title: string;
  body: string | string[] | undefined;
  tone?: 'default' | 'explanation' | 'success';
  actions?: ReactNode;
}

export function OutputSection({ title, body, tone = 'default', actions }: OutputSectionProps) {
  if (!body || (Array.isArray(body) && body.length === 0)) {
    return null;
  }

  return (
    <section className={`canvy-card canvy-output-${tone}`}>
      <div className="canvy-card-head">
        <div>
          <div className="canvy-eyebrow">Output</div>
          <h3>{title}</h3>
        </div>
        {actions}
      </div>
      {Array.isArray(body) ? (
        <ul className="canvy-list">
          {body.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <div className="canvy-copy-block">{body}</div>
      )}
    </section>
  );
}
