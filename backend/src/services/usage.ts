import type { Request } from 'express';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';

export async function recordUsageEvent(req: Request, taskType: string, status: 'success' | 'blocked' | 'error') {
  const userId = (req as Request & { user?: { userId: string } }).user?.userId ?? 'anonymous';
  const payload = {
    user_id: userId,
    task_type: taskType,
    status,
    path: req.path,
    user_agent: req.get('user-agent') ?? '',
    created_at: new Date().toISOString()
  };

  if (supabaseAdmin) {
    await supabaseAdmin.from('usage_events').insert(payload);
    return;
  }

  logger.info({ usageEvent: payload }, 'usage event recorded');
}
