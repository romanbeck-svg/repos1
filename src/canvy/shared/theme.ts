export const MAKO_THEME_TOKENS = {
  bg0: '#05070A',
  bg1: '#081018',
  bg2: '#0B1722',
  cyan1: '#22D3EE',
  cyan2: '#06B6D4',
  cyan3: '#67E8F9',
  cyanGlow: 'rgba(34, 211, 238, 0.30)',
  surfaceDark: 'rgba(7, 14, 20, 0.82)',
  surfaceGlass: 'rgba(15, 23, 32, 0.66)',
  surfaceRaised: 'rgba(18, 31, 42, 0.78)',
  border: 'rgba(103, 232, 249, 0.22)',
  borderStrong: 'rgba(103, 232, 249, 0.38)',
  textPrimary: '#F4FBFF',
  textSecondary: 'rgba(244, 251, 255, 0.74)',
  textMuted: 'rgba(244, 251, 255, 0.52)',
  danger: '#FB7185',
  success: '#22C55E',
  warning: '#F59E0B'
} as const;

export const MAKO_THEME_CSS = `
  --mako-bg-0: ${MAKO_THEME_TOKENS.bg0};
  --mako-bg-1: ${MAKO_THEME_TOKENS.bg1};
  --mako-bg-2: ${MAKO_THEME_TOKENS.bg2};
  --mako-cyan-1: ${MAKO_THEME_TOKENS.cyan1};
  --mako-cyan-2: ${MAKO_THEME_TOKENS.cyan2};
  --mako-cyan-3: ${MAKO_THEME_TOKENS.cyan3};
  --mako-cyan-glow: ${MAKO_THEME_TOKENS.cyanGlow};
  --mako-surface-dark: ${MAKO_THEME_TOKENS.surfaceDark};
  --mako-surface-glass: ${MAKO_THEME_TOKENS.surfaceGlass};
  --mako-surface-raised: ${MAKO_THEME_TOKENS.surfaceRaised};
  --mako-border: ${MAKO_THEME_TOKENS.border};
  --mako-border-strong: ${MAKO_THEME_TOKENS.borderStrong};
  --mako-text-primary: ${MAKO_THEME_TOKENS.textPrimary};
  --mako-text-secondary: ${MAKO_THEME_TOKENS.textSecondary};
  --mako-text-muted: ${MAKO_THEME_TOKENS.textMuted};
  --mako-danger: ${MAKO_THEME_TOKENS.danger};
  --mako-success: ${MAKO_THEME_TOKENS.success};
  --mako-warning: ${MAKO_THEME_TOKENS.warning};
`;
