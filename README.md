# ratelimit-gateway

Token-bucket and sliding-window rate limiting for Node, with per-key state and
idle eviction. Zero runtime dependencies.

## Why two algorithms

They answer different questions, and most libraries only give you one:

- **Token bucket** — "how much burst can this client absorb?" Refills at a
  steady rate and allows a burst up to the bucket size. Right for an API where
  a client occasionally fires a batch.
- **Sliding window** — "how many requests in the last N seconds?" Exact, no
  burst allowance. Right for a hard quota.

`CompositeLimiter` runs both and allows a request only if **both** agree. The
bucket absorbs bursts; the window enforces the ceiling.

## The fixed-window bug this avoids

A fixed window ("100 per minute, reset on the minute") lets a client send 100
at `00:59` and 100 at `01:00` — 200 requests in two seconds, double the
intended rate. Tracking the actual timestamps of the last `limit` requests
removes that edge entirely. There is a test for exactly this case.

## Install

```bash
npm install
```

## Run the tests

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Use it

```ts
import { CompositeLimiter, KeyedLimiter } from "ratelimit-gateway";

// One limiter per client key, with idle eviction.
const limiter = new KeyedLimiter({
  capacity: 20,          // burst allowance
  refillPerSecond: 5,    // steady rate
  windowLimit: 100,      // hard quota
  windowMs: 60_000,      // per minute
  idleTtlMs: 300_000,    // drop a key after 5 idle minutes
});

const decision = limiter.tryTake("user:42");
if (!decision.allowed) {
  res.setHeader("Retry-After", Math.ceil(decision.retryAfterMs / 1000));
  return res.status(429).end();
}
```

## Design notes

**A pluggable clock.** Every limiter takes a `Clock`. The tests use `FakeClock`
and advance time directly, so the suite runs in milliseconds and never sleeps.
A rate limiter tested with real `setTimeout` is a rate limiter with a flaky
suite.

**A window refusal must not consume a bucket token.** If the hard quota is
exhausted, the composite checks the window first and returns without touching
the bucket. Otherwise a client could drain its burst allowance while being
rejected, and then be throttled again the moment the window frees up. This
invariant is exposed via `bucketTokens()` because `remaining` reports the
minimum of the two limiters and therefore reads 0 whenever the window binds —
which makes the invariant invisible otherwise.

**Idle eviction, not a timer.** A per-key limiter without eviction is a memory
leak: every distinct client key leaves a limiter behind forever. Idle keys are
swept on access rather than by a background timer, so there is no timer to leak
and no work when the service is idle.

**Retry delays are computed, not guessed.** `retryAfterMs` is derived from the
actual deficit and refill rate, and the tests assert that waiting exactly that
long makes the next request succeed.

## Layout

```
src/limiter.ts        TokenBucket, SlidingWindow, CompositeLimiter, KeyedLimiter
tests/limiter.test.ts
```

## Licence

MIT. See `LICENSE`.

## Author

Konain Sultan Khan (KK) — https://github.com/kkcyber2
LinkedIn: _add your profile URL here_
