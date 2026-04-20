import type { AutofillSuggestion, FormFieldInfo, PageContext, SiteKind } from '../shared/types';

type OverlayTone = 'status' | 'error';

const AUTOFILL_STORAGE_KEY = '__waltLastAutofillSuggestions';

function detectSiteKind(): SiteKind {
  const url = window.location.href;
  const title = document.title.toLowerCase();
  const bodyText = (document.body?.innerText ?? '').slice(0, 3000).toLowerCase();

  if (document.querySelector('form, input, textarea, select')) {
    if (url.includes('mail.google.com') || title.includes('gmail') || bodyText.includes('compose')) {
      return 'email';
    }
    return 'form';
  }

  if (document.querySelector('article, main article')) {
    return 'article';
  }

  if (url.includes('docs.google.com/document') || title.includes('document')) {
    return 'document';
  }

  if (bodyText.includes('error') || bodyText.includes('failed')) {
    return 'error';
  }

  if (document.querySelector('table, canvas, svg, [role="grid"]')) {
    return 'dashboard';
  }

  return 'generic';
}

function getSelectedText() {
  return window.getSelection()?.toString().trim() ?? '';
}

function collectText(elements: Element[]) {
  return elements
    .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean);
}

function getExcerpt() {
  const mainText = (document.querySelector('main')?.textContent ?? document.body?.innerText ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const headings = collectText(Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 6));
  const alerts = collectText(Array.from(document.querySelectorAll('[role="alert"], .error, .warning, .notice')).slice(0, 5));
  const buttons = collectText(Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 8));
  const listItems = collectText(Array.from(document.querySelectorAll('li')).slice(0, 10));

  return [
    headings.length ? `Headings: ${headings.join(' | ')}` : '',
    alerts.length ? `Alerts: ${alerts.join(' | ')}` : '',
    buttons.length ? `Buttons: ${buttons.join(' | ')}` : '',
    listItems.length ? `List items: ${listItems.join(' | ')}` : '',
    mainText
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 2600);
}

function describeField(field: Element, index: number): FormFieldInfo {
  const input = field as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const explicitLabel = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : '';
  const wrappingLabel = input.closest('label')?.textContent;

  return {
    id: input.id || `walt-field-${index}`,
    label: (explicitLabel || wrappingLabel || '').trim(),
    name: input.getAttribute('name') ?? '',
    type: input.getAttribute('type') ?? input.tagName.toLowerCase(),
    placeholder: input.getAttribute('placeholder') ?? ''
  };
}

function getFormFields() {
  return Array.from(document.querySelectorAll('input, textarea, select'))
    .slice(0, 12)
    .map((field, index) => describeField(field, index));
}

function getPageContext(): PageContext {
  const activeElement = document.activeElement as HTMLElement | null;
  return {
    title: document.title,
    url: window.location.href,
    selectedText: getSelectedText(),
    excerpt: getExcerpt(),
    siteKind: detectSiteKind(),
    canInsertText: Boolean(
      activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
    ),
    formFields: getFormFields()
  };
}

