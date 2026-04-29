# Analyze Answers Extraction Repair

## Root Cause Audit

Files inspected:

- `src/canvy/content/assistantPanel.ts`
- `src/canvy/content/main.tsx`
- `src/canvy/content/screenContext.ts`
- `src/canvy/content/screenBubbles.ts`
- `src/canvy/content/extraction.ts`
- `src/canvy/background/main.ts`
- `src/canvy/services/api.ts`
- `backend/src/services/screen-analysis.ts`
- `backend/src/types/screen.ts`

Current flow:

1. Floating Screen Assistant or workspace sends `CAPTURE_VISIBLE_SCREEN`.
2. Background resolves the active tab, attaches the content script, reads viewport and compact DOM context, then optionally captures a screenshot.
3. Background posts `/api/screen/analyze` with screenshot metadata and `textContext`.
4. Backend sends strict JSON instructions plus page context to Kimi/Moonshot.
5. Background renders `RENDER_ANSWER_BUBBLES` into the content script.

Root causes found:

- `screenContext.ts` detected questions primarily from narrow text selectors. It could treat `A. ...`, `B. ...`, etc. as question candidates while missing the nearby stem if the stem was in a generic container.
- Answer choice grouping depended on first finding the question stem. It did not reliably start from visible choices and climb back to the stem.
- The screenshot path started while Mako UI was still visible. The floating assistant could cover answer D and contaminate the captured image.
- The background started screenshot capture before knowing whether compact DOM context was sufficient, wasting time on DOM-answerable screens.
- The backend prompt did not explicitly say that `page_context.questionCandidates[].question` is a visible stem, so the model could still claim the stem was missing.

## Implementation

- Added scan-clean UI mode in `src/canvy/content/main.tsx`.
- Added `SCREEN_SET_MAKO_UI_HIDDEN` so the background can hide and restore Mako overlays around capture/extraction.
- Updated `src/canvy/background/main.ts` to hide Mako UI before context extraction and screenshot capture, restore it afterward, and avoid screenshot capture when DOM question context is strong.
- Reworked `src/canvy/content/screenContext.ts` so it builds structured question candidates from answer-choice groups, climbs to nearby stems, preserves answer labels, and ignores Mako UI roots.
- Updated the backend screen-analysis prompt to trust supplied question candidates as visible stems and use answer choices for multiple-choice solving.

## Verification Checklist

- Analyze/Scan hides Mako UI before extraction and screenshot capture.
- Floating assistant no longer covers answer choices during capture.
- DOM context includes `Question: ...` plus `Answer choices: A. ... | B. ...`.
- Answer choices are not misclassified as standalone questions.
- Fast DOM context avoids screenshot upload when a full stem and choices are available.
- Backend no longer claims the stem is missing when `questionCandidates[].question` contains it.
- TypeScript check passes.
- Backend build passes.
