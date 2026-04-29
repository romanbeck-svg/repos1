import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(moduleDir, '..', '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const downloadsRoot = path.resolve(workspaceRoot, '..');
const rootEnvPath = path.resolve(workspaceRoot, '.env');
const resolvedEnvPath = path.resolve(packageRoot, '.env');
const cwdEnvPath = path.resolve(process.cwd(), '.env');
const DEFAULT_DEVELOPMENT_JWT_SECRET = 'development-secret';

function loadEnvFile(filePath: string, overrideLoadedKeys: Set<string> = new Set()) {
  const loadedKeys = new Set<string>();
  if (!existsSync(filePath)) {
    return {
      loaded: false,
      loadedKeys,
      error: `ENOENT: no such file or directory, open '${filePath}'`
    };
  }

  try {
    const parsed = dotenv.parse(readFileSync(filePath));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || overrideLoadedKeys.has(key)) {
        process.env[key] = value;
        loadedKeys.add(key);
      }
    }

    return {
      loaded: true,
      loadedKeys
    };
  } catch (error) {
    return {
      loaded: false,
      loadedKeys,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const rootDotenvResult = loadEnvFile(rootEnvPath);
const dotenvResult = loadEnvFile(resolvedEnvPath, rootDotenvResult.loadedKeys);

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
const defaultAllowedOrigins =
  nodeEnv === 'production' ? '' : 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173';
const defaultAllowedExtensionOrigins = 'chrome-extension://himeagaboplmdgfhajkiipplhoklbooa';
const rawAiProvider = required('AI_PROVIDER', 'kimi').toLowerCase();
const aiProvider = rawAiProvider === 'moonshot' ? 'kimi' : rawAiProvider;

function maskSecret(value: string) {
  if (!isConfiguredSecret(value)) {
    return '';
  }

  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  host: required('HOST', '127.0.0.1'),
  port: parsePort(process.env.PORT, 8787),
  appUrl: required('APP_URL', 'http://127.0.0.1:8787'),
  allowedOrigins: parseList(required('ALLOWED_ORIGINS', defaultAllowedOrigins)),
  allowedExtensionOrigins: parseList(required('ALLOWED_EXTENSION_ORIGINS', defaultAllowedExtensionOrigins)),
  allowAllExtensionOrigins: toBoolean(process.env.ALLOW_ALL_EXTENSION_ORIGINS, false),
  allowAnonymousUsage: toBoolean(process.env.ALLOW_ANONYMOUS_USAGE, true),
  aiProvider,
  rawAiProvider,
  kimiBaseUrl: required('KIMI_BASE_URL', required('MOONSHOT_BASE_URL', 'https://api.moonshot.ai/v1')),
  kimiModel: required('KIMI_MODEL', required('MOONSHOT_MODEL', 'kimi-k2.6')),
  ollamaBaseUrl: required('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
  ollamaModel: required('OLLAMA_MODEL'),
  ollamaVisionModel: required('OLLAMA_VISION_MODEL'),
  ollamaKeepAlive: required('OLLAMA_KEEP_ALIVE', '10m'),
  aiRequestTimeoutMs: parsePort(process.env.AI_REQUEST_TIMEOUT_MS, 60_000),
  moonshotApiKey: required('MOONSHOT_API_KEY'),
  moonshotModel: required('MOONSHOT_MODEL', required('KIMI_MODEL', 'kimi-k2.6')),
  moonshotQuickModel: required('MOONSHOT_QUICK_MODEL', required('KIMI_MODEL', required('MOONSHOT_MODEL', 'kimi-k2.6'))),
  moonshotReasoningModel: required('MOONSHOT_REASONING_MODEL', required('KIMI_MODEL', required('MOONSHOT_MODEL', 'kimi-k2.6'))),
  moonshotVisionModel: required('MOONSHOT_VISION_MODEL', required('KIMI_MODEL', 'kimi-k2.6')),
  moonshotBaseUrl: required('MOONSHOT_BASE_URL', required('KIMI_BASE_URL', 'https://api.moonshot.ai/v1')),
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
  analysisConfigured: env.aiProvider === 'ollama' ? Boolean(env.ollamaModel) : isConfiguredSecret(env.moonshotApiKey),
  taskAiConfigured:
    env.aiProvider === 'ollama'
      ? Boolean(env.ollamaModel)
      : env.aiProvider === 'openai'
        ? isConfiguredSecret(env.openAiApiKey)
        : env.aiProvider === 'anthropic'
          ? isConfiguredSecret(env.anthropicApiKey)
          : isConfiguredSecret(env.moonshotApiKey),
  moonshotConfigured: isConfiguredSecret(env.moonshotApiKey),
  kimiConfigured: isConfiguredSecret(env.moonshotApiKey),
  anthropicConfigured: isConfiguredSecret(env.anthropicApiKey),
  openAiConfigured: isConfiguredSecret(env.openAiApiKey),
  ollamaConfigured: env.aiProvider === 'ollama' && Boolean(env.ollamaModel),
  aiConfigured:
    env.aiProvider === 'ollama'
      ? Boolean(env.ollamaModel)
      : env.aiProvider === 'openai'
        ? isConfiguredSecret(env.openAiApiKey)
        : env.aiProvider === 'anthropic'
          ? isConfiguredSecret(env.anthropicApiKey)
          : isConfiguredSecret(env.moonshotApiKey),
  canvasConfigured: Boolean(env.canvasApiToken),
  supabaseConfigured: Boolean(env.supabaseUrl && env.supabaseServiceRoleKey),
  supabaseAuthConfigured: Boolean(env.supabaseUrl && env.supabaseAnonKey),
  stripeConfigured: Boolean(env.stripeSecretKey),
  jwtSecretConfigured: Boolean(env.jwtSecret) && env.jwtSecret !== DEFAULT_DEVELOPMENT_JWT_SECRET,
  extensionOriginsConfigured: env.allowAllExtensionOrigins || env.allowedExtensionOrigins.length > 0
};

export const startupValidationErrors = env.isProduction
  ? [
      env.aiProvider === 'kimi' && !flags.moonshotConfigured ? 'Set MOONSHOT_API_KEY for live Kimi /api/analyze requests.' : '',
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
  rootEnvPath,
  rootEnvFileExists: existsSync(rootEnvPath),
  envFileExists: existsSync(resolvedEnvPath),
  cwdEnvPath,
  cwdEnvFileExists: existsSync(cwdEnvPath),
  rootDotenvLoaded: !rootDotenvResult.error,
  rootDotenvError: rootDotenvResult.error,
  dotenvLoaded: !dotenvResult.error,
  dotenvError: dotenvResult.error,
  duplicateWorkspaceDirs: {
    spaced: existsSync(path.join(downloadsRoot, 'ChatGpt Extension')),
    encoded: existsSync(path.join(downloadsRoot, 'ChatGpt%20Extension'))
  },
  nodeEnv: env.nodeEnv,
  host: env.host,
  port: env.port,
  aiProvider: env.aiProvider,
  rawAiProvider: env.rawAiProvider,
  kimiBaseUrl: env.kimiBaseUrl,
  kimiModel: env.kimiModel,
  ollamaBaseUrl: env.ollamaBaseUrl,
  ollamaModel: env.ollamaModel,
  ollamaVisionModel: env.ollamaVisionModel,
  allowedOriginsCount: env.allowedOrigins.length,
  allowedExtensionOriginsCount: env.allowedExtensionOrigins.length,
  allowAllExtensionOrigins: env.allowAllExtensionOrigins,
  moonshotModel: env.moonshotModel,
  moonshotQuickModel: env.moonshotQuickModel,
  moonshotReasoningModel: env.moonshotReasoningModel,
  moonshotVisionModel: env.moonshotVisionModel,
  moonshotBaseUrl: env.moonshotBaseUrl,
  moonshotApiKeyPresent: flags.moonshotConfigured,
  moonshotApiKeyPreview: maskSecret(env.moonshotApiKey)
};
