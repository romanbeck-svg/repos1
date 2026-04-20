import { addSuggestedTasks, createTask, getLatestRun, getState, markDocDraftAsGoogle, queueDocDraft, saveScreenshot, saveWorkflowRun, updateGoogleConnection, updateProviderMode, updateWorkspaceTargetView } from '../shared/storage';
import { buildAutofillSuggestions, buildPageUnderstanding, getProvider } from '../shared/providers';
import { connectGoogle, createCalendarEventFromTask, createDocFromDraft, createGmailDraft, disconnectGoogle } from '../shared/google';
import type { AIWorkflowInput, AIWorkflowResult, OpenWorkspaceResult, PageContext, ProviderMode, RunWorkflowResponse, WorkflowIntent, WorkspaceTargetView } from '../shared/types';

const WORKSPACE_TARGET_KEY = 'walt-workspace-target-view';

function normalizeWorkspaceTargetView(targetView?: string): WorkspaceTargetView {
  return targetView === 'tasks' || targetView === 'google' || targetView === 'history' ? targetView : 'home';
}

async function initializeSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    await chrome.sidePanel.setOptions({
      path: 'sidepanel.html',
      enabled: true
    });
  } catch (error) {
    console.warn('Failed to initialize side panel behavior.', error);
  }
}

async function getActiveTab() {
  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedTab) {
    return focusedTab;
  }
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentTab;
}

async function sendToTab(tabId: number, payload: unknown) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    return null;
  }
}

async function setWorkspaceTargetView(targetView: WorkspaceTargetView) {
  await chrome.storage.local.set({ [WORKSPACE_TARGET_KEY]: targetView });
  await updateWorkspaceTargetView(targetView);
}

async function getPageContextForActiveTab(): Promise<{ tab: chrome.tabs.Tab; pageContext: PageContext } | null> {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return null;
  }

  const response = await sendToTab(tab.id, { type: 'GET_PAGE_CONTEXT' });
  if (!response) {
    return {
      tab,
      pageContext: {
        title: tab.title ?? 'Current page',
        url: tab.url ?? '',
        selectedText: '',
        excerpt: '',
        siteKind: 'generic',
        canInsertText: false,
        formFields: []
      }
    };
  }

  return { tab, pageContext: response as PageContext };
}

async function showWaltResult(tabId: number, title: string, message: string, error = false) {
  await sendToTab(tabId, {
    type: 'SHOW_WALT_RESULT',
    title,
    message,
    error
  });
}

async function openTaskWorkspace(targetView: WorkspaceTargetView = 'home'): Promise<OpenWorkspaceResult> {
  const normalizedTargetView = normalizeWorkspaceTargetView(targetView);
  const tab = await getActiveTab();

  if (!tab?.id || !tab.windowId) {
    return {
      ok: false,
      surface: 'none',
      targetView: normalizedTargetView,
      message: 'Could not open the Walt side panel from this tab.',
      fallbackUsed: false
    };
  }

  try {
    await setWorkspaceTargetView(normalizedTargetView);
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
      targetView: normalizedTargetView,
      message: `Opened Walt ${normalizedTargetView === 'home' ? 'dashboard' : normalizedTargetView} in the side panel.`,
      fallbackUsed: false
    };
  } catch {
    return {
      ok: false,
      surface: 'none',
      targetView: normalizedTargetView,
      message: 'Could not open the Walt side panel. Try again from a normal website tab.',
      fallbackUsed: false
    };
  }
}

