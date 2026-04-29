import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { taskLimiter } from '../middleware/security.js';
import { prepareJsonLineStream, writeJsonLine } from '../utils/stream.js';
import { generateStructuredAnalysis, ModelServiceError, streamStructuredAnalysis } from '../services/model.js';
import { validateAnalyzeRequest } from '../utils/validation.js';
import { env } from '../config/env.js';
import { recordAiRequest } from '../lib/runtime-status.js';

export const analyzeRouter = Router();

analyzeRouter.use(taskLimiter);

function createRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `analysis-${Date.now()}`;
}

function logAnalysisRequest(
  requestId: string,
  request: { mode: string; instruction: string; page: { url: string; title: string; text: string; blocks: string[]; questionCandidates: { id: string }[] }; screenshotBase64: string | null },
  origin?: string
) {
  logger.info(
    {
      requestId,
      mode: request.mode,
      requestOrigin: origin ?? 'none',
      pageUrl: request.page.url,
      pageTitle: request.page.title,
      pageTextLength: request.page.text.length,
      blockCount: request.page.blocks.length,
      candidateQuestionCount: request.page.questionCandidates.length,
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
  logAnalysisRequest(requestId, request, req.get('origin') ?? undefined);

  try {
    const result = await generateStructuredAnalysis(request, requestId);
    recordAiRequest({
      ok: true,
      route: '/api/analyze',
      provider: env.aiProvider,
      message: 'Analysis request completed.'
    });
    return res.json({
      ok: true,
      mode: request.mode,
      output: result.output,
      meta: result.meta
    });
  } catch (error) {
    if (error instanceof ModelServiceError) {
      recordAiRequest({
        ok: false,
        route: '/api/analyze',
        provider: env.aiProvider,
        status: error.status,
        message: error.exposeMessage
      });
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
        error: error.exposeMessage,
        resultState: 'transport_error'
      });
    }

    recordAiRequest({
      ok: false,
      route: '/api/analyze',
      provider: env.aiProvider,
      status: 500,
      message: 'Mako IQ could not complete the analysis request.'
    });
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
      error: 'Mako IQ could not complete the analysis request.',
      resultState: 'transport_error'
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
  logAnalysisRequest(requestId, request, req.get('origin') ?? undefined);

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

    recordAiRequest({
      ok: true,
      route: '/api/analyze/stream',
      provider: env.aiProvider,
      message: 'Streaming analysis request completed.'
    });
    return res.end();
  } catch (error) {
    if (error instanceof ModelServiceError) {
      recordAiRequest({
        ok: false,
        route: '/api/analyze/stream',
        provider: env.aiProvider,
        status: error.status,
        message: error.exposeMessage
      });
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
        error: error.exposeMessage,
        resultState: 'transport_error'
      });
      return res.end();
    }

    recordAiRequest({
      ok: false,
      route: '/api/analyze/stream',
      provider: env.aiProvider,
      status: 500,
      message: 'Mako IQ could not complete the analysis request.'
    });
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
      error: 'Mako IQ could not complete the analysis request.',
      resultState: 'transport_error'
    });
    return res.end();
  } finally {
    req.off('close', abort);
  }
});
