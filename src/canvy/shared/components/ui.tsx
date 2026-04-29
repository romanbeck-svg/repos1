import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes
} from 'react';
import { LazyMotion, domAnimation, m } from 'motion/react';
import type { HTMLMotionProps } from 'motion/react';
import { useReducedMotionPreference } from '../hooks/useDripReveal';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

const SURFACE_EASE = [0.2, 0.8, 0.2, 1] as const;

type IconName =
  | 'spark'
  | 'workspace'
  | 'scan'
  | 'question'
  | 'notes'
  | 'refresh'
  | 'close'
  | 'minimize'
  | 'pin'
  | 'chevron-left'
  | 'chevron-right'
  | 'arrow-right'
  | 'settings'
  | 'warning'
  | 'success'
  | 'page'
  | 'quiz'
  | 'next';

function renderIconPath(name: IconName) {
  switch (name) {
    case 'workspace':
      return (
        <>
          <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h12a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" />
          <path d="M8 4v16" />
        </>
      );
    case 'scan':
      return (
        <>
          <path d="M8 4H6.5A2.5 2.5 0 0 0 4 6.5V8" />
          <path d="M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8" />
          <path d="M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16" />
          <path d="M16 20h1.5a2.5 2.5 0 0 0 2.5-2.5V16" />
          <path d="M7 12h10" />
        </>
      );
    case 'question':
      return (
        <>
          <path d="M9.2 9.25a2.9 2.9 0 1 1 5.14 1.84c-.86.97-1.84 1.48-1.84 2.91" />
          <path d="M12.5 17h.01" />
          <circle cx="12" cy="12" r="8.5" />
        </>
      );
    case 'notes':
      return (
        <>
          <path d="M7.5 6.5h9" />
          <path d="M7.5 11h9" />
          <path d="M7.5 15.5h6" />
          <path d="M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4z" />
        </>
      );
    case 'refresh':
      return (
        <>
          <path d="M20 8.5V4h-4.5" />
          <path d="M19 5a7.5 7.5 0 1 0 1.2 8.38" />
        </>
      );
    case 'close':
      return (
        <>
          <path d="M7 7l10 10" />
          <path d="M17 7L7 17" />
        </>
      );
    case 'minimize':
      return <path d="M6.5 12.5h11" />;
    case 'pin':
      return (
        <>
          <path d="M9 4.5h6l-1.5 5 2.5 2.5h-8l2.5-2.5z" />
          <path d="M12 12v7.5" />
        </>
      );
    case 'chevron-left':
      return <path d="M14.5 6.5L9 12l5.5 5.5" />;
    case 'chevron-right':
      return <path d="M9.5 6.5L15 12l-5.5 5.5" />;
    case 'arrow-right':
      return (
        <>
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </>
      );
    case 'settings':
      return (
        <>
          <path d="M12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5z" />
          <path d="M4.75 12a7.9 7.9 0 0 1 .12-1.4l-1.87-1.46 1.9-3.3 2.28.72a7.92 7.92 0 0 1 2.42-1.4L10 2.75h4l.4 2.41a7.92 7.92 0 0 1 2.42 1.4l2.28-.72 1.9 3.3-1.87 1.46a7.9 7.9 0 0 1 0 2.8l1.87 1.46-1.9 3.3-2.28-.72a7.92 7.92 0 0 1-2.42 1.4L14 21.25h-4l-.4-2.41a7.92 7.92 0 0 1-2.42-1.4l-2.28.72-1.9-3.3 1.87-1.46c-.08-.46-.12-.93-.12-1.4z" />
        </>
      );
    case 'warning':
      return (
        <>
          <path d="M12 8v5" />
          <path d="M12 16.75h.01" />
          <path d="M10 3.9 2.9 17a1.35 1.35 0 0 0 1.18 2h15.84A1.35 1.35 0 0 0 21.1 17L14 3.9a1.35 1.35 0 0 0-2 0z" />
        </>
      );
    case 'success':
      return (
        <>
          <path d="M6.5 12.5 10 16l7.5-8" />
          <circle cx="12" cy="12" r="8.5" />
        </>
      );
    case 'page':
      return (
        <>
          <path d="M7 4.5h7l3 3v12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6 19.5v-13A1.5 1.5 0 0 1 7.5 5z" />
          <path d="M14 4.5v3h3" />
        </>
      );
    case 'quiz':
      return (
        <>
          <path d="M6.5 7.5h11" />
          <path d="M6.5 12h6.5" />
          <path d="M6.5 16.5h5" />
          <circle cx="17.5" cy="15.5" r="3.5" />
          <path d="m16.2 15.4.95.95 1.65-1.9" />
        </>
      );
    case 'next':
      return (
        <>
          <path d="M6 8.5c1.5-2 4-3 6.25-2.56A6.25 6.25 0 0 1 18 12.12" />
          <path d="M18 9.25v2.9h-2.9" />
          <path d="M18 15.5c-1.5 2-4 3-6.25 2.56A6.25 6.25 0 0 1 6 11.88" />
          <path d="M6 14.75v-2.9h2.9" />
        </>
      );
    case 'spark':
    default:
      return (
        <>
          <path d="M12 2.75 13.96 8l5.29 2.04L13.96 12l-1.96 5.25L10.04 12l-5.29-1.96L10.04 8z" />
          <path d="m18.75 4.5.63 1.69 1.7.63-1.7.63-.63 1.69-.63-1.69-1.7-.63 1.7-.63z" />
        </>
      );
  }
}

