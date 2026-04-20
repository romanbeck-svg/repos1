import type {
  GoogleActionResult,
  OpenWorkspaceResult,
  PageContext,
  ProviderMode,
  RunWorkflowResponse,
  WorkflowIntent,
  WorkspaceTargetView
} from './types';

const WORKSPACE_TARGET_KEY = 'walt-workspace-target-view';

const emptyContext: PageContext = {
  title: 'No active tab',
  url: '',
  selectedText: '',
  excerpt: '',
  siteKind: 'generic',
  canInsertText: false,
  formFields: []
};

export async function getActiveTab() {
  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedTab) {
    return focusedTab;
  }
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentTab;
}

export async function getPageContext(): Promise<PageContext> {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return emptyContext;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' });
    return response as PageContext;
  } catch {
    return {
      ...emptyContext,
      title: tab.title ?? 'Current page',
      url: tab.url ?? ''
    };
  }
}

export async function runWorkflow(input: {
  intent: WorkflowIntent;
  useScreenshot: boolean;
  userPrompt?: string;
}) {
  return (await chrome.runtime.sendMessage({
    type: 'RUN_WORKFLOW',
    ...input
  })) as RunWorkflowResponse;
}

export async function connectGoogleAccount() {
  return (await chrome.runtime.sendMessage({
    type: 'CONNECT_GOOGLE'
  })) as { ok: boolean; message: string };
}

export async function disconnectGoogleAccount() {
  return (await chrome.runtime.sendMessage({
    type: 'DISCONNECT_GOOGLE'
  })) as { ok: boolean; message: string };
}

export async function createGoogleDocFromDraft(draftId: string) {
  return (await chrome.runtime.sendMessage({
    type: 'CREATE_GOOGLE_DOC_FROM_DRAFT',
    draftId
  })) as GoogleActionResult;
}

export async function createCalendarEventForTask(taskId: string) {
  return (await chrome.runtime.sendMessage({
    type: 'CREATE_CALENDAR_EVENT_FROM_TASK',
    taskId
  })) as GoogleActionResult;
}

export async function createGmailDraftFromLatestRun() {
  return (await chrome.runtime.sendMessage({
    type: 'CREATE_GMAIL_DRAFT_FROM_LATEST_RUN'
  })) as GoogleActionResult;
}

export async function showPageOverlay(message: string, title = 'Walt') {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return false;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_WALT_RESULT',
      title,
      message
    });
    return true;
  } catch {
    return false;
  }
}

export async function applyAutofillSuggestions() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return false;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'APPLY_LAST_AUTOFILL_SUGGESTIONS'
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

export async function openTaskWorkspace(targetView: WorkspaceTargetView = 'home') {
  const tab = await getActiveTab();

  if (tab?.id && chrome.sidePanel?.open) {
    try {
      await chrome.storage.local.set({ [WORKSPACE_TARGET_KEY]: targetView });
      await chrome.sidePanel.setOptions({
        path: 'sidepanel.html',
        enabled: true
      });
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel.html',
        enabled: true
      });
      await chrome.sidePanel.open({ tabId: tab.id });

      return {
        ok: true,
        surface: 'sidepanel',
        targetView,
        message: `Opened Walt ${targetView === 'home' ? 'dashboard' : targetView} in the side panel.`,
        fallbackUsed: false
      } satisfies OpenWorkspaceResult;
    } catch {
      // Fall through to background open path.
    }
  }

  const response = (await chrome.runtime.sendMessage({
    type: 'OPEN_TASK_WORKSPACE',
    targetView
  })) as OpenWorkspaceResult | undefined;

  return response ?? {
    ok: false,
    surface: 'none',
    targetView,
    message: 'Could not open Walt.',
    fallbackUsed: false
  };
}

export async function updateProviderMode(providerMode: ProviderMode) {
  return (await chrome.runtime.sendMessage({
    type: 'SET_PROVIDER_MODE',
    providerMode
  })) as { ok: boolean; message: string };
}
