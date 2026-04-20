import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..', '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const downloadsRoot = path.resolve(workspaceRoot, '..');
const resolvedEnvPath = path.resolve(packageRoot, '.env');
const cwdEnvPath = path.resolve(process.cwd(), '.env');
const dotenvResult = dotenv.config({ path: resolvedEnvPath });
const DEFAULT_DEVELOPMENT_JWT_SECRET = 'development-secret';

function required(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function parseNodeEnv(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'test') {
    return normalized;
  }

  return 'development';
}

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value: string | undefined, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function isPlaceholderListValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    normalized.includes('your_extension_id') ||
    normalized.includes('your-service.onrender.com') ||
    normalized.includes('your-backend.example.com') ||
    normalized.includes('replace-with')
  );
}

function parseList(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !isPlaceholderListValue(entry));
}

function isConfiguredSecret(value: string | undefined) {
  const trimmed = value?.trim() || '';
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  return (
    normalized !== 'replace-with-your-real-moonshot-key' &&
    normalized !== 'your_real_key_here' &&
    normalized !== 'your-real-key-here' &&
    normalized !== 'replace-with-a-real-key'
  );
}

const nodeEnv = parseNodeEnv(process.env.NODE_ENV);

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  host: required('HOST', '0.0.0.0'),
  port: parsePort(process.env.PORT, 8787),
  appUrl: required('APP_URL', 'http://localhost:8787'),
  allowedOrigins: parseList(required('ALLOWED_ORIGINS', 'http://localhost:5173')),
  allowedExtensionOrigins: parseList(required('ALLOWED_EXTENSION_ORIGINS')),
  allowAllExtensionOrigins: toBoolean(process.env.ALLOW_ALL_EXTENSION_ORIGINS, nodeEnv !== 'production'),
  allowAnonymousUsage: toBoolean(process.env.ALLOW_ANONYMOUS_USAGE, true),
  aiProvider: required('AI_PROVIDER', 'anthropic'),
  moonshotApiKey: required('MOONSHOT_API_KEY'),
  moonshotModel: required('MOONSHOT_MODEL', 'kimi-k2.5'),
  moonshotQuickModel: required('MOONSHOT_QUICK_MODEL', 'kimi-k2-turbo-preview'),
  moonshotReasoningModel: required('MOONSHOT_REASONING_MODEL', 'kimi-k2-thinking-turbo'),
  moonshotVisionModel: required('MOONSHOT_VISION_MODEL', 'kimi-k2.5'),
  moonshotBaseUrl: required('MOONSHOT_BASE_URL', 'https://api.moonshot.ai/v1'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: required('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
  openAiApiKey: required('OPENAI_API_KEY'),
  openAiModel: required('OPENAI_MODEL', 'gpt-4.1-mini'),
  canvasApiBaseUrl: required('CANVAS_API_BASE_URL'),
  canvasApiToken: required('CANVAS_API_TOKEN'),
  jwtSecret: required('JWT_SECRET', nodeEnv === 'production' ? '' : DEFAULT_DEVELOPMENT_JWT_SECRET),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseJwtSecret: required('SUPABASE_JWT_SECRET'),
  authMagicLinkRedirectUrl: required('AUTH_MAGIC_LINK_REDIRECT_URL', 'http://localhost:8787/auth/callback'),
  stripeSecretKey: required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  stripeMonthlyPriceId: required('STRIPE_MONTHLY_PRICE_ID'),
  stripePortalReturnUrl: required('STRIPE_PORTAL_RETURN_URL', 'http://localhost:5173')
};

export const flags = {
  analysisConfigured: isConfiguredSecret(env.moonshotApiKey),
  taskAiConfigured:
    isConfiguredSecret(env.moonshotApiKey) ||
    isConfiguredSecret(env.openAiApiKey) ||
    isConfiguredSecret(env.anthropicApiKey),
  moonshotConfigured: isConfiguredSecret(env.moonshotApiKey),
  anthropicConfigured: isConfiguredSecret(env.anthropicApiKey),
  aiConfigured: isConfiguredSecret(env.moonshotApiKey),
  canvasConfigured: Boolean(env.canvasApiToken),
  supabaseConfigured: Boolean(env.supabaseUrl && env.supabaseServiceRoleKey),
  supabaseAuthConfigured: Boolean(env.supabaseUrl && env.supabaseAnonKey),
  stripeConfigured: Boolean(env.stripeSecretKey),
  jwtSecretConfigured: Boolean(env.jwtSecret) && env.jwtSecret !== DEFAULT_DEVELOPMENT_JWT_SECRET,
  extensionOriginsConfigured: env.allowAllExtensionOrigins || env.allowedExtensionOrigins.length > 0
};

export const startupValidationErrors = env.isProduction
  ? [
      !flags.analysisConfigured ? 'Set MOONSHOT_API_KEY for live /api/analyze requests.' : '',
      !flags.jwtSecretConfigured ? 'Set JWT_SECRET to a long random value.' : '',
      !flags.extensionOriginsConfigured
        ? 'Set ALLOWED_EXTENSION_ORIGINS to your chrome-extension://<EXTENSION_ID> origin or explicitly opt into ALLOW_ALL_EXTENSION_ORIGINS.'
        : ''
    ].filter(Boolean)
  : [];

export const startupValidationWarnings = [
  !env.allowAnonymousUsage ? 'Anonymous usage is disabled; the extension must provide a valid auth token.' : '',
  env.allowAllExtensionOrigins && env.isProduction
    ? 'ALLOW_ALL_EXTENSION_ORIGINS is enabled in production. Restrict this to specific chrome-extension:// origins when possible.'
    : ''
].filter(Boolean);

export const envDiagnostics = {
  cwd: process.cwd(),
  packageRoot,
  workspaceRoot,
  resolvedEnvPath,
  envFileExists: existsSync(resolvedEnvPath),
  cwdEnvPath,
  cwdEnvFileExists: existsSync(cwdEnvPath),
  dotenvLoaded: !dotenvResult.error,
  dotenvError: dotenvResult.error?.message,
  duplicateWorkspaceDirs: {
    spaced: existsSync(path.join(downloadsRoot, 'ChatGpt Extension')),
    encoded: existsSync(path.join(downloadsRoot, 'ChatGpt%20Extension'))
  },
  nodeEnv: env.nodeEnv,
  host: env.host,
  allowedOriginsCount: env.allowedOrigins.length,
  allowedExtensionOriginsCount: env.allowedExtensionOrigins.length,
  allowAllExtensionOrigins: env.allowAllExtensionOrigins,
  moonshotModel: env.moonshotModel,
  moonshotQuickModel: env.moonshotQuickModel,
  moonshotReasoningModel: env.moonshotReasoningModel,
  moonshotVisionModel: env.moonshotVisionModel,
  moonshotBaseUrl: env.moonshotBaseUrl,
  moonshotApiKeyPresent: flags.analysisConfigured
};
