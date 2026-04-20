import { createRuntimeMessageError, logTrace, logTraceError } from './requestDiagnostics';

export function sendRuntimeMessage<TResponse>(message: unknown): Promise<TResponse> {
  const requestId =
    message && typeof message === 'object' && 'requestId' in message && typeof (message as { requestId?: unknown }).requestId === 'string'
      ? ((message as { requestId: string }).requestId ?? '')
      : undefined;
  const type =
    message && typeof message === 'object' && 'type' in message && typeof (message as { type?: unknown }).type === 'string'
      ? (message as { type: string }).type
      : 'unknown';

  logTrace('msg:send', {
    context: 'ui',
    type,
    requestId
  });

  return chrome.runtime.sendMessage(message).catch((error) => {
    const tracedError = createRuntimeMessageError(
      {
        requestId,
        context: 'ui',
        source: type,
        method: 'POST'
      },
      error
    );
    logTraceError('ui:error', {
      type,
      requestId,
      detail: tracedError.detail,
      message: tracedError.message
    });
    throw tracedError;
  }) as Promise<TResponse>;
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function downloadBase64File(fileName: string, mimeType: string, base64: string) {
  const byteCharacters = atob(base64);
  const bytes = new Uint8Array(byteCharacters.length);
  for (let index = 0; index < byteCharacters.length; index += 1) {
    bytes[index] = byteCharacters.charCodeAt(index);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
