import { useEffect, useState } from 'react';

function readDraft(key: string, fallback: string) {
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const stored = window.localStorage.getItem(key);
    return stored ?? fallback;
  } catch {
    return fallback;
  }
}

export function usePersistentDraft(key: string, fallback = '') {
  const [value, setValue] = useState(() => readDraft(key, fallback));

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      if (value) {
        window.localStorage.setItem(key, value);
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Draft persistence should never block the UI.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
