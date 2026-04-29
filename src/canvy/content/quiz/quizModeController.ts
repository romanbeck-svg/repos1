import { STORAGE_KEYS } from '../../shared/constants';
import type { CanvySettings, OverlayUpdateResponse } from '../../shared/types';
import type { QuizFailReason, QuizModeControllerState, QuizPrefetchResponse, QuizQuestionExtraction } from '../../shared/quizTypes';
import { clearAnswerBubbles, renderScreenScanStatus } from '../screenBubbles';
import { extractQuizQuestion, getQuizObserverRoot } from './extractQuestion';
import { getScreenshotFallbackReason } from './screenshotFallback';

const INIT_FLAG = '__makoIqQuizModeControllerInitialized';
const HISTORY_PATCH_FLAG = '__makoIqQuizModeHistoryPatched';
const MAKO_ROOT_SELECTOR = '#mako-iq-overlay-root, #mako-iq-assistant-root, #canvy-output-overlay-host, #walt-overlay-root';
const NAVIGATION_DEBOUNCE_MS = 120;
const MUTATION_DEBOUNCE_MS = 180;
const EXTRACTION_RETRY_DELAYS_MS = [400, 900, 1500] as const;
const MIN_PREFETCH_CONFIDENCE = 0.65;
const NAVIGATION_TEXT_PATTERN = /\b(next|previous|prev|submit|continue|back|question|quiz|attempt|save|check|review)\b/i;
const MAKO_TEXT_PATTERN = /\b(?:mako iq|scan again|rescan|low confidence|thinking\.{0,3}|answer bubble)\b/i;

interface QuizRequestSnapshot {
  requestId: string;
  tabId?: number;
  questionHash: string;
  startedAt: number;
}

interface QuizExtractionValidationResult {
  ok: boolean;
  failReason: QuizFailReason | null;
  reasons: string[];
}

class QuizModeController {
  private state: QuizModeControllerState = 'OFF';
  private enabled = false;
  private observer: MutationObserver | null = null;
  private debounceTimer: number | undefined;
  private lastQuestionHash = '';
  private currentQuestionHash = '';
  private latestUrl = '';
  private lastExtraction: QuizQuestionExtraction | null = null;
  private lastRequest: QuizRequestSnapshot | null = null;
  private extractionRunId = 0;
  private clickWatcherInstalled = false;
  private navigationListenersInstalled = false;
  private storageListener?: (changes: Record<string, chrome.storage.StorageChange>, areaName: chrome.storage.AreaName) => void;

  initialize() {
    const globalState = window as unknown as Record<string, unknown>;
    if (globalState[INIT_FLAG]) {
      return;
    }
    globalState[INIT_FLAG] = true;

    this.storageListener = (changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const settings = changes[STORAGE_KEYS.settings]?.newValue as Partial<CanvySettings> | undefined;
      if (!settings || typeof settings.quizModeEnabled !== 'boolean') {
        return;
      }

      void this.setEnabled(settings.quizModeEnabled, 'storage-change');
    };

    chrome.storage.onChanged.addListener(this.storageListener);
    this.installDebugHelper();
    void this.readInitialSetting();
  }

  handleNavigationChanged(message: { url?: string; timestamp?: number }) {
    if (!this.enabled) {
      return;
    }

    this.transition('DIRTY', 'web-navigation', {
      url: message.url ?? window.location.href,
      timestamp: message.timestamp
    });
    this.clearCurrentQuestionContext('web-navigation');
    this.scheduleExtraction('web-navigation', NAVIGATION_DEBOUNCE_MS);
  }

