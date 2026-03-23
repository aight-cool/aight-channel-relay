/**
 * In-memory rate limiter for Cloudflare Workers.
 *
 * Uses the Worker's global scope — counters reset when the isolate recycles.
 * This is intentional: rate limiting doesn't need to be perfect,
 * just good enough to stop automated brute force.
 *
 * No DOs, no storage, no extra cost.
 */

interface RateBucket {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

const buckets = new Map<string, RateBucket>();

// Periodically clean up expired entries to prevent memory leaks
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000;

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

/**
 * Check if a request should be rate-limited.
 *
 * @param key - Unique key for the rate limit bucket (e.g. "pair:192.168.1.1")
 * @param config - Rate limit configuration
 * @returns true if the request should be BLOCKED (rate limited)
 */
export function isRateLimited(key: string, config: RateLimitConfig): boolean {
  cleanup();

  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    // New window
    buckets.set(key, { count: 1, resetAt: now + config.windowMs });
    return false;
  }

  bucket.count++;
  return bucket.count > config.maxRequests;
}

/**
 * Build a 429 response for rate-limited requests.
 */
export function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: "Too many requests. Try again later." }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "60",
    },
  });
}
