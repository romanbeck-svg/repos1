# Quiz Mode

Quiz Mode is an opt-in study-assistance mode for Mako IQ. It watches the current page for question changes, clears stale answer bubbles, extracts the new question from visible DOM text first, and prefetches an AI answer so the answer bubble can appear with less waiting.

Quiz Mode does not click, select, submit, hide automation, bypass proctoring tools, or try to evade LMS rules. It only displays transparent answer suggestions and explanations in the Mako IQ overlay, and the user can turn it off from the popup or workspace.

## User Controls

- Popup: the Quiz Mode toggle appears under the screen actions.
- Workspace/sidebar: the Quiz Mode toggle appears in Workspace tools and Settings.
- Setting storage: `makoiq.settings.quizModeEnabled` in `chrome.storage.local`.
- Off behavior: content observers disconnect, automatic prefetching stops, and manual scan actions still use the existing screen scan flow.

## Architecture

- Content controller: `src/canvy/content/quiz/quizModeController.ts`
- DOM extractor: `src/canvy/content/quiz/extractQuestion.ts`
- Hashing: `src/canvy/content/quiz/questionHash.ts`
- Screenshot fallback gating: `src/canvy/content/quiz/screenshotFallback.ts`
- Shared extension types: `src/canvy/shared/quizTypes.ts`
- Background prefetch/caching: `src/canvy/background/main.ts`
- Backend route: `backend/src/routes/quiz.ts`
- Backend Kimi/Moonshot service: `backend/src/services/quiz-analysis.ts`

The background service worker listens for top-frame `webNavigation` events and notifies the content script with `QUIZ_NAVIGATION_CHANGED`. The content controller also handles SPA history changes, navigation-like clicks, and debounced DOM mutations.

## Extraction Strategy

Quiz Mode is DOM-first. It prefers focused quiz/question containers and visible text from labels, fieldsets, ARIA choice roles, select options, LMS question classes, and generic question/prompt structures. It also handles custom button/card answers where the real input is hidden or replaced by a clickable tile with `role="button"`, `tabindex`, quiz-related classes, or `data-testid`/answer attributes. It avoids navbars, sidebars, footers, hidden nodes, Mako IQ UI, scripts, styles, and unrelated controls.

Quiz Mode waits for the DOM to settle before sending anything to AI. After a detected page or question change, it clears old bubbles, waits 400 ms, extracts, retries at 800 ms and 1400 ms if the result is low confidence, then uses the highest-confidence extraction. It does not call AI until a stable `questionHash` exists.

Screenshot fallback is only used when DOM extraction remains low confidence after retries, answer choices are missing, or the question itself references an image, graph, chart, diagram, table, or figure. Decorative SVGs inside answer cards should not trigger screenshot fallback. The background captures from the extension side and crops around the detected question box when possible.

## Stale Response Guard

Every Quiz Mode prefetch includes `requestId`, `questionHash`, and `startedAt`; the background adds the sender tab id. The content controller ignores a response only when its `questionHash` no longer matches the current question. Minor style, focus, hover, and Mako IQ overlay mutations are ignored so valid responses are not marked stale.

## Failure Handling

Quiz Mode tracks internal failure reasons such as `NO_QUESTION_FOUND`, `LOW_CONFIDENCE_EXTRACTION`, `EMPTY_ANSWER_CHOICES`, `BACKEND_UNREACHABLE`, `BACKEND_4XX`, `BACKEND_5XX`, `AI_TIMEOUT`, `AI_JSON_PARSE_ERROR`, `STALE_RESPONSE`, `PERMISSION_MISSING`, and `SCREENSHOT_FALLBACK_FAILED`.

The page UI shows a small actionable message: `Couldn't analyze this question yet. Tap Rescan.` The detailed reason is logged in the console under `[MakoIQ QuizMode] Prefetch failed`.

Before showing that error, Quiz Mode falls back to the same visible-screen analyze path used by the manual Rescan/Scan Page action. If that manual-style fallback renders an answer, no Quiz Mode prefetch error is shown.

## Debug Helper

In development, the content script exposes:

```js
window.__MAKO_IQ_QUIZ_DEBUG__
```

Available helpers:

- `getState()`
- `getLastExtraction()`
- `getLastRequest()`
- `forceExtract()`
- `forcePrefetch()`
- `clearCache()`

## Cache

The background keeps a short-lived per-tab cache keyed by `questionHash`. The hash includes the normalized URL, title, question text, answer choice text, input types, container attributes, and visual-content flags. If the same hash appears again before expiry, Mako IQ renders the cached answer immediately. Screenshots are not stored.

## Smoke Checks

Run:

```bash
npm run smoke:quiz-mode
```

The smoke script checks that the expected implementation hooks exist for:

1. Normal multiple-choice DOM extraction.
2. Button/card-style answer extraction.
3. DOM stability retries.
4. Question changes without URL changes.
5. SPA route changes.
6. Low-confidence visual fallback gating.
7. Question-hash stale response ignoring.
8. Clearing old bubbles on question changes.
9. Manual scan fallback.
10. Cache-hit rendering.
11. Quiz Mode off stopping automatic detection.

The local fixture for the card-style failure is:

```text
public/fixtures/quiz-card-fixture.html
```

It contains a visible question, `Select one answer`, four nested answer cards labeled A-D, and decorative SVG icons inside each card. Expected Quiz Mode behavior: four extracted choices, `questionType: "multiple_choice"`, `needsScreenshot: false`, one prefetch request, no generic prefetch error, and a bubble that does not cover the question or answer cards.

## Manual Acceptance

1. Open a quiz-like page and enable Quiz Mode from the popup.
2. Confirm the workspace toggle mirrors the setting.
3. Move to the next question and confirm old bubbles clear immediately.
4. Wait for the page to settle and confirm a new bubble appears automatically.
5. Move quickly across questions and confirm old answers do not render on the new question.
6. Confirm image-heavy questions log `screenshot_fallback_used` only when needed.
7. Disable Quiz Mode and confirm automatic prefetching stops.
8. Run manual Show Answers or Open Popup + Scan and confirm manual scanning still works.
9. Open `public/fixtures/quiz-card-fixture.html`, enable Quiz Mode, and confirm the debug helper reports four `button_or_card` choices with `needsScreenshot: false`.
