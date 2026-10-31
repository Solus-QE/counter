/** Respect Relay's server deadline as well as exponential client backoff. */
export function relayRetryDelay(error: unknown, attempt: number): number {
  const retryAfter = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  const exponential = Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
  const delay = exponential * (0.75 + Math.random() * 0.5);
  return Math.ceil(Math.max(delay, typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : 0));
}

/** One failed polling operation must not generate another request before its deadline. */
export class RelayRetryGate {
  private failures = 0;
  private nextAttempt = 0;
  ready(now = Date.now()): boolean { return now >= this.nextAttempt; }
  succeeded(): void { this.failures = 0; this.nextAttempt = 0; }
  failed(error: unknown, now = Date.now()): number {
    const delay = relayRetryDelay(error, this.failures++);
    this.nextAttempt = now + delay;
    return delay;
  }
}