export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={cx('mako-icon', className)}
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {renderIconPath(name)}
    </svg>
  );
}

export function AppIcon({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <div className={cx('mako-app-icon', className)} aria-hidden="true" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" width={size} height={size} fill="none">
        <defs>
          <linearGradient id="mako-app-icon-gradient" x1="6" y1="6" x2="30" y2="30" gradientUnits="userSpaceOnUse">
            <stop stopColor="#67E8F9" />
            <stop offset="0.48" stopColor="#22D3EE" />
            <stop offset="1" stopColor="#06B6D4" />
          </linearGradient>
        </defs>
        <rect x="3.5" y="3.5" width="29" height="29" rx="10" fill="#05070A" />
        <rect x="4.5" y="4.5" width="27" height="27" rx="9" stroke="url(#mako-app-icon-gradient)" strokeWidth="1.4" />
        <path
          d="M9.5 24.25 14.1 11.6c.18-.5.86-.58 1.16-.14L18 15.52l2.74-4.06c.3-.44.98-.36 1.16.14l4.6 12.65"
          stroke="url(#mako-app-icon-gradient)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M13.6 20.05h8.8" stroke="#CFFAFE" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}

interface AppShellProps extends Omit<HTMLMotionProps<'main'>, 'children'> {
  surface: 'popup' | 'panel' | 'options';
  children: ReactNode;
  animated?: boolean;
}

export function AppShell({ surface, className, children, animated = true, ...props }: AppShellProps) {
  const reducedMotion = useReducedMotionPreference();

  return (
    <m.main
      className={cx('mako-app', `mako-app--${surface}`, className)}
      initial={reducedMotion || !animated ? false : { opacity: 0, y: 10, scale: 0.988 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.22, ease: SURFACE_EASE }}
      {...props}
    >
      {children}
    </m.main>
  );
}

export const SurfaceShell = AppShell;

interface WorkspaceShellProps extends HTMLAttributes<HTMLDivElement> {
  surface: 'popup' | 'panel' | 'options' | 'overlay';
  children: ReactNode;
}

export function WorkspaceShell({ surface, className, children, ...props }: WorkspaceShellProps) {
  return (
    <div className={cx('mako-shell', `mako-shell--${surface}`, className)} {...props}>
      {children}
    </div>
  );
}

export const OverlayShell = WorkspaceShell;

interface GlassPanelProps extends Omit<HTMLMotionProps<'section'>, 'children'> {
  children: ReactNode;
  tone?: 'default' | 'hero' | 'soft' | 'elevated' | 'quiet';
  animated?: boolean;
}

export function GlassPanel({
  children,
  className,
  tone = 'default',
  animated = true,
  ...props
}: GlassPanelProps) {
  const reducedMotion = useReducedMotionPreference();

  return (
    <m.section
      className={cx('mako-panel', `mako-panel--${tone}`, className)}
      initial={animated && !reducedMotion ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: SURFACE_EASE }}
      {...props}
    >
      {children}
    </m.section>
  );
}

export const GlassSurface = GlassPanel;
export const GlassCard = GlassPanel;
export const Card = GlassPanel;
export const FloatingPanel = GlassPanel;
export const ActionPanel = GlassPanel;

interface GlassToolbarProps extends Omit<GlassPanelProps, 'tone'> {
  tone?: GlassPanelProps['tone'];
}

