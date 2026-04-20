import type {
  AppState,
  DocDraft,
  ExtensionSettings,
  GoogleConnectionState,
  ProviderMode,
  ScreenshotArtifact,
  SuggestedTask,
  Task,
  WorkflowIntent,
  WorkflowRun,
  WorkspaceTargetView
} from './types';

const STORAGE_KEY = 'walt-extension-state';

const nowIso = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

const defaultGoogleState: GoogleConnectionState = {
  connected: false,
  email: null,
  lastConnectedAt: null,
  scopes: []
};

const defaultSettings: ExtensionSettings = {
  providerMode: 'local',
  defaultIntent: 'what_should_i_do',
  googleClientConfigured: false,
  backendModeEnabled: false
};

const defaultState: AppState = {
  settings: defaultSettings,
  google: defaultGoogleState,
  tasks: [],
  docsQueue: [],
  screenshots: [],
  workflowHistory: [],
  workspace: {
    lastView: 'home'
  }
};

function normalizeProviderMode(mode?: string): ProviderMode {
  return mode === 'google' || mode === 'backend' ? mode : 'local';
}

function normalizeIntent(intent?: string): WorkflowIntent {
  const allowed: WorkflowIntent[] = [
    'what_should_i_do',
    'quick_summary',
    'answer',
    'send_to_doc',
    'extract_tasks',
    'page_understanding',
    'autofill_suggestions'
  ];
  return allowed.includes(intent as WorkflowIntent) ? (intent as WorkflowIntent) : 'what_should_i_do';
}

function normalizeView(view?: string): WorkspaceTargetView {
  return view === 'tasks' || view === 'google' || view === 'history' ? view : 'home';
}

function normalizeTask(task: Partial<Task>): Task {
  return {
    id: task.id ?? createId('task'),
    title: String(task.title ?? 'Untitled task').trim(),
    notes: String(task.notes ?? '').trim(),
    completed: Boolean(task.completed),
    createdAt: task.createdAt ?? nowIso(),
    updatedAt: task.updatedAt ?? nowIso()
  };
}

function normalizeDocDraft(draft: Partial<DocDraft>): DocDraft {
  return {
    id: draft.id ?? createId('doc'),
    title: String(draft.title ?? 'Untitled draft').trim(),
    content: String(draft.content ?? '').trim(),
    sourceUrl: String(draft.sourceUrl ?? ''),
    createdAt: draft.createdAt ?? nowIso(),
    destination: draft.destination === 'google_docs' ? 'google_docs' : 'local_queue',
    googleDocUrl: draft.googleDocUrl
  };
}

function normalizeScreenshot(screenshot: Partial<ScreenshotArtifact>): ScreenshotArtifact {
  return {
    id: screenshot.id ?? createId('shot'),
    dataUrl: String(screenshot.dataUrl ?? ''),
    capturedAt: screenshot.capturedAt ?? nowIso(),
    sourceTitle: String(screenshot.sourceTitle ?? 'Current page'),
    sourceUrl: String(screenshot.sourceUrl ?? ''),
    ocrText: String(screenshot.ocrText ?? ''),
    ocrStatus: 'placeholder'
  };
}

function normalizeRun(run: Partial<WorkflowRun>): WorkflowRun | null {
  if (!run.result || !run.intent || !run.providerMode) {
    return null;
  }

  return {
    id: run.id ?? createId('run'),
    createdAt: run.createdAt ?? nowIso(),
    intent: normalizeIntent(run.intent),
    providerMode: normalizeProviderMode(run.providerMode),
    source: run.source === 'screenshot' ? 'screenshot' : 'page',
    pageTitle: String(run.pageTitle ?? 'Current page'),
    pageUrl: String(run.pageUrl ?? ''),
    result: run.result
  };
}

