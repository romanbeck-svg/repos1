import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { HTMLMotionProps } from 'motion/react';
import { useReducedMotionPreference } from '../hooks/useDripReveal';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

const DEFAULT_EASE = [0.2, 0.9, 0.24, 1] as const;

export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

interface AppShellProps extends Omit<HTMLMotionProps<'main'>, 'children'> {
  surface: 'popup' | 'panel' | 'options';
  children: ReactNode;
}

export function AppShell({ surface, className, children, ...props }: AppShellProps) {
  const reducedMotion = useReducedMotionPreference();

  return (
    <m.main
      className={cx('mako-app', `mako-app--${surface}`, className)}
      initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.992 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: DEFAULT_EASE }}
      {...props}
    >
      {children}
    </m.main>
  );
}

interface GlassSurfaceProps extends Omit<HTMLMotionProps<'section'>, 'children'> {
  children: ReactNode;
  tone?: 'default' | 'hero' | 'soft' | 'elevated';
  animated?: boolean;
}

export function GlassSurface({
  children,
  className,
  tone = 'default',
  animated = true,
  ...props
}: GlassSurfaceProps) {
  const reducedMotion = useReducedMotionPreference();

  return (
    <m.section
      className={cx('mako-surface', `mako-surface--${tone}`, className)}
      initial={animated && !reducedMotion ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: DEFAULT_EASE }}
      {...props}
    >
      {children}
    </m.section>
  );
}

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: ReactNode;
}

export function SectionHeader({ eyebrow, title, description, meta }: SectionHeaderProps) {
  return (
    <div className="mako-section-header">
      <div className="mako-section-header__copy">
        {eyebrow ? <div className="mako-eyebrow">{eyebrow}</div> : null}
        <h2 className="mako-section-header__title">{title}</h2>
        {description ? <p className="mako-section-header__description">{description}</p> : null}
      </div>
      {meta ? <div className="mako-section-header__meta">{meta}</div> : null}
    </div>
  );
}

interface StatusPillProps {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}

export function StatusPill({ label, tone = 'neutral' }: StatusPillProps) {
  return <span className={cx('mako-pill', `mako-pill--${tone}`)}>{label}</span>;
}

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export function GlassButton({
  children,
  className,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  ...props
}: GlassButtonProps) {
  return (
    <button
      className={cx('mako-button', `mako-button--${variant}`, `mako-button--${size}`, className)}
      type={type}
      {...props}
    >
      <span className="mako-button__label">{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  label: string;
}

export function IconButton({ icon, label, className, ...props }: IconButtonProps) {
  return (
    <button className={cx('mako-icon-button', className)} type="button" aria-label={label} title={label} {...props}>
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}

interface ActionTileProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  title: string;
  copy: string;
  kicker?: string;
  tone?: 'default' | 'accent';
}

export function ActionTile({
  title,
  copy,
  kicker,
  tone = 'default',
  className,
  type = 'button',
  ...props
}: ActionTileProps) {
  return (
    <button className={cx('mako-action-tile', `mako-action-tile--${tone}`, className)} type={type} {...props}>
      {kicker ? <span className="mako-action-tile__kicker">{kicker}</span> : null}
      <span className="mako-action-tile__title">{title}</span>
      <span className="mako-action-tile__copy">{copy}</span>
    </button>
  );
}

interface PromptComposerProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  submitLabel: string;
  onSubmit: () => void;
  disabled?: boolean;
  footer?: ReactNode;
}

export function PromptComposer({
  id,
  label,
  value,
  onChange,
  submitLabel,
  onSubmit,
  disabled,
  footer,
  rows = 4,
  className,
  ...props
}: PromptComposerProps) {
  return (
    <div className={cx('mako-composer', className)}>
      <label className="mako-field" htmlFor={id}>
        <span className="mako-field__label">{label}</span>
        <textarea
          id={id}
          className="mako-textarea"
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...props}
        />
      </label>
      <GlassButton variant="primary" size="lg" onClick={onSubmit} disabled={disabled}>
        {submitLabel}
      </GlassButton>
      {footer ? <div className="mako-composer__footer">{footer}</div> : null}
    </div>
  );
}

interface InlineNoticeProps {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'success' | 'danger';
}

export function InlineNotice({ children, tone = 'info' }: InlineNoticeProps) {
  return <div className={cx('mako-notice', `mako-notice--${tone}`)}>{children}</div>;
}

export function SkeletonSurface({ label = 'Loading Mako IQ' }: { label?: string }) {
  return (
    <GlassSurface className="mako-skeleton" aria-label={label}>
      <div className="mako-skeleton__line mako-skeleton__line--title" />
      <div className="mako-skeleton__line" />
      <div className="mako-skeleton__line mako-skeleton__line--short" />
    </GlassSurface>
  );
}

export function Divider() {
  return <div className="mako-divider" aria-hidden="true" />;
}

interface StatProps {
  label: string;
  value: string;
}

export function StatTile({ label, value }: StatProps) {
  return (
    <div className="mako-stat">
      <span className="mako-stat__label">{label}</span>
      <strong className="mako-stat__value">{value}</strong>
    </div>
  );
}
