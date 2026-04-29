export function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createPerfTimer() {
  const startedAt = nowMs();
  const marks: Record<string, number> = {};

  return {
    mark(name: string, started = startedAt) {
      marks[name] = Math.round(nowMs() - started);
      return marks[name];
    },
    elapsed(started = startedAt) {
      return Math.round(nowMs() - started);
    },
    snapshot() {
      return {
        startedAt,
        totalMs: Math.round(nowMs() - startedAt),
        marks: { ...marks }
      };
    }
  };
}

export function compactPerfPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
