import { describe, it, expect } from "vitest";
import {
  CompositeLimiter,
  FakeClock,
  KeyedLimiter,
  SlidingWindow,
  TokenBucket,
} from "../src/limiter.js";

describe("FakeClock", () => {
  it("starts at the given time and advances", () => {
    const c = new FakeClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
  });

  it("refuses to go backwards", () => {
    const c = new FakeClock(1000);
    expect(() => c.advance(-1)).toThrow(RangeError);
  });
});

describe("TokenBucket", () => {
  it("allows a burst up to capacity", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 1, clock });
    for (let i = 0; i < 5; i++) {
      expect(b.tryTake().allowed).toBe(true);
    }
    expect(b.tryTake().allowed).toBe(false);
  });

  it("reports remaining tokens", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 1, clock });
    expect(b.tryTake().remaining).toBe(2);
    expect(b.tryTake().remaining).toBe(1);
  });

  it("refills over time", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, clock });
    b.tryTake();
    b.tryTake();
    expect(b.tryTake().allowed).toBe(false);
    clock.advance(1000);
    expect(b.tryTake().allowed).toBe(true);
  });

  it("never refills beyond capacity", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 10, clock });
    clock.advance(60_000);
    expect(b.peek()).toBe(2);
  });

  it("computes a retry delay that is actually sufficient", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1, clock });
    b.tryTake();
    const d = b.tryTake();
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
    clock.advance(d.retryAfterMs);
    expect(b.tryTake().allowed).toBe(true);
  });

  it("supports a cost greater than one", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1, clock });
    expect(b.tryTake(7).allowed).toBe(true);
    expect(b.tryTake(7).allowed).toBe(false);
    expect(b.tryTake(3).allowed).toBe(true);
  });

  it("rejects invalid construction", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: NaN, refillPerSecond: 1 })).toThrow(RangeError);
  });

  it("rejects an invalid cost", () => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    expect(() => b.tryTake(0)).toThrow(RangeError);
    expect(() => b.tryTake(-1)).toThrow(RangeError);
  });

  it("does not refill when the clock has not moved", () => {
    const clock = new FakeClock();
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 100, clock });
    b.tryTake();
    expect(b.tryTake().allowed).toBe(false);
  });
});

describe("SlidingWindow", () => {
  it("allows up to the limit inside the window", () => {
    const clock = new FakeClock();
    const w = new SlidingWindow({ limit: 3, windowMs: 1000, clock });
    expect(w.tryTake().allowed).toBe(true);
    expect(w.tryTake().allowed).toBe(true);
    expect(w.tryTake().allowed).toBe(true);
    expect(w.tryTake().allowed).toBe(false);
  });

  it("frees capacity once requests age out", () => {
    const clock = new FakeClock();
    const w = new SlidingWindow({ limit: 2, windowMs: 1000, clock });
    w.tryTake();
    w.tryTake();
    expect(w.tryTake().allowed).toBe(false);
    clock.advance(1001);
    expect(w.tryTake().allowed).toBe(true);
  });

  it("does not allow the fixed-window boundary burst", () => {
    // The classic fixed-window flaw: 2 at the end of one window and 2 at the
    // start of the next is 4 in a moment. A sliding window must refuse it.
    const clock = new FakeClock();
    const w = new SlidingWindow({ limit: 2, windowMs: 1000, clock });
    w.tryTake();
    w.tryTake();
    clock.advance(999);
    expect(w.tryTake().allowed).toBe(false);
    clock.advance(2);
    expect(w.tryTake().allowed).toBe(true);
  });

  it("reports a retry delay that is sufficient", () => {
    const clock = new FakeClock();
    const w = new SlidingWindow({ limit: 1, windowMs: 500, clock });
    w.tryTake();
    const d = w.tryTake();
    expect(d.allowed).toBe(false);
    clock.advance(d.retryAfterMs);
    expect(w.tryTake().allowed).toBe(true);
  });

  it("tracks the count inside the window", () => {
    const clock = new FakeClock();
    const w = new SlidingWindow({ limit: 5, windowMs: 1000, clock });
    w.tryTake();
    w.tryTake();
    expect(w.count()).toBe(2);
    clock.advance(1001);
    expect(w.count()).toBe(0);
  });

  it("rejects invalid construction", () => {
    expect(() => new SlidingWindow({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new SlidingWindow({ limit: 1.5, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new SlidingWindow({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

describe("CompositeLimiter", () => {
  it("enforces both the burst and the quota", () => {
    const clock = new FakeClock();
    const l = new CompositeLimiter({
      capacity: 10,
      refillPerSecond: 10,
      windowLimit: 3,
      windowMs: 1000,
      clock,
    });
    expect(l.tryTake().allowed).toBe(true);
    expect(l.tryTake().allowed).toBe(true);
    expect(l.tryTake().allowed).toBe(true);
    // The window is the binding constraint even though the bucket has tokens.
    expect(l.tryTake().allowed).toBe(false);
  });

  it("does not burn a bucket token when the window refuses", () => {
    const clock = new FakeClock();
    const l = new CompositeLimiter({
      capacity: 5,
      refillPerSecond: 1,
      windowLimit: 1,
      windowMs: 10_000,
      clock,
    });
    expect(l.tryTake().allowed).toBe(true);
    expect(l.bucketTokens()).toBe(4);
    // Refused by the window. The bucket must be untouched.
    expect(l.tryTake().allowed).toBe(false);
    expect(l.bucketTokens()).toBe(4);
    expect(l.tryTake().allowed).toBe(false);
    expect(l.bucketTokens()).toBe(4);
  });

  it("reports the tighter of the two remaining counts", () => {
    const clock = new FakeClock();
    const l = new CompositeLimiter({
      capacity: 100,
      refillPerSecond: 1,
      windowLimit: 2,
      windowMs: 1000,
      clock,
    });
    l.tryTake();
    const d = l.tryTake();
    expect(d.remaining).toBe(0);
  });
});

describe("KeyedLimiter", () => {
  it("tracks keys independently", () => {
    const clock = new FakeClock();
    const l = new KeyedLimiter({
      capacity: 1,
      refillPerSecond: 1,
      windowLimit: 1,
      windowMs: 1000,
      clock,
    });
    expect(l.tryTake("alice").allowed).toBe(true);
    expect(l.tryTake("alice").allowed).toBe(false);
    expect(l.tryTake("bob").allowed).toBe(true);
  });

  it("evicts idle keys so it does not leak memory", () => {
    const clock = new FakeClock();
    const l = new KeyedLimiter({
      capacity: 1,
      refillPerSecond: 1,
      windowLimit: 1,
      windowMs: 1000,
      idleTtlMs: 5000,
      clock,
    });
    l.tryTake("alice");
    l.tryTake("bob");
    expect(l.size()).toBe(2);
    clock.advance(6000);
    l.tryTake("carol");
    expect(l.size()).toBe(1);
  });

  it("keeps a key alive while it is being used", () => {
    const clock = new FakeClock();
    const l = new KeyedLimiter({
      capacity: 5,
      refillPerSecond: 5,
      windowLimit: 5,
      windowMs: 1000,
      idleTtlMs: 1000,
      clock,
    });
    for (let i = 0; i < 5; i++) {
      l.tryTake("alice");
      clock.advance(500);
    }
    expect(l.size()).toBe(1);
  });

  it("rejects an empty key", () => {
    const l = new KeyedLimiter({
      capacity: 1,
      refillPerSecond: 1,
      windowLimit: 1,
      windowMs: 1000,
    });
    expect(() => l.tryTake("")).toThrow(TypeError);
  });
});
