export interface LastAiRequestStatus {
  ok: boolean;
  route: string;
  provider: string;
  model?: string;
  status?: number;
  message: string;
  at: string;
}

let lastExtensionRequestAt: string | undefined;
let lastAiRequest: LastAiRequestStatus | undefined;

export function markExtensionRequest(origin?: string) {
  if (!origin?.startsWith('chrome-extension://')) {
    return;
  }

  lastExtensionRequestAt = new Date().toISOString();
}

export function recordAiRequest(status: Omit<LastAiRequestStatus, 'at'>) {
  lastAiRequest = {
    ...status,
    at: new Date().toISOString()
  };
}

export function getRuntimeStatus() {
  const connectedWindowMs = 2 * 60 * 1000;
  const lastExtensionRequestMs = lastExtensionRequestAt ? Date.parse(lastExtensionRequestAt) : 0;

  return {
    extensionConnected: Boolean(lastExtensionRequestMs && Date.now() - lastExtensionRequestMs <= connectedWindowMs),
    lastExtensionRequestAt,
    lastAiRequest
  };
}