export function GlassToolbar({ className, tone = 'hero', ...props }: GlassToolbarProps) {
  return <GlassPanel className={cx('mako-toolbar', className)} tone={tone} {...props} />;
}

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function SectionHeader({ eyebrow, title, description, meta, actions }: SectionHeaderProps) {
  return (
    <div className="mako-section-header">
      <div className="mako-section-header__copy">
        {eyebrow ? <p className="mako-eyebrow">{eyebrow}</p> : null}
        <h2 className="mako-section-header__title">{title}</h2>
        {description ? <p className="mako-section-header__description">{description}</p> : null}
      </div>

      {meta || actions ? (
        <div className="mako-section-header__meta">
          {meta}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('mako-section-label', className)}>{children}</span>;
}

interface StatusPillProps {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  icon?: ReactNode;
}

export function StatusPill({ label, tone = 'neutral', icon }: StatusPillProps) {
  return (
    <span className={cx('mako-pill', `mako-pill--${tone}`)}>
      {icon ? <span className="mako-pill__icon">{icon}</span> : null}
      <span>{label}</span>
    </span>
  );
}

export const Badge = StatusPill;
export const StatusChip = StatusPill;

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
}

export function GlassButton({
  children,
  className,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  leadingIcon,
  trailingIcon,
  loading = false,
  ...props
}: GlassButtonProps) {
  return (
    <button
      className={cx('mako-button', `mako-button--${variant}`, `mako-button--${size}`, className)}
      type={type}
      {...props}
    >
      {leadingIcon ? <span className="mako-button__icon">{leadingIcon}</span> : null}
      <span className="mako-button__label">{children}</span>
      {loading ? <span className="mako-button__spinner" aria-hidden="true" /> : null}
      {!loading && trailingIcon ? <span className="mako-button__icon">{trailingIcon}</span> : null}
    </button>
  );
}

export const Button = GlassButton;

export function PrimaryButton(props: Omit<GlassButtonProps, 'variant'>) {
  return <GlassButton variant="primary" {...props} />;
}

export function SecondaryButton(props: Omit<GlassButtonProps, 'variant'>) {
  return <GlassButton variant="secondary" {...props} />;
}

export function GhostButton(props: Omit<GlassButtonProps, 'variant'>) {
  return <GlassButton variant="ghost" {...props} />;
}

interface GlassIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  active?: boolean;
}

export function GlassIconButton({ icon, label, active = false, className, ...props }: GlassIconButtonProps) {
  return (
    <button
      className={cx('mako-icon-button', active && 'mako-icon-button--active', className)}
      type="button"
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
    </button>
  );
}

export const IconButton = GlassIconButton;

export function GlassInput({ className, type = 'text', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('mako-input', className)} type={type} {...props} />;
}

export const Input = GlassInput;
export const FollowUpInput = GlassInput;

export function GlassTextarea({ className, rows = 4, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('mako-textarea', className)} rows={rows} {...props} />;
}

export const Textarea = GlassTextarea;

interface TooltipProps extends HTMLAttributes<HTMLSpanElement> {
  label: string;
  children: ReactNode;
}

export function Tooltip({ label, children, className, ...props }: TooltipProps) {
  return (
    <span className={cx('mako-tooltip', className)} {...props}>
      {children}
      <span className="mako-tooltip__content" role="tooltip">
        {label}
      </span>
    </span>
  );
}

interface FollowUpComposerProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  submitLabel: string;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  footer?: ReactNode;
  multiline?: boolean;
  className?: string;
  inputClassName?: string;
  loading?: boolean;
  onKeyDown?: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'] &
    InputHTMLAttributes<HTMLInputElement>['onKeyDown'];
}

export function FollowUpComposer({
  id,
  label,
  value,
  onChange,
  submitLabel,
  onSubmit,
  disabled,
  placeholder,
  rows = 4,
  footer,
  multiline = false,
  className,
  inputClassName,
  loading = false,
  onKeyDown
}: FollowUpComposerProps) {
  return (
    <form
      className={cx('mako-composer', multiline ? 'mako-composer--stacked' : 'mako-composer--inline', className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) {
          onSubmit();
        }
      }}
    >
      <label className="mako-field" htmlFor={id}>
        <span className="mako-field__label">{label}</span>
        {multiline ? (
          <GlassTextarea
            id={id}
            className={inputClassName}
            rows={rows}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown as TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown']}
          />
        ) : (
          <GlassInput
            id={id}
            className={inputClassName}
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown as InputHTMLAttributes<HTMLInputElement>['onKeyDown']}
          />
        )}
      </label>

      <GlassButton variant="primary" size={multiline ? 'lg' : 'md'} type="submit" disabled={disabled} loading={loading}>
        {submitLabel}
      </GlassButton>

      {footer ? <div className="mako-composer__footer">{footer}</div> : null}
    </form>
  );
}

export function PromptComposer(props: FollowUpComposerProps) {
  return <FollowUpComposer multiline rows={4} {...props} />;
}

interface ActionTileProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  title: string;
  copy: string;
  icon?: ReactNode;
  kicker?: string;
  tone?: 'default' | 'accent' | 'warning';
  active?: boolean;
}

