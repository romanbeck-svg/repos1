import type { ApiBaseUrlSource } from './types';

export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8787';
export const API_BASE_URL_ENV_KEYS = ['VITE_MAKOIQ_API_BASE_URL', 'VITE_CANVY_API_BASE_URL'] as const;
type ApiBaseUrlEnvKey = (typeof API_BASE_URL_ENV_KEYS)[number];

export interface ApiBaseUrlResolution {
  value: string;
  source: ApiBaseUrlSource;
  envKey?: ApiBaseUrlEnvKey;
  storedValue?: string;
  mode: 'development' | 'production';
  isLoopback: boolean;
}

function normalizeApiBaseUrl(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  return trimmed.replace(/\/+$/, '');
}

function getMode(): 'development' | 'production' {
  return import.meta.env.DEV ? 'development' : 'production';
}

export function isLoopbackApiBaseUrl(value?: string | null) {
  const normalized = normalizeApiBaseUrl(value);
  if (!normalized) {
    return false;
  }

  try {
    const hostname = new URL(normalized).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function getExplicitApiBaseUrlFromEnv() {
  const makoIqValue = normalizeApiBaseUrl(import.meta.env[API_BASE_URL_ENV_KEYS[0]]);
  if (makoIqValue) {
    return {
      value: makoIqValue,
      envKey: API_BASE_URL_ENV_KEYS[0]
    };
  }

  const legacyValue = normalizeApiBaseUrl(import.meta.env[API_BASE_URL_ENV_KEYS[1]]);
  if (legacyValue) {
    return {
      value: legacyValue,
      envKey: API_BASE_URL_ENV_KEYS[1]
    };
  }

  return {
    value: '',
    envKey: undefined
  };
}

export function resolveApiBaseUrl(storedValue?: string | null, storedSource?: ApiBaseUrlSource | null): ApiBaseUrlResolution {
  const explicitEnv = getExplicitApiBaseUrlFromEnv();
  const normalizedStoredValue = normalizeApiBaseUrl(storedValue);
  const resolved =
    (storedSource === 'storage' ? normalizedStoredValue : '') ||
    explicitEnv.value ||
    normalizedStoredValue ||
    normalizeApiBaseUrl(DEFAULT_API_BASE_URL);
  const source: ApiBaseUrlSource =
    storedSource === 'storage' && normalizedStoredValue
      ? 'storage'
      : explicitEnv.value
        ? 'env'
        : normalizedStoredValue
          ? 'storage'
          : 'default';

  return {
    value: resolved,
    source,
    envKey: explicitEnv.envKey,
    storedValue: normalizedStoredValue || undefined,
    mode: getMode(),
    isLoopback: isLoopbackApiBaseUrl(resolved)
  };
}

export function getApiBaseUrlFromEnv() {
  return getExplicitApiBaseUrlFromEnv().value;
}
