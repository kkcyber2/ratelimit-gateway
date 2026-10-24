/**
 * A token-bucket rate limiter with a sliding-window fallback.
 *
 * Two algorithms, because they answer different questions:
 *
 *   - Token bucket: "how much burst can this client absorb?" Refills at a
 *     steady rate and allows a burst up to the bucket size. This is what you
 *     want for an API where a client occasionally fires a batch.
 *   - Sliding window: "how many requests in the last N seconds?" Exact, no
 *     burst allowance. This is what you want for a hard quota.
 *
 * Both are implemented over a pluggable clock so the tests do not sleep.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export class FakeClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    if (ms < 0) throw new RangeError("cannot advance a clock backwards");
    this.t += ms;
  }
}

export interface Decision {
  allowed: boolean;
  /** Tokens left after this request (token bucket) or remaining quota. */
  remaining: number;
  /** Milliseconds until the next request would be allowed. 0 when allowed. */
  retryAfterMs: number;
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock?: Clock;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  private tokens: number;
  private lastRefill: number;
  private readonly clock: Clock;

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.capacity) || opts.capacity <= 0) {
      throw new RangeError("capacity must be a positive number");
    }
    if (!Number.isFinite(opts.refillPerSecond) || opts.refillPerSecond <= 0) {
      throw new RangeError("refillPerSecond must be a positive number");
    }
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.clock = opts.clock ?? systemClock;
    this.tokens = opts.capacity;
    this.lastRefill = this.clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / 1000) * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now;
  }

  /** Try to take `cost` tokens. */
  tryTake(cost = 1): Decision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError("cost must be a positive number");
    }
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: this.tokens, retryAfterMs: 0 };
    }
    const deficit = cost - this.tokens;
    const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
    return { allowed: false, remaining: this.tokens, retryAfterMs: waitMs };
  }

  /** Current token count without consuming any. */
  peek(): number {
    this.refill();
    return this.tokens;
  }
}

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  clock?: Clock;
}

/**
 * Exact sliding window over a ring of timestamps.
 *
 * A fixed window ("100 per minute, reset on the minute") lets a client send
 * 100 at 00:59 and 100 at 01:00 — 200 in two seconds. Tracking the actual
 * timestamps of the last `limit` requests removes that edge entirely.
 */
export class SlidingWindow {
  readonly limit: number;
  readonly windowMs: number;
  private readonly clock: Clock;
  private hits: number[] = [];

  constructor(opts: SlidingWindowOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
      throw new RangeError("windowMs must be a positive number");
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.clock = opts.clock ?? systemClock;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    // Timestamps are appended in order, so the expired ones are a prefix.
    let i = 0;
    while (i < this.hits.length && this.hits[i] <= cutoff) i++;
    if (i > 0) this.hits = this.hits.slice(i);
  }

  tryTake(): Decision {
    const now = this.clock.now();
    this.evict(now);
    if (this.hits.length < this.limit) {
      this.hits.push(now);
      return {
        allowed: true,
        remaining: this.limit - this.hits.length,
        retryAfterMs: 0,
      };
    }
    const oldest = this.hits[0];
    const retryAfterMs = Math.max(1, oldest + this.windowMs - now);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  /** Number of requests currently inside the window. */
  count(): number {
    this.evict(this.clock.now());
    return this.hits.length;
  }
}

export interface LimiterOptions {
  capacity: number;
  refillPerSecond: number;
  windowLimit: number;
  windowMs: number;
  clock?: Clock;
}

/**
 * Combines both: a burst allowance and a hard quota.
 *
 * A request is allowed only if *both* agree. The bucket absorbs bursts; the
 * window enforces the ceiling. Neither alone gives you both properties.
 */
export class CompositeLimiter {
  private readonly bucket: TokenBucket;
  private readonly window: SlidingWindow;

  constructor(opts: LimiterOptions) {
    const clock = opts.clock ?? systemClock;
    this.bucket = new TokenBucket({
      capacity: opts.capacity,
      refillPerSecond: opts.refillPerSecond,
      clock,
    });
    this.window = new SlidingWindow({
      limit: opts.windowLimit,
      windowMs: opts.windowMs,
      clock,
    });
  }

  tryTake(): Decision {
    // Check the window first: if the hard quota is exhausted, do not burn a
    // token from the bucket, or a client could drain the burst allowance
    // while being rejected.
    const windowDecision = this.window.tryTake();
    if (!windowDecision.allowed) {
      return windowDecision;
    }
    const bucketDecision = this.bucket.tryTake();
    if (!bucketDecision.allowed) {
      return bucketDecision;
    }
    return {
      allowed: true,
      remaining: Math.min(bucketDecision.remaining, windowDecision.remaining),
      retryAfterMs: 0,
    };
  }

  /**
   * Tokens currently in the burst bucket.
   *
   * Exposed because the "a window refusal must not consume a bucket token"
   * invariant is otherwise unobservable: `remaining` reports the minimum of
   * the two limiters, so it reads 0 whenever the window is the binding
   * constraint, whether or not the bucket was touched.
   */
  bucketTokens(): number {
    return this.bucket.peek();
  }
}

export interface KeyedLimiterOptions extends LimiterOptions {
  /** How long an idle key is kept before its state is dropped. */
  idleTtlMs?: number;
}

/**
 * Per-key limiter with idle eviction.
 *
 * Without eviction this is a memory leak: every distinct client key leaves a
 * limiter behind forever. Idle keys are swept on access rather than on a
 * timer, so there is no background work and no timer to leak.
 */
export class KeyedLimiter {
  private readonly limiters = new Map<string, { limiter: CompositeLimiter; lastSeen: number }>();
  private readonly opts: KeyedLimiterOptions;
  private readonly clock: Clock;

  constructor(opts: KeyedLimiterOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
  }

  private sweep(now: number): void {
    const ttl = this.opts.idleTtlMs ?? 300_000;
    for (const [key, entry] of this.limiters) {
      if (now - entry.lastSeen > ttl) this.limiters.delete(key);
    }
  }

  tryTake(key: string): Decision {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("key must be a non-empty string");
    }
    const now = this.clock.now();
    this.sweep(now);
    let entry = this.limiters.get(key);
    if (!entry) {
      entry = { limiter: new CompositeLimiter(this.opts), lastSeen: now };
      this.limiters.set(key, entry);
    }
    entry.lastSeen = now;
    return entry.limiter.tryTake();
  }

  /** Number of keys currently tracked. */
  size(): number {
    return this.limiters.size;
  }
}