export function ActionTile({
  title,
  copy,
  icon,
  kicker,
  tone = 'default',
  active = false,
  className,
  type = 'button',
  ...props
}: ActionTileProps) {
  return (
    <button
      className={cx(
        'mako-action-tile',
        `mako-action-tile--${tone}`,
        active && 'mako-action-tile--active',
        className
      )}
      type={type}
      {...props}
    >
      <div className="mako-action-tile__header">
        {icon ? <span className="mako-action-tile__icon">{icon}</span> : null}
        {kicker ? <span className="mako-action-tile__kicker">{kicker}</span> : null}
      </div>
      <span className="mako-action-tile__title">{title}</span>
      <span className="mako-action-tile__copy">{copy}</span>
    </button>
  );
}

export function WorkspaceActionGroup({
  title,
  description,
  children,
  meta
}: {
  title: string;
  description?: string;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <GlassPanel tone="soft" className="mako-action-group">
      <SectionHeader eyebrow="Actions" title={title} description={description} meta={meta} />
      <div className="mako-action-grid">{children}</div>
    </GlassPanel>
  );
}

interface AnswerCardProps {
  eyebrow?: string;
  title: string;
  answer: string;
  subtitle?: string;
  meta?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function AnswerCard({
  eyebrow = 'Recommended answer',
  title,
  answer,
  subtitle,
  meta,
  footer,
  className
}: AnswerCardProps) {
  return (
    <GlassPanel tone="elevated" className={cx('mako-answer-card', className)}>
      <SectionHeader eyebrow={eyebrow} title={title} description={subtitle} meta={meta} />
      <div className="mako-answer-card__body">
        <p className="mako-answer-card__answer">{answer}</p>
      </div>
      {footer ? <div className="mako-answer-card__footer">{footer}</div> : null}
    </GlassPanel>
  );
}

export function RecommendedAnswer({ eyebrow = 'Recommended answer', ...props }: AnswerCardProps) {
  return <AnswerCard eyebrow={eyebrow} {...props} />;
}

export const AnswerBubble = AnswerCard;

export function SuggestedNotesCard({
  notes,
  title = 'Suggested notes',
  description,
  emptyMessage = 'Suggested notes will appear when the answer has something worth carrying forward.',
  className
}: {
  notes: string[];
  title?: string;
  description?: string;
  emptyMessage?: string;
  className?: string;
}) {
  return (
    <GlassPanel tone="quiet" className={cx('mako-notes-card', className)}>
      <SectionHeader eyebrow="Notes" title={title} description={description} />
      {notes.length ? (
        <ul className="mako-list">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="mako-muted">{emptyMessage}</p>
      )}
    </GlassPanel>
  );
}

interface StatePanelProps {
  title: string;
  body: string;
  tone?: 'default' | 'warning' | 'danger';
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: Omit<StatePanelProps, 'tone'>) {
  return (
    <GlassPanel tone="quiet" className="mako-state-panel">
      <SectionHeader eyebrow="Ready" title={title} description={body} />
      {action ? <div className="mako-state-panel__action">{action}</div> : null}
    </GlassPanel>
  );
}

export function LoadingState({ title, body, action }: Omit<StatePanelProps, 'tone'>) {
  return (
    <GlassPanel tone="quiet" className="mako-state-panel">
      <SectionHeader eyebrow="Working" title={title} description={body} />
      <div className="mako-loading-bar" aria-hidden="true" />
      {action ? <div className="mako-state-panel__action">{action}</div> : null}
    </GlassPanel>
  );
}

export function FailureState({ title, body, tone = 'warning', action }: StatePanelProps) {
  return (
    <GlassPanel tone="quiet" className="mako-state-panel">
      <SectionHeader
        eyebrow="Needs review"
        title={title}
        description={body}
        meta={<StatusPill label={tone === 'danger' ? 'Issue' : 'Limited'} tone={tone === 'danger' ? 'danger' : 'warning'} />}
      />
      {action ? <div className="mako-state-panel__action">{action}</div> : null}
    </GlassPanel>
  );
}

export const ErrorState = FailureState;

interface InlineNoticeProps {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'success' | 'danger';
}

export function InlineNotice({ children, tone = 'info' }: InlineNoticeProps) {
  return <div className={cx('mako-notice', `mako-notice--${tone}`)}>{children}</div>;
}

export function SkeletonSurface({ label = 'Loading Mako IQ' }: { label?: string }) {
  return (
    <GlassPanel className="mako-skeleton" aria-label={label}>
      <div className="mako-skeleton__line mako-skeleton__line--title" />
      <div className="mako-skeleton__line" />
      <div className="mako-skeleton__line mako-skeleton__line--short" />
    </GlassPanel>
  );
}

export function Divider() {
  return <div className="mako-divider" aria-hidden="true" />;
}

export function GlowDivider() {
  return <Divider />;
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

export function ToggleRow({
  title,
  description,
  checked,
  onChange
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="mako-toggle">
      <div className="mako-toggle__copy">
        <span className="mako-toggle__title">{title}</span>
        <span className="mako-toggle__description">{description}</span>
      </div>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
