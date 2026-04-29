import type { AssistantSurfaceMode, PageSurfaceType, SidebarMode } from './types';

export interface LaunchSupport {
  isSupported: boolean;
  pageType: PageSurfaceType;
  assistantMode: AssistantSurfaceMode;
  statusLabel: string;
  message: string;
}

const UNSUPPORTED_PAGE_MESSAGE = 'Screen and page tools are limited on this tab.';

export function isCanvasUrl(url: string) {
  return /canvaslms\.com|instructure\.com/i.test(url) || /\/courses\/\d+/i.test(url);
}

export function detectPageType(url: string): PageSurfaceType {
  if (/^https:\/\/docs\.google\.com\/document\//i.test(url)) {
    return 'docs';
  }

  if (isCanvasUrl(url)) {
    return 'canvas';
  }

  return 'generic';
}

export function detectAssistantMode(url: string): SidebarMode {
  return detectPageType(url) === 'canvas' ? 'canvas' : 'general';
}

export function getLaunchSupport(url: string): LaunchSupport {
  if (!url) {
    return {
      isSupported: false,
      pageType: 'generic',
      assistantMode: 'unsupported',
      statusLabel: 'Unavailable',
      message: UNSUPPORTED_PAGE_MESSAGE
    };
  }

  try {
    const parsed = new URL(url);
    const isRestrictedBrowserPage =
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.hostname === 'chromewebstore.google.com' ||
      (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));

    if (isRestrictedBrowserPage) {
      return {
        isSupported: false,
        pageType: 'generic',
        assistantMode: 'unsupported',
        statusLabel: 'Unavailable',
        message: UNSUPPORTED_PAGE_MESSAGE
      };
    }

    const pageType = detectPageType(url);
    if (pageType === 'canvas') {
      return {
        isSupported: true,
        pageType,
        assistantMode: 'canvas',
        statusLabel: 'Screen Mode',
        message: 'Screen-aware analysis is available on this page.'
      };
    }

    return {
      isSupported: true,
        pageType,
        assistantMode: 'general',
        statusLabel: 'Screen Mode',
        message: 'Screen-aware analysis is available on this page.'
      };
  } catch {
    return {
      isSupported: false,
      pageType: 'generic',
      assistantMode: 'unsupported',
      statusLabel: 'Unavailable',
      message: UNSUPPORTED_PAGE_MESSAGE
    };
  }
}
