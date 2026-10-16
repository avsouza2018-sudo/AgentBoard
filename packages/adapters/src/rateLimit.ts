import type { Clock } from '@agentboard/domain';

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** One call, one decision. A limiter that only reports is not a limiter. */
  check(key: string): RateLimitDecision;
}

export interface BucketOptions {
  /** Calls a token may make in a burst. */
  capacity: number;
  /** Refill rate per second. */
  refillPerSecond: number;
  /** Injected so a test can measure the window without waiting for it. */
  clock?: Clock;
}

/**
 * A token bucket per credential.
 *
 * The limit lives in the adapter layer because it is not a business rule. The domain does not care how
 * often an agent asks; a limit written inside a use case would make the same move legal or illegal
 * depending on the caller's history, which is traffic, not policy. Keeping it outside also means the
 * refusal is produced by the same registry both transports share, so an agent over a pipe and a browser
 * over HTTP are told the same thing in the same words — and the use case is never reached, which is the
 * point of refusing early.
 *
 * The bucket is keyed by token, not by actor. Two tokens for the same actor are two clients, and a limit
 * that merged them would let one runaway process spend the other's budget.
 */
export function createTokenBucket(options: BucketOptions): RateLimiter {
  const clock = options.clock ?? { now: () => new Date() };
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();

  return {
    check(key: string): RateLimitDecision {
      const now = clock.now().getTime();
      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = { tokens: options.capacity, lastRefill: now };
        buckets.set(key, bucket);
      }

      const elapsed = (now - bucket.lastRefill) / 1000;
      if (elapsed > 0) {
        bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
        bucket.lastRefill = now;
      }

      if (bucket.tokens < 1) {
        const needed = 1 - bucket.tokens;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(needed / options.refillPerSecond)) };
      }

      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    },
  };
}
