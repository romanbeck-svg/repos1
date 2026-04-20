import type { OverlayUpdateResponse, WorkflowType, WorkflowState } from '../../shared/types';

export interface WorkflowOverlayViewModel {
  workflowType: WorkflowType;
  sourceTitle: string;
  sourceUrl?: string;
  answer: string;
  notes: string[];
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
