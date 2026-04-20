import { useEffect, useRef, useState } from 'react';

export function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) {
      return undefined;
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const legacyMedia = media as MediaQueryList & {
      addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    };
    const apply = (event?: MediaQueryListEvent) => setReduced(event?.matches ?? media.matches);
    apply();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }

    legacyMedia.addListener?.(apply);
    return () => legacyMedia.removeListener?.(apply);
  }, []);

  return reduced;
}

export function useDripReveal(target: string, active: boolean) {
  const reducedMotion = useReducedMotionPreference();
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);

  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  useEffect(() => {
    if (!target) {
      setDisplayed('');
      displayedRef.current = '';
      return undefined;
    }

    if (reducedMotion || !active) {
      setDisplayed(target);
      displayedRef.current = target;
      return undefined;
    }

    const current = displayedRef.current;
    if (!target.startsWith(current)) {
      setDisplayed(target);
      displayedRef.current = target;
      return undefined;
    }

    if (current.length >= target.length) {
      return undefined;
    }

    let timeoutId = 0;

    const pump = () => {
      const visible = displayedRef.current;
      if (visible.length >= target.length) {
        return;
      }

      const remaining = target.length - visible.length;
      const step = remaining > 120 ? 5 : remaining > 72 ? 4 : remaining > 32 ? 3 : 2;
      const next = target.slice(0, visible.length + step);
      displayedRef.current = next;
      setDisplayed(next);

      if (next.length < target.length) {
        timeoutId = window.setTimeout(pump, 34);
      }
    };

    timeoutId = window.setTimeout(pump, 34);
    return () => window.clearTimeout(timeoutId);
  }, [target, active, reducedMotion]);

  return {
    displayed,
    reducedMotion
  };
}
