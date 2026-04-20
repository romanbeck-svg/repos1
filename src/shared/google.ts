import type { DocDraft, GoogleActionResult, GoogleConnectionState, Task } from './types';

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file'
];

async function fetchJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Google API returned ${response.status}`);
  }

  return (await response.json()) as T;
}

function requireToken(token: string | undefined) {
  if (!token) {
    throw new Error('Google OAuth did not return an access token. Check the manifest oauth2 client ID and granted scopes.');
  }
  return token;
}

function getManifestClientId() {
  const manifest = chrome.runtime.getManifest();
  return manifest.oauth2?.client_id ?? '';
}

function assertGoogleOauthConfigured() {
  const clientId = getManifestClientId();
  if (!clientId || clientId.includes('YOUR_GOOGLE_OAUTH_CLIENT_ID')) {
    throw new Error('Google OAuth is not configured yet. Replace the placeholder oauth2 client ID in public/manifest.json, use a Chrome Extension OAuth client in Google Cloud, then reload Walt.');
  }
}

export async function connectGoogle(): Promise<GoogleConnectionState> {
  assertGoogleOauthConfigured();
  const token = requireToken((await chrome.identity.getAuthToken({ interactive: true })).token);
  const profile = await fetchJson<{ email?: string }>('https://www.googleapis.com/oauth2/v2/userinfo', token);

  return {
    connected: true,
    email: profile.email ?? null,
    lastConnectedAt: new Date().toISOString(),
    scopes: GOOGLE_SCOPES
  };
}

export async function disconnectGoogle(current: GoogleConnectionState): Promise<GoogleConnectionState> {
  if (current.connected) {
    try {
      await chrome.identity.clearAllCachedAuthTokens();
    } catch {
      // ignore cache clear failures
    }
  }

  return {
    connected: false,
    email: null,
    lastConnectedAt: null,
    scopes: []
  };
}

async function getToken() {
  assertGoogleOauthConfigured();
  return requireToken((await chrome.identity.getAuthToken({ interactive: true })).token);
}

export async function createDocFromDraft(draft: DocDraft): Promise<GoogleActionResult> {
  const token = await getToken();
  const doc = await fetchJson<{ documentId: string }>('https://docs.googleapis.com/v1/documents', token, {
    method: 'POST',
    body: JSON.stringify({ title: draft.title })
  });

  await fetchJson(
    `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: draft.content
            }
          }
        ]
      })
    }
  );

  return {
    ok: true,
    message: 'Created a Google Doc from the queued Walt draft.',
    url: `https://docs.google.com/document/d/${doc.documentId}/edit`
  };
}

export async function createCalendarEventFromTask(task: Task): Promise<GoogleActionResult> {
  const token = await getToken();
  const startDate = new Date();
  startDate.setHours(startDate.getHours() + 1);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

  const event = await fetchJson<{ htmlLink?: string }>('https://www.googleapis.com/calendar/v3/calendars/primary/events', token, {
    method: 'POST',
    body: JSON.stringify({
      summary: task.title,
      description: task.notes,
      start: { dateTime: startDate.toISOString() },
      end: { dateTime: endDate.toISOString() }
    })
  });

  return {
    ok: true,
    message: 'Created a Google Calendar event from this Walt task.',
    url: event.htmlLink
  };
}

export async function createGmailDraft(subject: string, body: string): Promise<GoogleActionResult> {
  const token = await getToken();
  const mime = `To: \r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  const encoded = btoa(unescape(encodeURIComponent(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/drafts', token, {
    method: 'POST',
    body: JSON.stringify({
      message: {
        raw: encoded
      }
    })
  });

  return {
    ok: true,
    message: 'Created a Gmail draft from Walt.'
  };
}
