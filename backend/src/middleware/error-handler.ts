import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

type HttpError = Error & {
  status?: number;
  statusCode?: number;
  exposeMessage?: string;
};

export function errorHandler(error: HttpError, _req: Request, res: Response, _next: NextFunction) {
  const status = error.status ?? error.statusCode ?? 500;
  logger.error({ status, error }, 'unhandled request error');
  res.status(status).json({
    error: status >= 500 ? error.exposeMessage ?? 'Mako IQ backend request failed.' : error.message
  });
}
