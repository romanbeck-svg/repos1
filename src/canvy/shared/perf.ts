export type PerfValue = string | number | boolean | null | undefined;

export interface PerfSnapshot {
  startedAt: number;
  totalMs: number;
  marks: Record<string, number>;
}

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
    snapshot(): PerfSnapshot {
      return {
        startedAt,
        totalMs: Math.round(nowMs() - startedAt),
        marks: { ...marks }
      };
    }
  };
}

export function hashText(value: string) {
  const sample =
    value.length <= 24_000
      ? value
      : `${value.slice(0, 8_000)}${value.slice(Math.max(0, Math.floor(value.length / 2) - 4_000), Math.floor(value.length / 2) + 4_000)}${value.slice(-8_000)}`;
  let hash = 2166136261;

  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${value.length}:${(hash >>> 0).toString(36)}`;
}

export function compactPerfPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
