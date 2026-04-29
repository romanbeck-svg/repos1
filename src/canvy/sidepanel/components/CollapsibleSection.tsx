import { useState, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { GlassSurface } from '../../shared/components/ui';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  animated?: boolean;
  children: ReactNode;
}

export function CollapsibleSection({ title, subtitle, defaultOpen = false, animated = true, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <GlassSurface className="mako-accordion" tone="soft" animated={false}>
      <button
        type="button"
        className="mako-accordion__trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <div className="mako-accordion__summary">
          <div className="mako-accordion__title">{title}</div>
          {subtitle ? <div className="mako-accordion__subtitle">{subtitle}</div> : null}
        </div>
        <span className="mako-accordion__icon" aria-hidden="true">
          {open ? '-' : '+'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <m.div
            className="mako-accordion__content"
            initial={animated ? { height: 0, opacity: 0 } : false}
            animate={{ height: 'auto', opacity: 1 }}
            exit={animated ? { height: 0, opacity: 0 } : { opacity: 0 }}
            transition={{ duration: animated ? 0.18 : 0.01, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mako-accordion__body">{children}</div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </GlassSurface>
  );
}
