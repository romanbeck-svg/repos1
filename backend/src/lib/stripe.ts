import Stripe from 'stripe';
import { env, flags } from '../config/env.js';

export const stripe = flags.stripeConfigured
  ? new Stripe(env.stripeSecretKey, {
      typescript: true
    })
  : null;