function createOcrPlaceholder(pageContext: PageContext) {
  return [
    `Title: ${pageContext.title}`,
    `URL: ${pageContext.url}`,
    `Site type: ${pageContext.siteKind}`,
    pageContext.selectedText ? `Selected text:\n${pageContext.selectedText}` : '',
    pageContext.excerpt ? `Visible content snapshot:\n${pageContext.excerpt}` : '',
    pageContext.formFields.length
      ? `Form fields:\n${pageContext.formFields.map((field) => `${field.label || field.name || field.placeholder || 'Unnamed'} (${field.type})`).join('\n')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 3200);
}

async function routeIntent(input: AIWorkflowInput, providerMode: ProviderMode): Promise<AIWorkflowResult> {
  const provider = getProvider(providerMode);
  const classified = await provider.classifyIntent(input);
  const resolvedInput = {
    ...input,
    intent: classified.intent
  };

  if (classified.intent === 'quick_summary') {
    const result = await provider.summarize(resolvedInput);
    return { ...result, classifiedIntent: classified.intent };
  }

  if (classified.intent === 'extract_tasks') {
    const result = await provider.extractTasks(resolvedInput);
    return { ...result, classifiedIntent: classified.intent };
  }

  if (classified.intent === 'page_understanding') {
    const result = await buildPageUnderstanding(resolvedInput);
    return { ...result, classifiedIntent: classified.intent };
  }

  if (classified.intent === 'autofill_suggestions') {
    const result = await buildAutofillSuggestions(resolvedInput);
    return { ...result, classifiedIntent: classified.intent };
  }

  const answered = await provider.answer(resolvedInput);

  if (classified.intent === 'send_to_doc') {
    return {
      ...answered,
      classifiedIntent: classified.intent,
      suggestedDocTitle: `${resolvedInput.pageContext.title} notes`,
      docContent: [answered.summary, ...answered.bullets].join('\n\n')
    };
  }

  return {
    ...answered,
    classifiedIntent: classified.intent
  };
}

async function runWorkflow(message: {
  intent: WorkflowIntent;
  useScreenshot: boolean;
  userPrompt?: string;
}): Promise<RunWorkflowResponse> {
  const context = await getPageContextForActiveTab();
  if (!context?.tab.id) {
    return { ok: false, message: 'Open a normal tab before running Walt workflows.' };
  }

  const state = await getState();
  await showWaltResult(
    context.tab.id,
    message.useScreenshot ? 'Walt screenshot intake' : 'Walt workflow',
    message.useScreenshot ? 'Capturing the current page and routing it through Walt...' : 'Reading the current page and preparing a response...'
  );
  let screenshot = null;
  if (message.useScreenshot && context.tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const dataUrl = await chrome.tabs.captureVisibleTab(context.tab.windowId, { format: 'png' });
    screenshot = await saveScreenshot({
      dataUrl,
      sourceTitle: context.pageContext.title,
      sourceUrl: context.pageContext.url,
      ocrText: createOcrPlaceholder(context.pageContext),
      ocrStatus: 'placeholder'
    });
  }

  const input: AIWorkflowInput = {
    intent: message.intent,
    pageContext: context.pageContext,
    screenshot,
    userPrompt: message.userPrompt
  };

  const result = await routeIntent(input, state.settings.providerMode);

  if (result.suggestedTasks?.length) {
    await addSuggestedTasks(result.suggestedTasks);
  }

  let docDraftId = '';
  if (result.docContent) {
    const draft = await queueDocDraft({
      title: result.suggestedDocTitle ?? `${context.pageContext.title} notes`,
      content: result.docContent,
      sourceUrl: context.pageContext.url,
      destination: 'local_queue'
    });
    docDraftId = draft.id;
  }

  const run = await saveWorkflowRun({
    intent: result.classifiedIntent ?? message.intent,
    providerMode: state.settings.providerMode,
    source: screenshot ? 'screenshot' : 'page',
    pageTitle: context.pageContext.title,
    pageUrl: context.pageContext.url,
    result
  });

  if (result.autofillSuggestions?.length) {
    await sendToTab(context.tab.id, {
      type: 'STORE_AUTOFILL_SUGGESTIONS',
      suggestions: result.autofillSuggestions
    });
  }

  const summaryLines = [result.summary, ...result.bullets].filter(Boolean).slice(0, 5);
  const note = docDraftId ? 'A doc draft was added to Walt.' : '';
  await showWaltResult(
    context.tab.id,
    result.title,
    [...summaryLines, note].filter(Boolean).join('\n\n')
  );

  return {
    ok: true,
    message: result.summary,
    run,
    result
  };
}

async function handleGoogleConnect() {
  try {
    const connection = await connectGoogle();
    await updateGoogleConnection(connection);
    return {
      ok: true,
      message: connection.email ? `Connected Google account ${connection.email}.` : 'Connected Google account.'
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Google connection failed.'
    };
  }
}

async function handleGoogleDisconnect() {
  const state = await getState();
  const next = await disconnectGoogle(state.google);
  await updateGoogleConnection(next);
  return {
    ok: true,
    message: 'Disconnected Google for Walt.'
  };
}

async function handleCreateDocFromDraft(draftId: string) {
  const state = await getState();
  const draft = state.docsQueue.find((entry) => entry.id === draftId);
  if (!draft) {
    return { ok: false, message: 'Could not find that Walt draft.' };
  }

  try {
    const result = await createDocFromDraft(draft);
    if (result.ok && result.url) {
      await markDocDraftAsGoogle(draftId, result.url);
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not create the Google Doc.'
    };
  }
}

async function handleCreateCalendarEvent(taskId: string) {
  const state = await getState();
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    return { ok: false, message: 'Could not find that Walt task.' };
  }

  try {
    return await createCalendarEventFromTask(task);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not create the Google Calendar event.'
    };
  }
}

async function handleCreateGmailDraftFromLatestRun() {
  const state = await getState();
  const latestRun = getLatestRun(state);
  if (!latestRun) {
    return { ok: false, message: 'Run a Walt workflow first so there is something to draft.' };
  }

  try {
    return await createGmailDraft(
      `Walt draft: ${latestRun.result.title}`,
      [latestRun.result.summary, ...latestRun.result.bullets].join('\n\n')
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not create the Gmail draft.'
    };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSidePanelBehavior();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OPEN_TASK_WORKSPACE') {
    void openTaskWorkspace(normalizeWorkspaceTargetView(message.targetView)).then(sendResponse);
    return true;
  }

  if (message?.type === 'RUN_WORKFLOW') {
    void runWorkflow({
      intent: message.intent as WorkflowIntent,
      useScreenshot: Boolean(message.useScreenshot),
      userPrompt: typeof message.userPrompt === 'string' ? message.userPrompt : ''
    }).then(sendResponse);
    return true;
  }

  if (message?.type === 'CONNECT_GOOGLE') {
    void handleGoogleConnect().then(sendResponse);
    return true;
  }

  if (message?.type === 'DISCONNECT_GOOGLE') {
    void handleGoogleDisconnect().then(sendResponse);
    return true;
  }

  if (message?.type === 'CREATE_GOOGLE_DOC_FROM_DRAFT') {
    void handleCreateDocFromDraft(String(message.draftId ?? '')).then(sendResponse);
    return true;
  }

  if (message?.type === 'CREATE_CALENDAR_EVENT_FROM_TASK') {
    void handleCreateCalendarEvent(String(message.taskId ?? '')).then(sendResponse);
    return true;
  }

  if (message?.type === 'CREATE_GMAIL_DRAFT_FROM_LATEST_RUN') {
    void handleCreateGmailDraftFromLatestRun().then(sendResponse);
    return true;
  }

  if (message?.type === 'SET_PROVIDER_MODE') {
    void updateProviderMode(message.providerMode as ProviderMode).then(() =>
      sendResponse({ ok: true, message: `Walt switched to ${message.providerMode} mode.` })
    );
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-sidepanel') {
    await openTaskWorkspace('home');
    return;
  }

  if (command === 'open-task-list-sidepanel') {
    await openTaskWorkspace('tasks');
    return;
  }

  if (command === 'solve-screenshot') {
    await runWorkflow({
      intent: 'what_should_i_do',
      useScreenshot: true
    });
  }
});
