import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { flags, env } from '../config/env.js';
import { OllamaServiceError, ollamaChat } from './ollama.js';
import { buildTaskPrompt, buildToneProfilePrompt } from './prompts.js';
import type {
  ImageScanRequest,
  ScanPagePayload,
  TaskRequest,
  TaskResponse,
  ToneProfileRequest,
  ToneProfileResponse
} from '../types/api.js';

function safeJsonParse<T>(value: string): T {
  const cleaned = value.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned) as T;
}

function buildMockTaskResponse(request: TaskRequest): TaskResponse {
  const promptSnippet = request.context?.promptText.slice(0, 180) || 'the visible page content';
  const shared = {
    summary: request.context?.title ? `Mako IQ reviewed ${request.context.title}.` : 'Mako IQ reviewed the current page.',
    checklist: [
      request.context?.dueAtText ? `Confirm the due date: ${request.context.dueAtText}.` : 'Confirm any deadline shown on the page.',
      'Verify the rubric and any attachment requirements.',
      request.extraInstructions ? `Apply the extra instruction: ${request.extraInstructions}.` : 'Add your own evidence before submitting.'
    ],
    proposedStructure: ['Opening move', 'Key point one', 'Key point two', 'Wrap-up'],
    draft: `This editable draft is based on ${promptSnippet.toLowerCase()}. Replace broad statements with your own evidence before submitting.`,
    explanation: 'The response was organized from the visible prompt, scanned references, and your extra instructions while keeping the work editable.',
    reviewAreas: ['Check source accuracy.', 'Make sure the tone still sounds like you.', 'Confirm citation or format requirements.']
  };

  if (request.task === 'discussion_post') {
    return {
      ...shared,
      alternateVersion: 'Short version: The main idea becomes stronger when it links the reading directly to a concrete example from class.',
      citationPlaceholders: ['[Add reading citation here]', '[Add discussion evidence here]']
    };
  }

  if (request.task === 'quiz_assist') {
    return {
      ...shared,
      draft: 'Study support: identify the concept first, then compare each answer choice against that concept before deciding what to review.',
      explanation: 'Because this may be a live assessment context, the response stays at the concept and reasoning level.'
    };
  }

  return shared;
}

function buildMockToneProfile(request: ToneProfileRequest): ToneProfileResponse {
  const sampleText = request.samples.map((sample) => sample.readableText).join('\n');
  const bulletSignals = (sampleText.match(/(^|\n)[-*]/g) ?? []).length;
  return {
    toneProfile: {
      sentenceLengthTendency: sampleText.length > 2400 ? 'balanced' : 'short',
      formality: /\bhowever\b|\btherefore\b/i.test(sampleText) ? 'formal' : 'balanced',
      structurePreference: bulletSignals > 4 ? 'uses list-driven organization when helpful' : 'prefers paragraph-based flow with clear transitions',
      citationTendency: /\([A-Z][A-Za-z]+,\s*\d{4}\)|references/i.test(sampleText)
        ? 'often adds citation markers or a references section'
        : 'usually writes without explicit citations unless the assignment asks for them',
      compositionPreference: bulletSignals > 4 ? 'mixed' : 'paragraphs',
      evidence: request.samples.slice(0, 3).map((sample) => `${sample.title}: ${sample.readableText.slice(0, 80)}...`),
      generatedAt: new Date().toISOString()
    },
    message: 'Okay, I\'ve got a good sense of your style. What are we working on today?'
  };
}

function parseImageDataUrl(imageDataUrl: string) {
  const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Image data URL must be a base64-encoded image.');
  }

  return {
    mediaType: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
    base64: match[2]
  };
}

function buildVisionPrompt(request: ImageScanRequest) {
  return [
    'You are Mako IQ, an AI learning copilot.',
    'Extract readable study-safe text from the provided page image.',
    'Do not infer missing text aggressively. Return only what is reasonably legible.',
    'Return JSON with keys title, url, readableText, headings, contentBlocks, questionCandidates, sourceType, pageType, sourceMode, extractionNotes, scannedAt.',
    'Set sourceMode to "image_ocr".',
    `Use the provided URL: ${request.url}`,
    `Use the provided title: ${request.title}`,
    `Use the provided sourceType: ${request.sourceType}`,
    `Use the provided pageType: ${request.pageType}`
  ].join('\n');
}

