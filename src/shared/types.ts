export type ProviderMode = 'local' | 'google' | 'backend';

export type WorkflowIntent =
  | 'what_should_i_do'
  | 'quick_summary'
  | 'answer'
  | 'send_to_doc'
  | 'extract_tasks'
  | 'page_understanding'
  | 'autofill_suggestions';

export type WorkspaceTargetView = 'home' | 'tasks' | 'google' | 'history';

export type WorkspaceSurface = 'sidepanel' | 'page' | 'none';

export type OpenWorkspaceResult = {
  ok: boolean;
  surface: WorkspaceSurface;
  targetView: WorkspaceTargetView;
  message: string;
  fallbackUsed: boolean;
};

export type SiteKind = 'form' | 'email' | 'article' | 'dashboard' | 'error' | 'document' | 'generic';

export type FormFieldInfo = {
  id: string;
  label: string;
  name: string;
  type: string;
  placeholder: string;
};

export type PageContext = {
  title: string;
  url: string;
  selectedText: string;
  excerpt: string;
  siteKind: SiteKind;
  canInsertText: boolean;
  formFields: FormFieldInfo[];
};

export type ScreenshotArtifact = {
  id: string;
  dataUrl: string;
  capturedAt: string;
  sourceTitle: string;
  sourceUrl: string;
  ocrText: string;
  ocrStatus: 'placeholder';
};

export type SuggestedTask = {
  title: string;
  notes: string;
  source: 'page' | 'screenshot' | 'manual';
};

export type AutofillSuggestion = {
  fieldId: string;
  fieldLabel: string;
  value: string;
  reason: string;
};

export type AIWorkflowInput = {
  intent: WorkflowIntent;
  pageContext: PageContext;
  screenshot?: ScreenshotArtifact | null;
  userPrompt?: string;
};

export type AIWorkflowResult = {
  title: string;
  summary: string;
  bullets: string[];
  suggestedTasks?: SuggestedTask[];
  suggestedDocTitle?: string;
  docContent?: string;
  autofillSuggestions?: AutofillSuggestion[];
  classifiedIntent?: WorkflowIntent;
  providerNotes?: string[];
};

export interface AIProvider {
  summarize(input: AIWorkflowInput): Promise<AIWorkflowResult>;
  answer(input: AIWorkflowInput): Promise<AIWorkflowResult>;
  extractTasks(input: AIWorkflowInput): Promise<AIWorkflowResult>;
  classifyIntent(input: AIWorkflowInput): Promise<{ intent: WorkflowIntent; confidence: number; reason: string }>;
}

export type GoogleConnectionState = {
  connected: boolean;
  email: string | null;
  lastConnectedAt: string | null;
  scopes: string[];
};

export type DocDraft = {
  id: string;
  title: string;
  content: string;
  sourceUrl: string;
  createdAt: string;
  destination: 'local_queue' | 'google_docs';
  googleDocUrl?: string;
};

export type Task = {
  id: string;
  title: string;
  notes: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRun = {
  id: string;
  createdAt: string;
  intent: WorkflowIntent;
  providerMode: ProviderMode;
  source: 'page' | 'screenshot';
  pageTitle: string;
  pageUrl: string;
  result: AIWorkflowResult;
};

export type CommandPaletteState = {
  selectedIntent: WorkflowIntent;
  selectedMode: ProviderMode;
};

export type ExtensionSettings = {
  providerMode: ProviderMode;
  defaultIntent: WorkflowIntent;
  googleClientConfigured: boolean;
  backendModeEnabled: boolean;
};

export type AppState = {
  settings: ExtensionSettings;
  google: GoogleConnectionState;
  tasks: Task[];
  docsQueue: DocDraft[];
  screenshots: ScreenshotArtifact[];
  workflowHistory: WorkflowRun[];
  workspace: {
    lastView: WorkspaceTargetView;
  };
};

export type RunWorkflowRequest = {
  intent: WorkflowIntent;
  useScreenshot: boolean;
  userPrompt?: string;
};

export type RunWorkflowResponse = {
  ok: boolean;
  message: string;
  run?: WorkflowRun;
  result?: AIWorkflowResult;
};

export type GoogleActionResult = {
  ok: boolean;
  message: string;
  url?: string;
};
