import { Router } from 'express';
import { getAiProvider } from '../ai/provider.js';
import { requireSession } from '../middleware/auth.js';
import { taskLimiter } from '../middleware/security.js';
import { sanitizeToneProfileRequest } from '../services/safety.js';

const provider = getAiProvider();

export const onboardingRouter = Router();

onboardingRouter.use(requireSession);
onboardingRouter.use(taskLimiter);

onboardingRouter.post('/tone-profile', async (req, res) => {
  const payload = sanitizeToneProfileRequest(req.body);
  if (!payload.consentGranted) {
    return res.status(400).json({ error: 'Explicit consent is required before analyzing prior work.' });
  }

  if (!payload.samples.length) {
    return res.status(400).json({ error: 'Provide at least one scanned sample for tone calibration.' });
  }

  const response = await provider.generateToneProfile(payload);
  return res.json(response);
});