function buildMockImageScan(request: ImageScanRequest): ScanPagePayload {
  const readableText = `Image-based scan placeholder for ${request.title}. A configured AI provider is needed for OCR fallback on DOM-poor pages.`;
  return {
    title: request.title,
    url: request.url,
    readableText,
    headings: [request.title],
    contentBlocks: [readableText],
    questionCandidates: [],
    sourceType: request.sourceType,
    pageType: request.pageType,
    sourceMode: 'image_ocr',
    extractionNotes: ['OCR fallback returned a mock placeholder because no AI provider is configured.'],
    scannedAt: new Date().toISOString()
  };
}

export interface AiProvider {
  generateTaskOutput(task: TaskRequest['task'], request: TaskRequest): Promise<TaskResponse>;
  generateToneProfile(request: ToneProfileRequest): Promise<ToneProfileResponse>;
  extractScanFromImage(request: ImageScanRequest): Promise<ScanPagePayload>;
}

function readAnthropicText(blocks: Anthropic.Messages.ContentBlock[]) {
  return blocks
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

async function runOllamaJson<T>(options: {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; images?: string[] }>;
}) {
  try {
    const response = await ollamaChat({
      model: options.model,
      messages: options.messages,
      format: 'json',
      options: {
        temperature: 0
      }
    });

    return safeJsonParse<T>(response.content);
  } catch (error) {
    if (error instanceof OllamaServiceError) {
      throw error;
    }

    throw new OllamaServiceError(error instanceof Error ? error.message : 'Ollama returned an unreadable response.', {
      status: 502,
      exposeMessage: 'Local AI returned an unreadable response. Try again.'
    });
  }
}

