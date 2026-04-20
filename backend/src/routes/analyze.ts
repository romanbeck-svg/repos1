import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { taskLimiter } from '../middleware/security.js';
import { prepareJsonLineStream, writeJsonLine } from '../utils/stream.js';
import { generateStructuredAnalysis, ModelServiceError, streamStructuredAnalysis } from '../services/model.js';
import { validateAnalyzeRequest } from '../utils/validation.js';

export const analyzeRouter = Router();

analyzeRouter.use(taskLimiter);

function createRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `analysis-${Date.now()}`;
}

function logAnalysisRequest(requestId: string, request: { mode: string; instruction: string; page: { url: string; title: string; text: string }; screenshotBase64: string | null }) {
  logger.info(
    {
      requestId,
      mode: request.mode,
      pageUrl: request.page.url,
      pageTitle: request.page.title,
      pageTextLength: request.page.text.length,
      hasInstruction: Boolean(request.instruction),
      hasScreenshot: Boolean(request.screenshotBase64)
    },
    'analysis request received'
  );
}

analyzeRouter.post('/', async (req, res) => {
  const validation = validateAnalyzeRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      ok: false,
      error: validation.error
    });
  }

  const request = validation.data;
  const requestId = createRequestId();
  logAnalysisRequest(requestId, request);

  try {
    const result = await generateStructuredAnalysis(request, requestId);
    return res.json({
      ok: true,
      mode: request.mode,
      output: result.output,
      meta: result.meta
    });
  } catch (error) {
    if (error instanceof ModelServiceError) {
      logger.error(
        {
          requestId,
          mode: request.mode,
          status: error.status,
          detail: error.message
        },
        'analysis request failed'
      );
      return res.status(error.status).json({
        ok: false,
        error: error.exposeMessage
      });
    }

    logger.error(
      {
        requestId,
        mode: request.mode,
        detail: error instanceof Error ? error.message : 'Unknown analysis error'
      },
      'unexpected analysis route failure'
    );
    return res.status(500).json({
      ok: false,
      error: 'Mako IQ could not complete the analysis request.'
    });
  }
});

analyzeRouter.post('/stream', async (req, res) => {
  const validation = validateAnalyzeRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      ok: false,
      error: validation.error
    });
  }

  const request = validation.data;
  const requestId = createRequestId();
  logAnalysisRequest(requestId, request);

  prepareJsonLineStream(res);

  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('close', abort);

  try {
    await streamStructuredAnalysis(request, {
      requestId,
      signal: controller.signal,
      onEvent(event) {
        writeJsonLine(res, event);
      }
    });

    return res.end();
  } catch (error) {
    if (error instanceof ModelServiceError) {
      logger.error(
        {
          requestId,
          mode: request.mode,
          status: error.status,
          detail: error.message
        },
        'analysis streaming request failed'
      );
      writeJsonLine(res, {
        type: 'error',
        requestId,
        error: error.exposeMessage
      });
      return res.end();
    }

    logger.error(
      {
        requestId,
        mode: request.mode,
        detail: error instanceof Error ? error.message : 'Unknown analysis stream error'
      },
      'unexpected analysis stream failure'
    );
    writeJsonLine(res, {
      type: 'error',
      requestId,
        error: 'Mako IQ could not complete the analysis request.'
    });
    return res.end();
  } finally {
    req.off('close', abort);
  }
});
