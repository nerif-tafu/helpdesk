// Small in-memory fixed-window rate limiter.

const buckets = new Map();

/**
 * Count a hit for `key` and report whether it is within `limit` per `windowMs`.
 * @returns {{ ok: boolean, retryAfter: number }} retryAfter in seconds
 */
export function hit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return { ok: bucket.count <= limit, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Express middleware: limit requests per client IP (plus an optional key suffix). */
export function rateLimit({ name, limit, windowMs, key = () => '' }) {
  return (req, res, next) => {
    const result = hit(`${name}:${req.ip}:${key(req)}`, limit, windowMs);
    if (result.ok) return next();
    req.audit = { action: 'http.rate_limited', details: { limit: name } };
    res.setHeader('Retry-After', String(result.retryAfter));
    res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60 * 1000).unref();
