import { Router } from 'express';
import { requireSession } from '../middleware/auth.js';
import { taskLimiter } from '../middleware/security.js';
import { fetchCanvasApiSummary } from '../services/canvas.js';
import { sanitizeCanvasApiContextRequest } from '../services/safety.js';

export const canvasRouter = Router();

canvasRouter.use(requireSession);
canvasRouter.use(taskLimiter);

canvasRouter.post('/context', async (req, res) => {
  const payload = sanitizeCanvasApiContextRequest(req.body);
  if (!payload.sourceUrl) {
    return res.status(400).json({ error: 'A Canvas source URL is required.' });
  }

  const response = await fetchCanvasApiSummary(payload);
  return res.json(response);
});
