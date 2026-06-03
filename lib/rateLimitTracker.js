// lib/rateLimitTracker.js
// ─────────────────────────────────────────────────────────────────
// Per-account Discord rate limit state tracker.
// Tracks when an account hits a 429 and how long it stays blocked.
//
// Key design:
//   - Keyed by last 14 chars of token (never stores the full token)
//   - Thread-safe via simple Map (Node.js is single-threaded)
//   - Auto-cleans expired entries every 30 s
// ─────────────────────────────────────────────────────────────────

const _rlMap = new Map();
// tokenKey → { until, retryAfterMs, route, accountName, hitAt }

function tokenKey(token) {
  return typeof token === 'string' ? token.slice(-14) : 'anon';
}

/**
 * Mark an account as rate-limited.
 * @param {string} token         - The account's Discord token
 * @param {number} retryAfterMs  - How long to block (milliseconds)
 * @param {string} [route]       - The Discord route that returned 429
 * @param {string} [accountName] - Human-readable account name for logging
 */
function markRateLimited(token, retryAfterMs, route = 'global', accountName = '') {
  const until = Date.now() + Math.max(retryAfterMs, 1000);
  _rlMap.set(tokenKey(token), {
    until,
    retryAfterMs,
    route,
    accountName,
    hitAt: Date.now(),
  });
}

/**
 * Check whether an account is currently rate-limited.
 * Auto-deletes expired entries.
 */
function isRateLimited(token) {
  const key = tokenKey(token);
  const st = _rlMap.get(key);
  if (!st) return false;
  if (Date.now() >= st.until) { _rlMap.delete(key); return false; }
  return true;
}

/**
 * Get full rate limit info for an account, or null if not limited.
 */
function getRateLimitInfo(token) {
  const key = tokenKey(token);
  const st = _rlMap.get(key);
  if (!st) return null;
  const now = Date.now();
  if (now >= st.until) { _rlMap.delete(key); return null; }
  return { ...st, remainingMs: st.until - now };
}

/**
 * Manually clear an account's rate limit (e.g. on reconnect).
 */
function clearRateLimit(token) {
  _rlMap.delete(tokenKey(token));
}

/**
 * Return a snapshot of all currently rate-limited accounts.
 * { [tokenKey]: { until, retryAfterMs, route, accountName, hitAt, remainingMs } }
 */
function getAllStatus() {
  const now = Date.now();
  const out = {};
  for (const [k, v] of _rlMap) {
    if (now >= v.until) { _rlMap.delete(k); continue; }
    out[k] = { ...v, remainingMs: v.until - now };
  }
  return out;
}

// Periodic cleanup — remove expired entries every 30 s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlMap) {
    if (now >= v.until) _rlMap.delete(k);
  }
}, 30000).unref?.();

module.exports = { markRateLimited, isRateLimited, getRateLimitInfo, clearRateLimit, getAllStatus, tokenKey };
