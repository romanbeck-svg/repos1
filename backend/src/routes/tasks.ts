import { type Response, Router } from 'express';
import { getAiProvider } from '../ai/provider.js';
import { logger } from '../lib/logger.js';
import { requireSession, type AuthenticatedRequest } from '../middleware/auth.js';
import { taskLimiter } from '../middleware/security.js';
import { detectPromptInjectionSignals, sanitizeTaskRequest } from '../services/safety.js';
import { recordUsageEvent } from '../services/usage.js';
import type { TaskKind, TaskResponse } from '../types/api.js';

const provider = getAiProvider();

export const taskRouter = Router();

function createTaskHandler(task: TaskKind) {
  return async (req: AuthenticatedRequest, res: Response) => {
    const payload = sanitizeTaskRequest(task, req.body);
    const suspiciousExtraInstructions = detectPromptInjectionSignals(payload.extraInstructions);

    if (suspiciousExtraInstructions) {
      logger.warn({ userId: req.user?.userId, task, extraInstructions: payload.extraInstructions }, 'prompt injection signal');
      payload.extraInstructions = '';
    }

    const output = await provider.generateTaskOutput(task, payload);
    if (payload.context?.quizSafetyMode === 'active_attempt') {
      output.policyNotes = [
        ...(output.policyNotes ?? []),
        'Active quiz attempt detected. Output stayed in explanation and study-support mode.'
      ];
    }

    await recordUsageEvent(req, task, 'success');
    res.json(output as TaskResponse);
  };
}

taskRouter.use(requireSession);
taskRouter.use(taskLimiter);

taskRouter.post('/assignment/analyze', createTaskHandler('analyze_assignment'));
taskRouter.post('/assignment/draft', createTaskHandler('build_draft'));
taskRouter.post('/discussion', createTaskHandler('discussion_post'));
taskRouter.post('/explain', createTaskHandler('explain_page'));
taskRouter.post('/summary', createTaskHandler('summarize_reading'));
taskRouter.post('/quiz-assist', createTaskHandler('quiz_assist'));
