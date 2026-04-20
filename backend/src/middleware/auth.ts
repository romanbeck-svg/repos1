import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { verifyAuthToken } from '../lib/auth.js';
import type { AuthTokenClaims } from '../types/api.js';

export type AuthenticatedRequest = Request & {
  user?: AuthTokenClaims;
};

export function requireSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.get('authorization');

  if (!authHeader) {
    if (env.allowAnonymousUsage) {
      req.user = {
        userId: 'anonymous',
        email: 'anonymous@local.dev',
        subscriptionStatus: 'trialing'
      };
      return next();
    }

    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  try {
    req.user = verifyAuthToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid auth token.' });
  }
}
