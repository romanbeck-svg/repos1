import { Router } from 'express';
import { flags } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { stripe } from '../lib/stripe.js';

export const webhookRouter = Router();

webhookRouter.post('/stripe', async (req, res) => {
  if (!flags.stripeConfigured || !stripe) {
    return res.status(503).send('Stripe is not configured.');
  }

  logger.info({ eventBytes: Buffer.isBuffer(req.body) ? req.body.length : 0 }, 'received stripe webhook');
  return res.json({ received: true });
});
