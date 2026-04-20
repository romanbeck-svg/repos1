import { Router } from 'express';
import { requireSession } from '../middleware/auth.js';
import { scanLimiter } from '../middleware/security.js';
import { sanitizeImageScanRequest, sanitizeScanPage } from '../services/safety.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { getAiProvider } from '../ai/provider.js';

export const scanRouter = Router();

scanRouter.use(requireSession);
scanRouter.use(scanLimiter);

scanRouter.post('/', async (req, res) => {
  const page = sanitizeScanPage(req.body?.page ?? req.body);
  if (!page?.readableText || page.readableText.length < 80) {
    return res.status(400).json({ error: 'Readable scanned page text is required.' });
  }

  if (supabaseAdmin) {
    await supabaseAdmin.from('scan_page_inputs').insert({
      title: page.title,
      source_url: page.url,
      readable_text: page.readableText,
      headings: page.headings,
      source_type: page.sourceType,
      scanned_at: page.scannedAt
    });
  }

  return res.json({
    ok: true,
    stored: true,
    summary: `Stored scan for ${page.title}.`
  });
});

scanRouter.post('/vision', async (req, res) => {
  const request = sanitizeImageScanRequest(req.body);
  if (!request) {
    return res.status(400).json({ error: 'A valid image scan payload is required.' });
  }

  const generatedPage = await getAiProvider().extractScanFromImage(request);
  const page = sanitizeScanPage(generatedPage);
  if (!page?.readableText || page.readableText.length < 40) {
    return res.status(422).json({ error: 'Could not extract enough text from the captured image.' });
  }

  if (supabaseAdmin) {
    await supabaseAdmin.from('scan_page_inputs').insert({
      title: page.title,
      source_url: page.url,
      readable_text: page.readableText,
      headings: page.headings,
      source_type: page.sourceType,
      scanned_at: page.scannedAt
    });
  }

  return res.json({
    ok: true,
    page,
    message: 'Scan complete. I used image OCR because the page exposed limited readable text.'
  });
});
