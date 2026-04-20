import { Router } from 'express';
import { buildDocxBase64 } from '../lib/docx.js';
import { requireSession } from '../middleware/auth.js';
import { sanitizeText } from '../services/safety.js';

export const exportRouter = Router();

exportRouter.use(requireSession);

exportRouter.post('/docx', async (req, res) => {
  const title = sanitizeText(req.body?.title, 240) || 'Mako IQ draft';
  const summary = sanitizeText(req.body?.summary, 600) || undefined;
  const sections = Array.isArray(req.body?.sections)
    ? req.body.sections
        .map((section: { heading?: string; body?: string }) => ({
          heading: sanitizeText(section?.heading, 120),
          body: sanitizeText(section?.body, 12000)
        }))
        .filter((section: { heading: string; body: string }) => section.heading && section.body)
    : [];

  if (!sections.length) {
    return res.status(400).json({ error: 'At least one export section is required.' });
  }

  const base64 = await buildDocxBase64({ title, summary, sections });
  return res.json({
    fileName: `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'mako-iq-draft'}.docx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    base64
  });
});
