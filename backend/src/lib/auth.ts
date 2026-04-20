import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { AuthTokenClaims } from '../types/api.js';

export function signAuthToken(claims: AuthTokenClaims) {
  return jwt.sign(claims, env.jwtSecret, { expiresIn: '7d' });
}

export function verifyAuthToken(token: string) {
  return jwt.verify(token, env.jwtSecret) as AuthTokenClaims;
}
