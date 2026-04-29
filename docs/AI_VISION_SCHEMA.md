# AI Vision Schema

## Endpoint

`POST /api/screen/analyze`

Purpose: analyze a visible-tab screenshot and return structured question/task answers with normalized screen coordinates.

## Request

```json
{
  "image": "data:image/png;base64,...",
  "pageUrl": "https://example.com/page",
  "pageTitle": "Example Page",
  "viewport": {
    "width": 1440,
    "height": 900,
    "devicePixelRatio": 2
  },
  "mode": "questions"
}
```

Rules:

- `image` must be a screenshot data URL.
- `viewport.width` and `viewport.height` represent the content-script viewport at capture time.
- `bbox` values returned by the model are normalized from 0 to 1 relative to this screenshot/viewport.

## Success Response

```json
{
  "ok": true,
  "analysisId": "uuid-or-timestamp",
  "summary": "Short description of what was found.",
  "items": [
    {
      "id": "q_1",
      "type": "question",
      "question": "Detected question text",
      "answer": "Recommended answer",
      "explanation": "Short explanation or why this answer fits.",
      "confidence": 0.87,
      "bbox": {
        "x": 0.12,
        "y": 0.34,
        "width": 0.46,
        "height": 0.08
      }
    }
  ],
  "warnings": []
}
```

Allowed item types:

- `question`
- `task`
- `math`
- `multiple_choice`
- `short_answer`

## Empty Response

```json
{
  "ok": true,
  "analysisId": "uuid-or-timestamp",
  "items": [],
  "summary": "No clear questions found on the visible screen.",
  "warnings": ["NO_QUESTIONS_DETECTED"]
}
```

## Restricted Assessment Response

```json
{
  "ok": true,
  "analysisId": "uuid-or-timestamp",
  "items": [],
  "summary": "Mako IQ can help explain concepts or create study notes, but it will not provide live answers for restricted assessments.",
  "warnings": ["RESTRICTED_ASSESSMENT"]
}
```

## Failure Response

```json
{
  "ok": false,
  "error": "SCREEN_ANALYSIS_FAILED",
  "message": "Mako IQ could not analyze this screenshot."
}
```

## Follow-Up Endpoint

`POST /api/screen/follow-up`

Request:

```json
{
  "analysisId": "existing-analysis-id",
  "itemId": "q_1",
  "question": "User follow-up",
  "originalQuestion": "Detected question text",
  "originalAnswer": "Recommended answer",
  "screenshotContext": "optional"
}
```

Success:

```json
{
  "ok": true,
  "answer": "Follow-up answer",
  "explanation": "Optional short explanation"
}
```

Failure:

```json
{
  "ok": false,
  "error": "SCREEN_FOLLOWUP_FAILED",
  "message": "Mako IQ could not answer this follow-up."
}
```

## Vision Prompt

System:

```text
You are Mako IQ's screen analysis engine. You analyze screenshots and identify visible questions or tasks. You return strict JSON only.
```

User:

```text
Analyze this screenshot. Find visible questions or tasks. For each one, return question text, recommended answer, short explanation, confidence, and normalized bounding box coordinates.

Return this exact JSON shape:
{
  "summary": string,
  "items": [
    {
      "id": string,
      "type": "question" | "task" | "math" | "multiple_choice" | "short_answer",
      "question": string,
      "answer": string,
      "explanation": string,
      "confidence": number,
      "bbox": {
        "x": number,
        "y": number,
        "width": number,
        "height": number
      }
    }
  ],
  "warnings": string[]
}

Rules:
- Coordinates must be normalized 0 to 1 relative to the screenshot.
- If no question is visible, return an empty items array.
- Keep answers concise.
- Keep explanations helpful but short.
- Do not invent questions that are not visible.
- Ignore decorative text, nav bars, buttons, ads, and unrelated UI.
- Do not answer restricted/proctored assessment content. If the screenshot appears to be a locked/proctored exam, return a warning and no direct answers.
- Never return markdown.
- Never include extra commentary outside JSON.
```

## Backend Validation

The backend normalizes model output before returning it:

- Drops items without question or answer text.
- Clamps confidence to `0..1`.
- Clamps bbox fields to normalized `0..1`.
- Drops invalid or zero-size bboxes so the frontend can use fallback stacking.
- Limits returned items to 12.
- Converts restricted warnings into no-answer responses.

## Frontend Mapping

The content script maps normalized bbox to viewport pixels:

```ts
const viewportX = bbox.x * window.innerWidth;
const viewportY = bbox.y * window.innerHeight;
const viewportW = bbox.width * window.innerWidth;
const viewportH = bbox.height * window.innerHeight;
```

Placement:

- Prefer right side of the detected question.
- Fall back left, then clamp to viewport margins.
- Use fixed positioning.
- Use top-right stacked fallback when coordinates are missing.

## Ethical Guardrails

The model and backend must not implement:

- Stealth overlays
- Screen-share-invisible UI
- Anti-proctoring behavior
- Lockdown browser bypasses
- Hidden exam-answer workflows

Restricted assessment handling must return no direct answers and should offer concept explanation or study-note support only.