async function runMoonshotJson<T>(options: {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: unknown }>;
  maxTokens: number;
}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), env.aiRequestTimeoutMs);

  try {
    const response = await fetch(`${env.kimiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.moonshotApiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        max_tokens: options.maxTokens,
        stream: false,
        response_format: {
          type: 'json_object'
        }
      }),
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as any) : null;

    if (!response.ok) {
      throw new Error(parsed?.error?.message ?? `Moonshot returned HTTP ${response.status}.`);
    }

    const content = parsed?.choices?.[0]?.message?.content;
    return safeJsonParse<T>(typeof content === 'string' ? content : JSON.stringify(content ?? {}));
  } finally {
    clearTimeout(timeoutId);
  }
}

class OllamaProvider implements AiProvider {
  async generateTaskOutput(task: TaskRequest['task'], request: TaskRequest) {
    return runOllamaJson<TaskResponse>({
      model: env.ollamaModel,
      messages: [
        {
          role: 'system',
          content: buildTaskPrompt(task, request)
        },
        {
          role: 'user',
          content: 'Generate the structured JSON response now.'
        }
      ]
    });
  }

  async generateToneProfile(request: ToneProfileRequest) {
    return runOllamaJson<ToneProfileResponse>({
      model: env.ollamaModel,
      messages: [
        {
          role: 'system',
          content: buildToneProfilePrompt()
        },
        {
          role: 'user',
          content: JSON.stringify(request)
        }
      ]
    });
  }

  async extractScanFromImage(request: ImageScanRequest) {
    if (!env.ollamaVisionModel) {
      throw new OllamaServiceError('OLLAMA_VISION_MODEL is not configured.', {
        status: 501,
        exposeMessage: 'Image scan needs a local vision model. Configure OLLAMA_VISION_MODEL in Mako IQ Companion.'
      });
    }

    const { base64 } = parseImageDataUrl(request.imageDataUrl);
    return runOllamaJson<ScanPagePayload>({
      model: env.ollamaVisionModel,
      messages: [
        {
          role: 'system',
          content: buildVisionPrompt(request)
        },
        {
          role: 'user',
          content: 'Extract the readable page text from this screenshot and return the required JSON object.',
          images: [base64]
        }
      ]
    });
  }
}

class MoonshotProvider implements AiProvider {
  async generateTaskOutput(task: TaskRequest['task'], request: TaskRequest) {
    return runMoonshotJson<TaskResponse>({
      model: env.kimiModel,
      maxTokens: 1800,
      messages: [
        {
          role: 'system',
          content: buildTaskPrompt(task, request)
        },
        {
          role: 'user',
          content: 'Generate the structured JSON response now.'
        }
      ]
    });
  }

  async generateToneProfile(request: ToneProfileRequest) {
    return runMoonshotJson<ToneProfileResponse>({
      model: env.kimiModel,
      maxTokens: 1200,
      messages: [
        {
          role: 'system',
          content: buildToneProfilePrompt()
        },
        {
          role: 'user',
          content: JSON.stringify(request)
        }
      ]
    });
  }

  async extractScanFromImage(request: ImageScanRequest) {
    return runMoonshotJson<ScanPagePayload>({
      model: env.kimiModel,
      maxTokens: 1600,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildVisionPrompt(request)
            },
            {
              type: 'image_url',
              image_url: {
                url: request.imageDataUrl
              }
            }
          ]
        }
      ]
    });
  }
}

class AnthropicProvider implements AiProvider {
  private client = new Anthropic({ apiKey: env.anthropicApiKey });

  async generateTaskOutput(task: TaskRequest['task'], request: TaskRequest) {
    const response = await this.client.messages.create({
      model: env.anthropicModel,
      max_tokens: 1800,
      system: buildTaskPrompt(task, request),
      messages: [
        {
          role: 'user',
          content: 'Generate the structured JSON response now.'
        }
      ]
    });

    return safeJsonParse<TaskResponse>(readAnthropicText(response.content));
  }

  async generateToneProfile(request: ToneProfileRequest) {
    const response = await this.client.messages.create({
      model: env.anthropicModel,
      max_tokens: 1200,
      system: buildToneProfilePrompt(),
      messages: [
        {
          role: 'user',
          content: JSON.stringify(request)
        }
      ]
    });

    return safeJsonParse<ToneProfileResponse>(readAnthropicText(response.content));
  }

  async extractScanFromImage(request: ImageScanRequest) {
    const { mediaType, base64 } = parseImageDataUrl(request.imageDataUrl);
    const response = await this.client.messages.create({
      model: env.anthropicModel,
      max_tokens: 1600,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildVisionPrompt(request)
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64
              }
            }
          ]
        }
      ]
    });

    return safeJsonParse<ScanPagePayload>(readAnthropicText(response.content));
  }
}

class OpenAiProvider implements AiProvider {
  private client = new OpenAI({ apiKey: env.openAiApiKey });

  async generateTaskOutput(task: TaskRequest['task'], request: TaskRequest) {
    const response = await this.client.responses.create({
      model: env.openAiModel,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: buildTaskPrompt(task, request) }]
        }
      ]
    });

    return safeJsonParse<TaskResponse>(response.output_text || '');
  }

  async generateToneProfile(request: ToneProfileRequest) {
    const response = await this.client.responses.create({
      model: env.openAiModel,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: buildToneProfilePrompt() }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(request) }]
        }
      ]
    });

    return safeJsonParse<ToneProfileResponse>(response.output_text || '');
  }

  async extractScanFromImage(request: ImageScanRequest) {
    const response = await this.client.responses.create({
      model: env.openAiModel,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: buildVisionPrompt(request) },
            { type: 'input_image', image_url: request.imageDataUrl, detail: 'auto' }
          ]
        }
      ]
    });

    return safeJsonParse<ScanPagePayload>(response.output_text || '');
  }
}

class MockProvider implements AiProvider {
  async generateTaskOutput(task: TaskRequest['task'], request: TaskRequest) {
    return buildMockTaskResponse({ ...request, task });
  }

  async generateToneProfile(request: ToneProfileRequest) {
    return buildMockToneProfile(request);
  }

  async extractScanFromImage(request: ImageScanRequest) {
    return buildMockImageScan(request);
  }
}

export function getAiProvider(): AiProvider {
  if (env.aiProvider === 'ollama') {
    return new OllamaProvider();
  }

  if ((env.aiProvider === 'moonshot' || env.aiProvider === 'kimi') && flags.moonshotConfigured) {
    return new MoonshotProvider();
  }

  if (env.aiProvider === 'anthropic' && flags.anthropicConfigured) {
    return new AnthropicProvider();
  }

  if (env.aiProvider === 'openai' && flags.openAiConfigured) {
    return new OpenAiProvider();
  }

  return new MockProvider();
}
