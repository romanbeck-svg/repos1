import { env, envDiagnostics, flags, startupValidationErrors, startupValidationWarnings } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';

const app = createApp();

logger.info(
  {
    cwd: envDiagnostics.cwd,
    packageRoot: envDiagnostics.packageRoot,
    resolvedEnvPath: envDiagnostics.resolvedEnvPath,
    envFileExists: envDiagnostics.envFileExists,
    cwdEnvPath: envDiagnostics.cwdEnvPath,
    cwdEnvFileExists: envDiagnostics.cwdEnvFileExists,
    dotenvLoaded: envDiagnostics.dotenvLoaded,
    dotenvError: envDiagnostics.dotenvError,
    duplicateWorkspaceDirs: envDiagnostics.duplicateWorkspaceDirs,
    moonshotModel: envDiagnostics.moonshotModel,
    moonshotQuickModel: envDiagnostics.moonshotQuickModel,
    moonshotReasoningModel: envDiagnostics.moonshotReasoningModel,
    moonshotVisionModel: envDiagnostics.moonshotVisionModel,
    moonshotBaseUrl: envDiagnostics.moonshotBaseUrl,
    moonshotApiKeyPresent: envDiagnostics.moonshotApiKeyPresent,
    aiConfigured: flags.aiConfigured,
    analysisConfigured: flags.analysisConfigured,
    taskAiConfigured: flags.taskAiConfigured,
    jwtSecretConfigured: flags.jwtSecretConfigured,
    extensionOriginsConfigured: flags.extensionOriginsConfigured
  },
  'backend startup diagnostics'
);

if (startupValidationWarnings.length) {
  logger.warn({ startupValidationWarnings }, 'backend startup warnings');
}

if (startupValidationErrors.length) {
  logger.error({ startupValidationErrors }, 'backend startup blocked by invalid production configuration');
  process.exit(1);
}

const server = app.listen(env.port, env.host, () => {
  logger.info({ host: env.host, port: env.port, nodeEnv: env.nodeEnv }, 'mako iq backend listening');
});

function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  logger.info({ signal }, 'shutdown signal received');
  server.close((error) => {
    if (error) {
      logger.error({ signal, detail: error.message }, 'backend shutdown failed');
      process.exit(1);
    }

    logger.info({ signal }, 'backend shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error({ signal }, 'forcing backend shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
