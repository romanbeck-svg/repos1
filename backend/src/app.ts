import express from 'express';
import pinoHttp from 'pino-http';
import { analyzeRouter } from './routes/analyze.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { taskRouter } from './routes/tasks.js';
import { onboardingRouter } from './routes/onboarding.js';
import { scanRouter } from './routes/scan.js';
import { exportRouter } from './routes/export.js';
import { billingRouter } from './routes/billing.js';
import { webhookRouter } from './routes/webhooks.js';
import { adminRouter } from './routes/admin.js';
import { canvasRouter } from './routes/canvas.js';
import { corsMiddleware, generalLimiter, securityHeaders } from './middleware/security.js';
import { errorHandler } from './middleware/error-handler.js';
import { logger } from './lib/logger.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((pinoHttp as unknown as (options: { logger: typeof logger }) => ReturnType<typeof express.json>)({ logger }));
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use('/health', healthRouter);
  app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRouter);
  app.use(express.json({ limit: '6mb' }));
  app.use(generalLimiter);

  app.use('/api/analyze', analyzeRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/onboarding', onboardingRouter);
  app.use('/api/v1/canvas', canvasRouter);
  app.use('/api/v1/tasks', taskRouter);
  app.use('/api/v1/scan-pages', scanRouter);
  app.use('/api/v1/export', exportRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use(errorHandler);
  return app;
}
