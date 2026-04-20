import { Router } from 'express';
import { env, flags } from '../config/env.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'mako-iq-backend',
    environment: env.nodeEnv,
    aiConfigured: flags.aiConfigured,
    analysisConfigured: flags.analysisConfigured,
    taskAiConfigured: flags.taskAiConfigured,
    jwtSecretConfigured: flags.jwtSecretConfigured,
    extensionOriginsConfigured: flags.extensionOriginsConfigured,
    supabaseConfigured: flags.supabaseConfigured,
    stripeConfigured: flags.stripeConfigured,
    timestamp: new Date().toISOString()
  });
});
