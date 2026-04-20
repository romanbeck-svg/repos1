import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from '../config/env.js';

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
