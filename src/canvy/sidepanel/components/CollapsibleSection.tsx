import type { ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CollapsibleSection({ title, subtitle, defaultOpen = false, children }: CollapsibleSectionProps) {
  return (
    <details className="canvy-accordion" open={defaultOpen}>
      <summary className="canvy-accordion-summary">
        <div>
          <div className="canvy-accordion-title">{title}</div>
          {subtitle ? <div className="canvy-accordion-subtitle">{subtitle}</div> : null}
        </div>
        <span className="canvy-accordion-icon" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="canvy-accordion-content">{children}</div>
    </details>
  );
}
