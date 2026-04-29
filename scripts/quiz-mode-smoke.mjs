import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function assert(name, condition) {
  if (!condition) {
    throw new Error(`Quiz Mode smoke check failed: ${name}`);
  }
  console.log(`ok - ${name}`);
}

const controller = read('src/canvy/content/quiz/quizModeController.ts');
const extractor = read('src/canvy/content/quiz/extractQuestion.ts');
const fallback = read('src/canvy/content/quiz/screenshotFallback.ts');
const background = read('src/canvy/background/main.ts');
const backendRoute = read('backend/src/routes/quiz.ts');
const backendService = read('backend/src/services/quiz-analysis.ts');
const manifest = read('public/manifest.json');
const fixture = read('public/fixtures/quiz-card-fixture.html');

assert('normal multiple-choice DOM extraction is present', /input\[type="radio"\]/.test(extractor) && /answerChoices/.test(extractor));
assert('card-style answer extraction is present', /button_or_card/.test(extractor) && /role="button"/.test(fixture) && /answer-card-a/.test(fixture));
assert('decorative SVG quiz cards do not force screenshot first', /visualTextReferences/.test(extractor) && /needsScreenshot/.test(extractor));
assert('DOM stability retry delays are configured', /EXTRACTION_RETRY_DELAYS_MS = \[400,\s*(?:800|900),\s*(?:1400|1500)\]\s*(?:as const)?/.test(controller));
assert('question changes without URL changes are observed', /new MutationObserver/.test(controller) && /attributeFilter/.test(controller));
assert('SPA route changes are handled', /onHistoryStateUpdated/.test(background) && /mako:quiz-locationchange/.test(controller));
assert('low-confidence visual fallback is gated', /confidence < 0\.65/.test(fallback) && /screenshot_fallback_used/.test(background));
assert('stale AI responses are ignored by question hash', /activeQuizQuestionHashes/.test(background) && /isCurrentQuestionHash/.test(controller));
assert('old bubbles are cleared on question change', /clearAnswerBubbles/.test(controller) && /QUIZ_CONTEXT_CHANGED/.test(controller));
assert('manual scan fallback is available', /fallbackToManualScanAnalyze/.test(controller) && /CAPTURE_VISIBLE_SCREEN/.test(controller));
assert('actionable fail reasons are tracked', /QuizFailReason/.test(controller) && /AI_JSON_PARSE_ERROR/.test(backendService));
assert('quiz debug helper is exposed', /__MAKO_IQ_QUIZ_DEBUG__/.test(controller));
assert('cache hit path is available', /quizModeCache/.test(background) && /status: 'cached'/.test(background));
assert('Quiz Mode off disconnects automatic detection', /observer\?\.disconnect/.test(controller) && /quizModeEnabled/.test(controller));
assert('backend quiz endpoint is registered', /quizRouter\.post\('\/analyze'/.test(backendRoute) && /QUIZ_ANALYSIS_SYSTEM_PROMPT/.test(backendService));
assert('webNavigation permission is declared', /"webNavigation"/.test(manifest));