function ensureOverlayRoot() {
  let root = document.getElementById('walt-overlay-root');
  if (root) {
    return root;
  }

  root = document.createElement('div');
  root.id = 'walt-overlay-root';
  root.innerHTML = `
    <style>
      #walt-overlay-root {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        width: min(540px, calc(100vw - 28px));
        font-family: "Segoe UI", sans-serif;
        pointer-events: none;
      }
      #walt-overlay-root[hidden] {
        display: none;
      }
      #walt-overlay-root .walt-card {
        background: rgba(8, 15, 28, 0.76);
        color: #ecf4ff;
        border: 1px solid rgba(104, 156, 255, 0.2);
        border-radius: 20px;
        box-shadow: 0 22px 60px rgba(0, 0, 0, 0.36);
        backdrop-filter: blur(18px);
        overflow: hidden;
        pointer-events: auto;
      }
      #walt-overlay-root .walt-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        padding: 14px 16px 8px;
      }
      #walt-overlay-root .walt-label {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #79d2ff;
        font-weight: 700;
      }
      #walt-overlay-root .walt-title {
        font-size: 16px;
        font-weight: 700;
        margin: 2px 0 0;
      }
      #walt-overlay-root .walt-close {
        background: transparent;
        border: 0;
        color: #cfe2ff;
        font-size: 18px;
        cursor: pointer;
      }
      #walt-overlay-root .walt-body {
        padding: 0 16px 16px;
        white-space: pre-wrap;
        line-height: 1.45;
        color: #bad0ef;
      }
      #walt-overlay-root .walt-body.error {
        color: #ffbcc6;
      }
    </style>
    <div class="walt-card">
      <div class="walt-head">
        <div>
          <div class="walt-label">Walt</div>
          <div class="walt-title">Update</div>
        </div>
        <button class="walt-close" type="button" aria-label="Close">x</button>
      </div>
      <div class="walt-body"></div>
    </div>
  `;

  root.querySelector('.walt-close')?.addEventListener('click', () => {
    root?.setAttribute('hidden', 'true');
  });

  document.documentElement.appendChild(root);
  return root;
}

function showOverlay(title: string, message: string, tone: OverlayTone = 'status') {
  const root = ensureOverlayRoot();
  const titleNode = root.querySelector('.walt-title');
  const bodyNode = root.querySelector('.walt-body');
  if (!titleNode || !bodyNode) {
    return;
  }
  titleNode.textContent = title;
  bodyNode.textContent = message;
  bodyNode.className = `walt-body ${tone === 'error' ? 'error' : ''}`.trim();
  root.removeAttribute('hidden');
}

function applyTextToActiveField(text: string) {
  const active = document.activeElement;
  if (!active) {
    return false;
  }

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? active.value.length;
    const end = active.selectionEnd ?? active.value.length;
    active.value = `${active.value.slice(0, start)}${text}${active.value.slice(end)}`;
    active.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    document.execCommand('insertText', false, text);
    active.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
  }

  return false;
}

function applyAutofillSuggestions(suggestions: AutofillSuggestion[]) {
  let applied = 0;
  suggestions.forEach((suggestion) => {
    if (!suggestion.value) {
      return;
    }

    const escapedId = suggestion.fieldId ? CSS.escape(suggestion.fieldId) : '';
    const field =
      (escapedId ? document.getElementById(suggestion.fieldId) : null) ??
      Array.from(document.querySelectorAll('input, textarea, select')).find((node) => {
        const text = `${(node as HTMLElement).getAttribute('name') ?? ''} ${(node as HTMLElement).getAttribute('placeholder') ?? ''}`.toLowerCase();
        return text.includes(suggestion.fieldLabel.toLowerCase());
      });

    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
      return;
    }

    field.value = suggestion.value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    applied += 1;
  });

  return applied;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_PAGE_CONTEXT') {
    sendResponse(getPageContext());
    return;
  }

  if (message?.type === 'SHOW_WALT_RESULT') {
    showOverlay(String(message.title ?? 'Walt'), String(message.message ?? 'Done.'), message.error ? 'error' : 'status');
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'INSERT_TEXT_AT_ACTIVE_FIELD') {
    sendResponse({ ok: applyTextToActiveField(String(message.payload ?? '')) });
    return;
  }

  if (message?.type === 'STORE_AUTOFILL_SUGGESTIONS') {
    sessionStorage.setItem(AUTOFILL_STORAGE_KEY, JSON.stringify(message.suggestions ?? []));
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === 'APPLY_LAST_AUTOFILL_SUGGESTIONS') {
    try {
      const raw = sessionStorage.getItem(AUTOFILL_STORAGE_KEY);
      const suggestions = raw ? (JSON.parse(raw) as AutofillSuggestion[]) : [];
      const applied = applyAutofillSuggestions(suggestions);
      sendResponse({ ok: applied > 0, applied });
    } catch {
      sendResponse({ ok: false, applied: 0 });
    }
  }
});
