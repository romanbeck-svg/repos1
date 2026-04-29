import type { OverlayUpdateResponse, WorkflowType, WorkflowState } from '../../shared/types';

export interface OverlayQuestionViewModel {
  id: string;
  question: string;
  answer: string;
  notes: string[];
  sourceAnchor: string;
}

export interface WorkflowOverlayViewModel {
  workflowType: WorkflowType;
  sourceTitle: string;
  sourceUrl?: string;
  displayState: 'answer' | 'fallback';
  statusLabel: string;
  statusTone: 'success' | 'warning' | 'danger' | 'accent';
  questions: OverlayQuestionViewModel[];
  fallbackTitle: string;
  fallbackMessage: string;
  fallbackNotes: string[];
  isTestOverlay: boolean;
  updatedAt: string;
}

export interface WorkflowOverlayProps {
  model: WorkflowOverlayViewModel;
  onClose: () => void;
}

export interface OverlayControllerState {
  workflowState: WorkflowState | null;
}

export interface OverlayRootStatus {
  hostState: 'created' | 'reused';
}

export interface OverlayControllerResult extends OverlayUpdateResponse {
  hostState?: OverlayRootStatus['hostState'];
}
