/**
 * Lightweight operation logging.
 *
 * Records what ran, how long it took and how much it retrieved or spent. Never
 * logs message bodies, prospect text, keys or credentials — only shapes, counts
 * and identifiers.
 */

export type OpRecord = {
  op: string;
  ms: number;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  count?: number;
  cached?: boolean;
  error?: string;
  /** Extra counters for this op. Counts only — never text. */
  extra?: Record<string, number>;
};

const listeners: ((record: OpRecord) => void)[] = [];

export function onOp(fn: (record: OpRecord) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function record(rec: OpRecord): void {
  for (const fn of listeners) fn(rec);
  if (process.env.DM_SETTER_LOG === "0") return;
  const parts = [`op=${rec.op}`, `ms=${Math.round(rec.ms)}`];
  if (rec.model) parts.push(`model=${rec.model}`);
  if (rec.tokens_in != null) parts.push(`tin=${rec.tokens_in}`);
  if (rec.tokens_out != null) parts.push(`tout=${rec.tokens_out}`);
  if (rec.count != null) parts.push(`n=${rec.count}`);
  if (rec.cached) parts.push("cached=1");
  for (const [key, value] of Object.entries(rec.extra ?? {})) parts.push(`${key}=${value}`);
  if (rec.error) parts.push(`error=${rec.error.slice(0, 80)}`);
  console.info(`[dm-setter] ${parts.join(" ")}`);
}

/** Times an operation and records it, whether it succeeds or throws. */
export async function timed<T>(op: string, fn: () => Promise<T>, extra: Partial<OpRecord> = {}): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - started;
    record({ op, ms, ...extra });
    return { result, ms };
  } catch (error) {
    record({ op, ms: Date.now() - started, ...extra, error: error instanceof Error ? error.message : "unknown" });
    throw error;
  }
}
