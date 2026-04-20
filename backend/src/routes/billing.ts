import { Router } from 'express';
import { env, flags } from '../config/env.js';
import { stripe } from '../lib/stripe.js';
import { requireSession, type AuthenticatedRequest } from '../middleware/auth.js';

export const billingRouter = Router();

billingRouter.use(requireSession);

billingRouter.post('/checkout-session', async (req: AuthenticatedRequest, res) => {
  if (!flags.stripeConfigured || !stripe) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: req.user?.email,
    line_items: [
      {
        price: env.stripeMonthlyPriceId,
        quantity: 1
      }
    ],
    success_url: `${env.appUrl}/billing/success`,
    cancel_url: `${env.appUrl}/billing/cancel`
  });

  return res.json({ url: session.url, plan: 'monthly' });
});

billingRouter.post('/portal-session', async (_req: AuthenticatedRequest, res) => {
  if (!flags.stripeConfigured || !stripe) {
    return res.status(503).json({ error: 'Stripe is not configured yet.' });
  }

  return res.status(501).json({
    error: 'Customer portal session creation needs your stored Stripe customer id lookup.'
  });
});
