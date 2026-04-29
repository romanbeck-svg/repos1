import { STORAGE_KEYS } from '../shared/constants';
import type { ScreenPreScanCacheEntry } from '../shared/types';
import { buildScreenPageSignature, clearScreenExtractionCache, extractScreenTextContext } from './screenContext';
import { clearAnswerBubbles } from './screenBubbles';

const WATCHER_FLAG = '__makoIqScreenPageWatcherInitialized';
const HISTORY_PATCH_FLAG = '__makoIqHistoryPatchInstalled';
const MAKO_ROOT_SELECTOR = '#mako-iq-overlay-root, #mako-iq-assistant-root, #canvy-output-overlay-host, #walt-overlay-root';
const NAVIGATION_TEXT_PATTERN = /\b(next|previous|prev|submit|continue|back|question|quiz|attempt|save)\b/i;
const PRESCAN_TTL_MS = 10 * 60 * 1000;

let lastSignature = '';
let signatureTimer: number | undefined;
let observer: MutationObserver | null = null;
let preScanTimer: number | undefined;
let preScanRunId = 0;

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function isMakoNode(node: Node) {
  if (!(node instanceof Element)) {
    return false;
  }

  return Boolean(node.matches(MAKO_ROOT_SELECTOR) || node.closest(MAKO_ROOT_SELECTOR));
}

function mutationsOnlyTouchMako(records: MutationRecord[]) {
  return records.every((record) => {
    if (isMakoNode(record.target)) {
      return true;
    }

    const added = Array.from(record.addedNodes);
    const removed = Array.from(record.removedNodes);
    return added.concat(removed).length > 0 && added.concat(removed).every(isMakoNode);
  });
}

function notifyBackground(reason: string, signature: string) {
  try {
    chrome.runtime.sendMessage({
      type: 'SCREEN_PAGE_CONTEXT_CHANGED',
      requestId: createRequestId(),
      reason,
      pageSignature: signature,
      url: window.location.href,
      timestamp: Date.now()
    });
  } catch (error) {
    console.info('[Mako IQ content] Could not notify background of page context change.', {
      reason,
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

function getSessionStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

async function storePreScanContext(reason: string, signature: string, runId: number) {
  const context = extractScreenTextContext();
  if (runId !== preScanRunId) {
    return;
  }

  const entry: ScreenPreScanCacheEntry = {
    url: window.location.href,
    pageTitle: context.pageTitle,
    pageSignature: signature,
    visibleTextHash: context.visibleTextHash ?? context.questionContext?.visibleTextHash ?? '',
    context,
    createdAt: Date.now(),
    expiresAt: Date.now() + PRESCAN_TTL_MS,
    reason
  };

  await getSessionStorageArea().set({
    [STORAGE_KEYS.screenPreScanContext]: entry
  });
}

function schedulePreScan(reason: string, signature: string, delayMs = 360) {
  if (preScanTimer !== undefined) {
    window.clearTimeout(preScanTimer);
  }

  const runId = ++preScanRunId;
  preScanTimer = window.setTimeout(() => {
    preScanTimer = undefined;
    void storePreScanContext(reason, signature, runId).catch((error) => {
      console.info('[Mako IQ content] Could not store pre-scan context.', {
        reason,
        detail: error instanceof Error ? error.message : String(error)
      });
    });
  }, delayMs);
}

function handleMeaningfulChange(reason: string, nextSignature: string) {
  lastSignature = nextSignature;
  clearScreenExtractionCache();
  clearAnswerBubbles();
  notifyBackground(reason, nextSignature);
  schedulePreScan(reason, nextSignature);
  console.info('[Mako IQ content] Cleared stale answer context.', {
    reason,
    url: window.location.href
  });
}

function evaluateSignature(reason: string) {
  const nextSignature = buildScreenPageSignature();
  if (!lastSignature) {
    lastSignature = nextSignature;
    return;
  }

  if (nextSignature !== lastSignature) {
    handleMeaningfulChange(reason, nextSignature);
  }
}

function scheduleSignatureCheck(reason: string, delayMs = 280) {
  if (signatureTimer !== undefined) {
    window.clearTimeout(signatureTimer);
  }

  signatureTimer = window.setTimeout(() => {
    signatureTimer = undefined;
    evaluateSignature(reason);
  }, delayMs);
}

function patchHistoryMethods() {
  const globalState = window as unknown as Record<string, unknown>;
  if (globalState[HISTORY_PATCH_FLAG]) {
    return;
  }
  globalState[HISTORY_PATCH_FLAG] = true;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function patchedPushState(this: History, ...args: Parameters<History['pushState']>) {
    const result = originalPushState.apply(this, args);
    window.dispatchEvent(new Event('mako:locationchange'));
    return result;
  } as History['pushState'];

  history.replaceState = function patchedReplaceState(this: History, ...args: Parameters<History['replaceState']>) {
    const result = originalReplaceState.apply(this, args);
    window.dispatchEvent(new Event('mako:locationchange'));
    return result;
  } as History['replaceState'];
}

function getObserverRoot() {
  return (
    document.querySelector('#content') ??
    document.querySelector('main') ??
    document.querySelector('[role="main"]') ??
    document.body ??
    document.documentElement
  );
}

function installMutationObserver() {
  observer?.disconnect();
  const root = getObserverRoot();
  observer = new MutationObserver((records) => {
    if (mutationsOnlyTouchMako(records)) {
      return;
    }

    scheduleSignatureCheck('dom_mutation', 320);
  });

  observer.observe(root, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

function getNavigationElement(target: EventTarget | null) {
  if (!(target instanceof Element) || target.closest(MAKO_ROOT_SELECTOR)) {
    return null;
  }

  return target.closest<HTMLElement>(
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
}

function installClickWatcher() {
  document.addEventListener(
    'click',
    (event) => {
      const element = getNavigationElement(event.target);
      if (!element) {
        return;
      }

      const descriptor = [
        element.textContent ?? '',
        element.getAttribute('aria-label') ?? '',
        element.getAttribute('title') ?? '',
        element.getAttribute('data-testid') ?? '',
        element.id,
        typeof element.className === 'string' ? element.className : ''
      ].join(' ');

      if (NAVIGATION_TEXT_PATTERN.test(descriptor)) {
        scheduleSignatureCheck('navigation_click', 180);
        window.setTimeout(() => scheduleSignatureCheck('navigation_click_settled', 420), 420);
      }
    },
    true
  );
}

export function initializeScreenPageWatcher() {
  const globalState = window as unknown as Record<string, unknown>;
  if (globalState[WATCHER_FLAG]) {
    return;
  }
  globalState[WATCHER_FLAG] = true;

  lastSignature = buildScreenPageSignature();
  patchHistoryMethods();
  installMutationObserver();
  installClickWatcher();
  schedulePreScan('watcher-initialized', lastSignature, 420);

  window.addEventListener('mako:locationchange', () => scheduleSignatureCheck('url_change', 0));
  window.addEventListener('popstate', () => scheduleSignatureCheck('popstate', 0));
  window.addEventListener('hashchange', () => scheduleSignatureCheck('hashchange', 0));
}