function sortTasks(tasks: Task[]) {
  return [...tasks].sort((left, right) => {
    if (left.completed !== right.completed) {
      return left.completed ? 1 : -1;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function normalizeState(input?: Record<string, unknown>): AppState {
  const raw = input as Partial<AppState> | undefined;
  const legacyTasks = Array.isArray((raw as { tasks?: unknown[] } | undefined)?.tasks)
    ? ((raw as { tasks?: unknown[] }).tasks ?? [])
    : [];

  return {
    settings: {
      providerMode: normalizeProviderMode(raw?.settings?.providerMode),
      defaultIntent: normalizeIntent(raw?.settings?.defaultIntent),
      googleClientConfigured: Boolean(raw?.settings?.googleClientConfigured),
      backendModeEnabled: Boolean(raw?.settings?.backendModeEnabled)
    },
    google: {
      connected: Boolean(raw?.google?.connected),
      email: raw?.google?.email ?? null,
      lastConnectedAt: raw?.google?.lastConnectedAt ?? null,
      scopes: Array.isArray(raw?.google?.scopes) ? raw!.google!.scopes : []
    },
    tasks: sortTasks(legacyTasks.map((task) => normalizeTask(task as Partial<Task>))),
    docsQueue: Array.isArray(raw?.docsQueue) ? raw.docsQueue.map((draft) => normalizeDocDraft(draft)) : [],
    screenshots: Array.isArray(raw?.screenshots) ? raw.screenshots.map((shot) => normalizeScreenshot(shot)) : [],
    workflowHistory: Array.isArray(raw?.workflowHistory)
      ? raw.workflowHistory.map((run) => normalizeRun(run)).filter(Boolean) as WorkflowRun[]
      : [],
    workspace: {
      lastView: normalizeView(raw?.workspace?.lastView)
    }
  };
}

async function persist(state: AppState): Promise<AppState> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

export async function getState(): Promise<AppState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeState(result[STORAGE_KEY] as Record<string, unknown> | undefined);
}

export async function updateProviderMode(providerMode: ProviderMode) {
  const state = await getState();
  return persist({
    ...state,
    settings: {
      ...state.settings,
      providerMode
    }
  });
}

export async function updateDefaultIntent(defaultIntent: WorkflowIntent) {
  const state = await getState();
  return persist({
    ...state,
    settings: {
      ...state.settings,
      defaultIntent
    }
  });
}

export async function updateGoogleClientConfigured(googleClientConfigured: boolean) {
  const state = await getState();
  return persist({
    ...state,
    settings: {
      ...state.settings,
      googleClientConfigured
    }
  });
}

export async function updateWorkspaceTargetView(lastView: WorkspaceTargetView) {
  const state = await getState();
  return persist({
    ...state,
    workspace: {
      lastView
    }
  });
}

export async function saveWorkflowRun(run: Omit<WorkflowRun, 'id' | 'createdAt'>) {
  const state = await getState();
  const nextRun: WorkflowRun = {
    ...run,
    id: createId('run'),
    createdAt: nowIso()
  };
  await persist({
    ...state,
    workflowHistory: [nextRun, ...state.workflowHistory].slice(0, 40)
  });
  return nextRun;
}

export async function saveScreenshot(input: Omit<ScreenshotArtifact, 'id' | 'capturedAt'>) {
  const state = await getState();
  const screenshot = normalizeScreenshot(input);
  await persist({
    ...state,
    screenshots: [screenshot, ...state.screenshots].slice(0, 20)
  });
  return screenshot;
}

export async function createTask(input: { title: string; notes?: string }) {
  const state = await getState();
  const task = normalizeTask({
    title: input.title,
    notes: input.notes ?? '',
    completed: false
  });
  await persist({
    ...state,
    tasks: sortTasks([task, ...state.tasks])
  });
  return task;
}

export async function addSuggestedTasks(tasks: SuggestedTask[]) {
  const state = await getState();
  const created = tasks
    .filter((task) => task.title.trim())
    .map((task) =>
      normalizeTask({
        title: task.title,
        notes: task.notes,
        completed: false
      })
    );

  if (!created.length) {
    return [];
  }

  await persist({
    ...state,
    tasks: sortTasks([...created, ...state.tasks])
  });

  return created;
}

export async function toggleTask(taskId: string) {
  const state = await getState();
  return persist({
    ...state,
    tasks: sortTasks(
      state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              completed: !task.completed,
              updatedAt: nowIso()
            }
          : task
      )
    )
  });
}

export async function deleteTask(taskId: string) {
  const state = await getState();
  return persist({
    ...state,
    tasks: state.tasks.filter((task) => task.id !== taskId)
  });
}

export async function queueDocDraft(input: Omit<DocDraft, 'id' | 'createdAt'>) {
  const state = await getState();
  const draft = normalizeDocDraft(input);
  await persist({
    ...state,
    docsQueue: [draft, ...state.docsQueue].slice(0, 30)
  });
  return draft;
}

export async function markDocDraftAsGoogle(draftId: string, googleDocUrl: string) {
  const state = await getState();
  return persist({
    ...state,
    docsQueue: state.docsQueue.map((draft) =>
      draft.id === draftId
        ? {
            ...draft,
            destination: 'google_docs',
            googleDocUrl
          }
        : draft
    )
  });
}

export async function updateGoogleConnection(connection: GoogleConnectionState) {
  const state = await getState();
  return persist({
    ...state,
    google: connection,
    settings: {
      ...state.settings,
      providerMode: connection.connected && state.settings.providerMode === 'backend' ? 'backend' : state.settings.providerMode
    }
  });
}

export function getLatestRun(state: AppState) {
  return state.workflowHistory[0] ?? null;
}

export function getTaskSummary(state: AppState) {
  const active = state.tasks.filter((task) => !task.completed);
  const done = state.tasks.filter((task) => task.completed);
  return {
    active,
    done
  };
}
