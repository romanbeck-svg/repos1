import { Router } from 'express';
import { signAuthToken } from '../lib/auth.js';
import { supabaseAuthClient } from '../lib/supabase.js';
import { requireSession, type AuthenticatedRequest } from '../middleware/auth.js';
import { env, flags } from '../config/env.js';
import type { SubscriptionStatus } from '../types/api.js';
import type { MagicLinkStartRequest, SessionExchangeRequest } from '../types/api.js';

export const authRouter = Router();

function sanitizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

authRouter.post('/dev-token', (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : crypto.randomUUID();
  const email = typeof req.body?.email === 'string' ? req.body.email : 'student@example.edu';
  const subscriptionStatus: SubscriptionStatus =
    req.body?.subscriptionStatus === 'active' ||
    req.body?.subscriptionStatus === 'trialing' ||
    req.body?.subscriptionStatus === 'past_due' ||
    req.body?.subscriptionStatus === 'canceled'
      ? req.body.subscriptionStatus
      : 'trialing';

  res.json({
    token: signAuthToken({
      userId,
      email,
      subscriptionStatus
    })
  });
});

authRouter.post('/magic-link/start', async (req, res) => {
  if (!flags.supabaseAuthConfigured || !supabaseAuthClient) {
    return res.status(503).json({ error: 'Supabase auth is not configured yet.' });
  }

  const email = sanitizeEmail((req.body as Partial<MagicLinkStartRequest>)?.email);
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const { error } = await supabaseAuthClient.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: env.authMagicLinkRedirectUrl,
      shouldCreateUser: true
    }
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.json({
    ok: true,
    message: 'If that email can sign in, a magic link is on its way.'
  });
});

authRouter.post('/session/exchange', async (req, res) => {
  if (!flags.supabaseAuthConfigured || !supabaseAuthClient) {
    return res.status(503).json({ error: 'Supabase auth is not configured yet.' });
  }

  const accessToken = typeof (req.body as Partial<SessionExchangeRequest>)?.accessToken === 'string'
    ? (req.body as Partial<SessionExchangeRequest>).accessToken?.trim() || ''
    : '';

  if (!accessToken) {
    return res.status(400).json({ error: 'Supabase access token is required.' });
  }

  const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);
  if (error || !data.user?.id || !data.user.email) {
    return res.status(401).json({ error: 'Could not verify the Supabase session.' });
  }

  const token = signAuthToken({
    userId: data.user.id,
    email: data.user.email,
    subscriptionStatus: 'trialing'
  });

  return res.json({
    token,
    user: {
      id: data.user.id,
      email: data.user.email
    }
  });
});

authRouter.get('/me', requireSession, (req: AuthenticatedRequest, res) => {
  res.json({
    user: req.user
  });
});
