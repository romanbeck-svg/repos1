import type {
  CanvyTaskKind,
  PageAnalysisResult,
  PageContextSummary,
  PromptExtraction,
  ScanPagePayload,
  SidebarMode,
  TaskClassification,
  WorkflowActionCard,
  WorkflowActionId,
  WorkflowClassification,
  WorkflowOutputShell,
  WorkflowRoute,
  WorkflowState,
  WorkflowType
} from '../types';

export type {
  WorkflowActionCard,
  WorkflowActionId,
  WorkflowClassification,
  WorkflowOutputShell,
  PromptExtraction,
  WorkflowRoute,
  WorkflowState,
  WorkflowType
};

export interface WorkflowClassificationInput {
  assistantMode: SidebarMode;
  currentTitle: string;
  currentUrl: string;
  pageContext?: PageContextSummary | null;
  latestScan?: ScanPagePayload;
  taskClassification?: TaskClassification;
}

export interface PromptExtractionInput extends WorkflowClassificationInput {
  workflowClassification?: WorkflowClassification | null;
}

export interface BuildWorkflowOutputInput {
  workflowType: WorkflowType;
  action: WorkflowActionCard;
  workflowClassification: WorkflowClassification;
  promptExtraction: PromptExtraction | null;
  taskClassification?: TaskClassification;
  workflowRoute?: WorkflowRoute;
  latestScan?: ScanPagePayload;
  pageContext?: PageContextSummary | null;
  analysis?: PageAnalysisResult;
  extraInstructions?: string;
}

export interface BuildWorkflowStateInput {
  assistantMode: SidebarMode;
  currentTitle: string;
  currentUrl: string;
  taskClassification: TaskClassification;
  workflowRoute: WorkflowRoute;
  latestScan?: ScanPagePayload;
  pageContext?: PageContextSummary | null;
  analysis?: PageAnalysisResult;
  previous?: WorkflowState;
}

export interface ApplyWorkflowActionInput {
  workflowState: WorkflowState;
  taskClassification?: TaskClassification;
  workflowRoute?: WorkflowRoute;
  latestScan?: ScanPagePayload;
  pageContext?: PageContextSummary | null;
  analysis?: PageAnalysisResult;
  promptExtraction?: PromptExtraction | null;
  actionId?: WorkflowActionId;
  task?: CanvyTaskKind;
  extraInstructions: string;
}