  private async readInitialSetting() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
    const settings = stored[STORAGE_KEYS.settings] as Partial<CanvySettings> | undefined;
    await this.setEnabled(Boolean(settings?.quizModeEnabled), 'initial-setting');
  }

  private transition(nextState: QuizModeControllerState, reason: string, payload: Record<string, unknown> = {}) {
    if (this.state === nextState && !import.meta.env.DEV) {
      return;
    }

    this.state = nextState;
    console.info('[Mako IQ quiz]', {
      state: nextState,
      reason,
      ...payload
    });
  }

  private async setEnabled(nextEnabled: boolean, reason: string) {
    if (this.enabled === nextEnabled) {
      return;
    }

    this.enabled = nextEnabled;
    if (!nextEnabled) {
      this.stop(reason);
      return;
    }

    this.start(reason);
  }

  private start(reason: string) {
    this.transition('OBSERVING', reason);
    this.latestUrl = window.location.href;
    this.installHistoryPatch();
    this.installClickWatcher();
    this.installNavigationListeners();
    this.installMutationObserver();
    this.scheduleExtraction('quiz-mode-enabled', 160);
  }

  private stop(reason: string) {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.observer?.disconnect();
    this.observer = null;
    this.lastQuestionHash = '';
    this.currentQuestionHash = '';
    this.lastRequest = null;
    this.extractionRunId += 1;
    clearAnswerBubbles();
    this.transition('OFF', reason);
  }

  private installHistoryPatch() {
    const globalState = window as unknown as Record<string, unknown>;
    if (globalState[HISTORY_PATCH_FLAG]) {
      return;
    }
    globalState[HISTORY_PATCH_FLAG] = true;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function patchedPushState(this: History, ...args: Parameters<History['pushState']>) {
      const result = originalPushState.apply(this, args);
      window.dispatchEvent(new Event('mako:quiz-locationchange'));
      return result;
    } as History['pushState'];

    history.replaceState = function patchedReplaceState(this: History, ...args: Parameters<History['replaceState']>) {
      const result = originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event('mako:quiz-locationchange'));
      return result;
    } as History['replaceState'];
  }

  private installNavigationListeners() {
    if (this.navigationListenersInstalled) {
      return;
    }

    this.navigationListenersInstalled = true;
    window.addEventListener('mako:quiz-locationchange', () => this.handleSoftNavigation('history-change'));
    window.addEventListener('popstate', () => this.handleSoftNavigation('popstate'));
    window.addEventListener('hashchange', () => this.handleSoftNavigation('hashchange'));
  }

  private installClickWatcher() {
    if (this.clickWatcherInstalled) {
      return;
    }

    this.clickWatcherInstalled = true;
    document.addEventListener(
      'click',
      (event) => {
        if (!this.enabled) {
          return;
        }

        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(MAKO_ROOT_SELECTOR)) {
          return;
        }

        const control = target.closest<HTMLElement>(
          [
            'button',
            'a',
            'input[type="button"]',
            'input[type="submit"]',
            '[role="button"]',
            '.ic-Button',
            '.Button',
            '.btn',
            '.quiz_button',
            '.next',
            '.previous',
            '.submit',
            '[data-testid]',
            '[aria-label]'
          ].join(', ')
        );
        if (!control) {
          return;
        }

        const descriptor = [
          control.textContent ?? '',
          control.getAttribute('aria-label') ?? '',
          control.getAttribute('title') ?? '',
          control.getAttribute('data-testid') ?? '',
          control.id,
          typeof control.className === 'string' ? control.className : ''
        ].join(' ');

        if (NAVIGATION_TEXT_PATTERN.test(descriptor)) {
          this.clearCurrentQuestionContext('navigation-click');
          this.scheduleExtraction('navigation-click', NAVIGATION_DEBOUNCE_MS);
        }
      },
      true
    );
  }

  private handleSoftNavigation(reason: string) {
    if (!this.enabled) {
      return;
    }

    if (window.location.href !== this.latestUrl) {
      this.latestUrl = window.location.href;
      this.clearCurrentQuestionContext(reason);
    }

    this.scheduleExtraction(reason, NAVIGATION_DEBOUNCE_MS);
  }

  private installMutationObserver() {
    this.observer?.disconnect();
    const root = getQuizObserverRoot();
    this.observer = new MutationObserver((records) => {
      if (!this.enabled || !this.hasMeaningfulMutation(records)) {
        return;
      }

      this.transition('DIRTY', 'dom-mutation', {
        mutationCount: records.length
      });
      this.clearCurrentQuestionContext('dom-mutation');
      this.scheduleExtraction('dom-mutation', MUTATION_DEBOUNCE_MS);
    });

    this.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden', 'hidden', 'data-testid', 'data-question-id']
    });
  }

  private isMakoMutation(record: MutationRecord) {
    if (record.target instanceof Element && record.target.closest(MAKO_ROOT_SELECTOR)) {
      return true;
    }

    const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    return changedNodes.length > 0 && changedNodes.every((node) => node instanceof Element && Boolean(node.closest(MAKO_ROOT_SELECTOR)));
  }

  private nodeHasMeaningfulVisibleText(node: Node) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element || element.closest(MAKO_ROOT_SELECTOR)) {
      return false;
    }

    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) {
      return false;
    }

    if (element instanceof Element && !element.isConnected) {
      return true;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  private hasMeaningfulMutation(records: MutationRecord[]) {
    return records.some((record) => {
      if (this.isMakoMutation(record)) {
        return false;
      }

      if (record.type === 'attributes') {
        const attributeName = record.attributeName ?? '';
        if (attributeName === 'class' || attributeName === 'style') {
          return false;
        }
        return this.nodeHasMeaningfulVisibleText(record.target);
      }

      if (record.type === 'characterData') {
        return this.nodeHasMeaningfulVisibleText(record.target);
      }

      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      return changedNodes.some((node) => this.nodeHasMeaningfulVisibleText(node));
    });
  }

  private scheduleExtraction(reason: string, delayMs: number) {
    if (!this.enabled) {
      return;
    }

    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.extractAndPrefetch(reason);
    }, delayMs);
  }

  private clearCurrentQuestionContext(reason: string) {
    const requestId = this.createRequestId();
    this.currentQuestionHash = '';
    this.lastRequest = null;
    this.extractionRunId += 1;
    clearAnswerBubbles();
    this.notifyContextChanged(reason, requestId);
  }

  private notifyContextChanged(reason: string, requestId = this.createRequestId(), clearCache = false) {
    try {
      void chrome.runtime.sendMessage({
        type: 'QUIZ_CONTEXT_CHANGED',
        requestId,
        reason,
        clearCache,
        url: window.location.href,
        timestamp: Date.now()
      });
    } catch {
      // The next prefetch still carries its own request id, so this notification is best effort.
    }
    console.info('[Mako IQ quiz]', {
      event: 'context-cleared',
      reason,
      requestId,
      clearCache
    });
  }

  private installDebugHelper() {
    const target = window as unknown as {
      __MAKO_IQ_QUIZ_DEBUG__?: Record<string, unknown>;
    };

    target.__MAKO_IQ_QUIZ_DEBUG__ = {
      getState: () => ({
        state: this.state,
        enabled: this.enabled,
        currentQuestionHash: this.currentQuestionHash,
        lastQuestionHash: this.lastQuestionHash,
        latestUrl: this.latestUrl,
        hasObserver: Boolean(this.observer),
        lastFailReason: this.getExtractionFailReason(this.lastExtraction)
      }),
      getLastExtraction: () => this.lastExtraction,
      getLastRequest: () => this.lastRequest,
      forceExtract: async () => {
        const extraction = await extractQuizQuestion();
        this.lastExtraction = extraction;
        return extraction;
      },
      forcePrefetch: async () => {
        const extraction = this.lastExtraction?.found ? this.lastExtraction : await extractQuizQuestion();
        this.lastExtraction = extraction;
        const failReason = this.getExtractionFailReason(extraction);
        if (failReason) {
          this.renderQuizAssistError(failReason, this.createRequestId(), extraction);
          return { ok: false, failReason, extraction };
        }
        this.currentQuestionHash = extraction.questionHash;
        this.lastQuestionHash = extraction.questionHash;
        const requestId = this.createRequestId();
        renderScreenScanStatus('thinking', 'Thinking...', {
          requestId,
          questionHash: extraction.questionHash,
          anchor: extraction.anchor
        });
        return this.prefetchQuizAnswer(extraction, 'debug-force-prefetch', requestId);
      },
      clearCache: () => {
        this.lastQuestionHash = '';
        this.currentQuestionHash = '';
        this.lastExtraction = null;
        this.lastRequest = null;
        clearAnswerBubbles();
        this.notifyContextChanged('debug-clear-cache', this.createRequestId(), true);
        return true;
      }
    };
  }

  private createRequestId() {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `quiz-${crypto.randomUUID().slice(0, 8)}`
      : `quiz-${Math.random().toString(36).slice(2, 10)}`;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private validateExtraction(extraction: QuizQuestionExtraction | null | undefined): QuizExtractionValidationResult {
    const reasons: string[] = [];

    if (!extraction?.found || !extraction.questionHash || !extraction.questionText) {
      reasons.push('missing-question');
      return {
        ok: false,
        failReason: 'NO_QUESTION_FOUND',
        reasons
      };
    }

    if (MAKO_TEXT_PATTERN.test(extraction.questionText)) {
      reasons.push('question-includes-overlay-text');
    }

    if (
      (extraction.questionType === 'multiple_choice' || extraction.questionType === 'multi_select') &&
      extraction.questionText.length < 15
    ) {
      reasons.push('short-question-text');
    }

    if (extraction.questionType === 'multiple_choice' || extraction.questionType === 'multi_select') {
      if (extraction.answerChoices.length < 2) {
        reasons.push('missing-answer-choices');
      }

      const seenChoiceText = new Set<string>();
      extraction.answerChoices.forEach((choice, index) => {
        const text = choice.text.trim();
        const key = text.toLowerCase();
        if (!text) {
          reasons.push(`empty-choice-${index}`);
        }
        if (MAKO_TEXT_PATTERN.test(text)) {
          reasons.push(`choice-${index}-includes-overlay-text`);
        }
        if (seenChoiceText.has(key)) {
          reasons.push(`duplicate-choice-${index}`);
        }
        seenChoiceText.add(key);
      });
    }

    if (extraction.confidence < MIN_PREFETCH_CONFIDENCE) {
      reasons.push('low-extraction-confidence');
    }

    const failReason = reasons.some((reason) => reason === 'missing-answer-choices' || reason.startsWith('empty-choice') || reason.startsWith('duplicate-choice'))
      ? 'EMPTY_ANSWER_CHOICES'
      : reasons.length > 0
        ? 'LOW_CONFIDENCE_EXTRACTION'
        : null;

    return {
      ok: !failReason,
      failReason,
      reasons
    };
  }

  private getExtractionFailReason(extraction: QuizQuestionExtraction | null | undefined): QuizFailReason | null {
    return this.validateExtraction(extraction).failReason;
  }

  private extractionScore(extraction: QuizQuestionExtraction) {
    if (!extraction.found) {
      return -1;
    }

    return extraction.confidence + Math.min(0.24, extraction.answerChoices.length * 0.04) + (extraction.questionHash ? 0.05 : 0);
  }

  private logExtractionValidation(requestId: string, extraction: QuizQuestionExtraction | null, validation: QuizExtractionValidationResult) {
    console.info('[MakoIQ Extract] validationResult', {
      requestId,
      questionHash: extraction?.questionHash ?? '',
      questionTextLength: extraction?.questionText.length ?? 0,
      answerChoiceCount: extraction?.answerChoices.length ?? 0,
      extractionConfidence: extraction?.confidence ?? 0,
      needsScreenshot: extraction?.needsScreenshot ?? false,
      ok: validation.ok,
      failReason: validation.failReason,
      debugReasons: [...(extraction?.debug.reasons ?? []), ...validation.reasons]
    });
  }

  private logPayloadBeforeAI(requestId: string, extraction: QuizQuestionExtraction) {
    console.info('[MakoIQ Extract] payloadBeforeAI', {
      requestId,
      questionHash: extraction.questionHash,
      pageUrl: extraction.pageUrl,
      questionTextLength: extraction.questionText.length,
      answerChoiceCount: extraction.answerChoices.length,
      extractionConfidence: extraction.confidence,
      modelPayload: {
        mode: 'quiz-prefetch',
        questionHash: extraction.questionHash,
        pageUrl: extraction.pageUrl,
        question: {
          questionText: extraction.questionText,
          questionType: extraction.questionType,
          instructions: extraction.instructions,
          answerChoices: extraction.answerChoices.map((choice) => ({
            index: choice.index,
            label: choice.label,
            text: choice.text
          }))
        },
        extraction: {
          confidence: extraction.confidence,
          method: extraction.method,
          needsScreenshot: extraction.needsScreenshot,
          debugReasons: extraction.debug.reasons
        }
      }
    });
  }

  private async extractStableQuestion(reason: string, runId: number, requestId: string) {
    const detectStartedAt = performance.now();
    let best: QuizQuestionExtraction | null = null;

    for (const delayMs of EXTRACTION_RETRY_DELAYS_MS) {
      const elapsed = performance.now() - detectStartedAt;
      if (elapsed < delayMs) {
        await this.sleep(delayMs - elapsed);
      }

      if (!this.enabled || runId !== this.extractionRunId) {
        return null;
      }

      const extractStartedAt = performance.now();
      const extraction = await extractQuizQuestion();
      this.lastExtraction = extraction;
      if (!best || this.extractionScore(extraction) > this.extractionScore(best)) {
        best = extraction;
      }
      const validation = this.validateExtraction(extraction);
      this.logExtractionValidation(requestId, extraction, validation);

      console.info('[MakoIQ Perf]', {
        quiz_detect_ms: Math.round(performance.now() - detectStartedAt),
        quiz_extract_ms: Math.round(performance.now() - extractStartedAt),
        retryDelayMs: delayMs,
        found: extraction.found,
        confidence: extraction.confidence,
        choiceCount: extraction.answerChoices.length,
        questionHash: extraction.questionHash.slice(0, 12)
      });

      if (validation.ok) {
        break;
      }
    }

    console.info('[Mako IQ quiz]', {
      event: 'stable-extraction-selected',
      reason,
      found: best?.found ?? false,
      confidence: best?.confidence ?? 0,
      choiceCount: best?.answerChoices.length ?? 0,
      questionHash: best?.questionHash.slice(0, 12) ?? '',
      screenshotFallbackReason: best ? getScreenshotFallbackReason(best) || 'none' : 'none',
      failReason: best ? this.validateExtraction(best).failReason : 'NO_QUESTION_FOUND'
    });

    return best;
  }

  private isCurrentQuestionHash(questionHash: string) {
    return Boolean(questionHash) && this.currentQuestionHash === questionHash;
  }

  private mapResponseFailReason(response: QuizPrefetchResponse | undefined): QuizFailReason {
    if (response?.failReason) {
      return response.failReason;
    }

    if (response?.status === 'stale') {
      return 'STALE_RESPONSE';
    }

    if (response?.status === 'no_question') {
      return 'NO_QUESTION_FOUND';
    }

    if (response?.status === 'needs_more_context') {
      return 'LOW_CONFIDENCE_EXTRACTION';
    }

    return 'BACKEND_UNREACHABLE';
  }

  private logPrefetchFailed(options: {
    requestId: string;
    questionHash: string;
    failReason: QuizFailReason;
    extraction?: QuizQuestionExtraction | null;
    backendStatus?: string;
    backendStatusCode?: number;
    elapsedMs: number;
    detail?: string;
  }) {
    console.warn('[MakoIQ QuizMode] Prefetch failed', {
      requestId: options.requestId,
      questionHash: options.questionHash,
      failReason: options.failReason,
      extractedQuestion: options.extraction
        ? {
            found: options.extraction.found,
            confidence: options.extraction.confidence,
            questionText: options.extraction.questionText,
            answerChoices: options.extraction.answerChoices.map((choice) => ({
              index: choice.index,
              label: choice.label,
              text: choice.text,
              inputType: choice.inputType
            })),
            questionType: options.extraction.questionType,
            needsScreenshot: options.extraction.needsScreenshot,
            debug: options.extraction.debug
          }
        : undefined,
      backendStatus: options.backendStatus,
      backendStatusCode: options.backendStatusCode,
      elapsedMs: Math.round(options.elapsedMs),
      detail: options.detail
    });
  }

  private renderQuizAssistError(failReason: QuizFailReason, requestId: string, extraction?: QuizQuestionExtraction | null, detail?: string) {
    this.logPrefetchFailed({
      requestId,
      questionHash: extraction?.questionHash ?? this.currentQuestionHash,
      failReason,
      extraction,
      elapsedMs: this.lastRequest ? performance.now() - this.lastRequest.startedAt : 0,
      detail
    });
    renderScreenScanStatus('error', "Couldn't analyze this question yet. Tap Rescan.", {
      requestId,
      questionHash: extraction?.questionHash ?? this.currentQuestionHash,
      anchor: extraction?.anchor
    });
  }

  private async fallbackToManualScanAnalyze(requestId: string, failReason: QuizFailReason, extraction?: QuizQuestionExtraction | null) {
    console.info('[MakoIQ QuizMode] Falling back to manual scan analyze path.', {
      requestId,
      questionHash: extraction?.questionHash ?? this.currentQuestionHash,
      failReason
    });

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'CAPTURE_VISIBLE_SCREEN',
        requestId: `${requestId}-manual-fallback`,
        source: 'quiz-prefetch-fallback'
      })) as { ok?: boolean; rendered?: boolean; message?: string; error?: string } | undefined;

      return Boolean(response?.ok && response.rendered !== false);
    } catch (error) {
      this.logPrefetchFailed({
        requestId,
        questionHash: extraction?.questionHash ?? this.currentQuestionHash,
        failReason: 'SCREENSHOT_FALLBACK_FAILED',
        extraction,
        elapsedMs: this.lastRequest ? performance.now() - this.lastRequest.startedAt : 0,
        detail: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async prefetchQuizAnswer(extraction: QuizQuestionExtraction, reason: string, requestId = this.createRequestId()) {
    const startedAt = performance.now();
    const request: QuizRequestSnapshot = {
      requestId,
      questionHash: extraction.questionHash,
      startedAt
    };
    this.lastRequest = request;

    this.transition('PREFETCHING', reason, {
      requestId,
      questionHash: extraction.questionHash.slice(0, 12),
      confidence: extraction.confidence,
      screenshotFallbackReason: getScreenshotFallbackReason(extraction) || 'none'
    });
    this.logPayloadBeforeAI(requestId, extraction);

    const response = (await chrome.runtime.sendMessage({
      type: 'QUIZ_PREFETCH_ANSWER',
      requestId,
      reason,
      questionHash: extraction.questionHash,
      startedAt,
      extraction
    })) as QuizPrefetchResponse | undefined;

    console.info('[MakoIQ Perf]', {
      quiz_ai_ms: Math.round(performance.now() - startedAt),
      requestId,
      status: response?.status,
      questionHash: response?.questionHash?.slice(0, 12),
      screenshot_fallback_used: Boolean(response?.usedScreenshot)
    });

    return {
      request,
      response,
      elapsedMs: performance.now() - startedAt
    };
  }

  private async extractAndPrefetch(reason: string) {
    if (!this.enabled) {
      return;
    }

    const runId = ++this.extractionRunId;
    const requestId = this.createRequestId();
    this.transition('EXTRACTING', reason);
    let extraction: QuizQuestionExtraction | null = null;
    try {
      extraction = await this.extractStableQuestion(reason, runId, requestId);
    } catch (error) {
      this.transition('ERROR', 'extract-failed', {
        detail: error instanceof Error ? error.message : String(error)
      });
      const fallbackWorked = await this.fallbackToManualScanAnalyze(requestId, 'NO_QUESTION_FOUND', extraction);
      if (!fallbackWorked) {
        this.renderQuizAssistError('NO_QUESTION_FOUND', requestId, extraction, error instanceof Error ? error.message : String(error));
      }
      this.transition('OBSERVING', 'extract-error-recovered');
      return;
    }

    if (!this.enabled || runId !== this.extractionRunId) {
      return;
    }

    if (!extraction) {
      const fallbackWorked = await this.fallbackToManualScanAnalyze(requestId, 'NO_QUESTION_FOUND', null);
      if (!fallbackWorked) {
        this.renderQuizAssistError('NO_QUESTION_FOUND', requestId, null);
      }
      this.transition('OBSERVING', 'no-stable-extraction');
      return;
    }

    const extractionFailReason = this.getExtractionFailReason(extraction);
    if (extractionFailReason) {
      this.lastQuestionHash = '';
      this.logExtractionValidation(requestId, extraction, this.validateExtraction(extraction));
      const fallbackWorked = await this.fallbackToManualScanAnalyze(requestId, extractionFailReason, extraction);
      if (!fallbackWorked) {
        this.renderQuizAssistError(extractionFailReason, requestId, extraction);
      }
      this.transition('OBSERVING', 'low-confidence-extraction');
      return;
    }

    if (extraction.questionHash === this.lastQuestionHash) {
      this.currentQuestionHash = extraction.questionHash;
      this.transition('OBSERVING', 'unchanged-question', {
        questionHash: extraction.questionHash.slice(0, 12)
      });
      return;
    }

    this.lastQuestionHash = extraction.questionHash;
    this.currentQuestionHash = extraction.questionHash;
    clearAnswerBubbles();
    this.notifyContextChanged('question-hash-changed');
    const thinkingRequestId = requestId;
    renderScreenScanStatus('thinking', 'Thinking...', {
      requestId: thinkingRequestId,
      questionHash: extraction.questionHash,
      anchor: extraction.anchor
    });

    try {
      const { request, response, elapsedMs } = await this.prefetchQuizAnswer(extraction, reason, thinkingRequestId);
      const responseHash = response?.questionHash ?? request.questionHash;
      if (!this.enabled || !this.isCurrentQuestionHash(responseHash)) {
        console.info('[Mako IQ quiz] Ignored stale prefetch response.', {
          requestId: request.requestId,
          responseHash: responseHash.slice(0, 12),
          currentQuestionHash: this.currentQuestionHash.slice(0, 12)
        });
        return;
      }

      if (
        !response?.ok ||
        (response.status !== 'answered' && response.status !== 'cached' && response.status !== 'needs_more_context') ||
        response.rendered === false
      ) {
        const failReason = this.mapResponseFailReason(response);
        this.logPrefetchFailed({
          requestId: request.requestId,
          questionHash: request.questionHash,
          failReason,
          extraction,
          backendStatus: response?.status,
          elapsedMs,
          detail: response?.error ?? response?.message
        });
        const fallbackWorked = await this.fallbackToManualScanAnalyze(request.requestId, failReason, extraction);
        if (!fallbackWorked && this.isCurrentQuestionHash(request.questionHash)) {
          this.renderQuizAssistError(failReason, request.requestId, extraction, response?.error ?? response?.message);
        }
        this.transition('ERROR', 'prefetch-failed', {
          requestId: request.requestId,
          message: response?.message,
          error: response?.error,
          failReason
        });
        this.transition('OBSERVING', 'prefetch-error-recovered');
        return;
      }

      this.transition('READY', 'prefetch-complete', {
        requestId: request.requestId,
        rendered: response.rendered,
        status: response.status
      });
      window.setTimeout(() => {
        if (this.enabled && this.state === 'READY') {
          this.transition('OBSERVING', 'ready-settled');
        }
      }, 300);
    } catch (error) {
      if (!this.isCurrentQuestionHash(extraction.questionHash)) {
        return;
      }

      const requestId = this.lastRequest?.questionHash === extraction.questionHash ? this.lastRequest.requestId : this.createRequestId();
      this.transition('ERROR', 'prefetch-message-failed', {
        requestId,
        detail: error instanceof Error ? error.message : String(error)
      });
      const fallbackWorked = await this.fallbackToManualScanAnalyze(requestId, 'BACKEND_UNREACHABLE', extraction);
      if (!fallbackWorked && this.isCurrentQuestionHash(extraction.questionHash)) {
        this.renderQuizAssistError('BACKEND_UNREACHABLE', requestId, extraction, error instanceof Error ? error.message : String(error));
      }
      this.transition('OBSERVING', 'message-error-recovered');
    }
  }
}

let controller: QuizModeController | null = null;

export function initializeQuizModeController() {
  if (!controller) {
    controller = new QuizModeController();
  }
  controller.initialize();
  return controller;
}

export function handleQuizNavigationMessage(message: { url?: string; timestamp?: number }): OverlayUpdateResponse {
  initializeQuizModeController().handleNavigationChanged(message);
  return {
    ok: true,
    visible: false,
    message: 'Quiz Mode navigation change handled.'
  };
}
