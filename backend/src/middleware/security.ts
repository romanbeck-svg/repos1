import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const securityHeaders = helmet({
  crossOriginEmbedderPolicy: false
});

function createHttpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function isAllowedOrigin(origin: string) {
  if (env.allowedOrigins.includes(origin)) {
    return true;
  }

  // Local-first privacy boundary: extension page data may enter this loopback API,
  // but it is only accepted from explicitly configured extension origins by default.
  if (origin.startsWith('chrome-extension://')) {
    return env.allowAllExtensionOrigins || env.allowedExtensionOrigins.includes(origin);
  }

  return false;
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    logger.warn(
      {
        origin,
        allowedOriginsCount: env.allowedOrigins.length,
        allowedExtensionOriginsCount: env.allowedExtensionOrigins.length,
        allowAllExtensionOrigins: env.allowAllExtensionOrigins
      },
      'cors rejected origin'
    );
    callback(createHttpError(403, `Origin ${origin} is not allowed by the Mako IQ API.`));
  },
  credentials: true,
  optionsSuccessStatus: 204
});

export const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

export const taskLimiter = rateLimit({
  windowMs: 60_000,
  max: 24,
  standardHeaders: true,
  legacyHeaders: false
});

export const scanLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
