import { Router } from 'express';
import { requireSession, type AuthenticatedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const adminRouter = Router();

adminRouter.use(requireSession);

adminRouter.get('/usage', async (req: AuthenticatedRequest, res) => {
  if (req.user?.subscriptionStatus !== 'active' && req.user?.userId !== 'anonymous') {
    return res.status(403).json({ error: 'Admin usage access requires an active admin-capable session.' });
  }

  if (!supabaseAdmin) {
    return res.json({ usageEvents: [] });
  }

  const { data } = await supabaseAdmin.from('usage_events').select('*').order('created_at', { ascending: false }).limit(50);
  return res.json({ usageEvents: data ?? [] });
});
