/**
 * auth.js — minimal but solid password-based authentication.
 *
 * - First run: no auth file → /api/auth/setup creates the master password.
 * - Subsequent: /api/auth/login verifies bcrypt hash and seeds session.
 * - Session is signed cookie (express-session) backed by memory.
 * - All /api/* (except /api/auth/*) require an authenticated session.
 *
 * Brute-force protection: per-IP rate limit on the login route + small
 * exponential backoff stored in memory.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getStore } = require('./jsonStore');
const { randomSecret } = require('./crypto');

const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json');
const SECRET_FILE = path.join(__dirname, '..', 'data', '.session_secret');
const authStore = getStore(AUTH_FILE, { passwordHash: null, createdAt: null });

function _ensureSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  try { fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true }); } catch {}
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) return s;
    } catch {}
  }
  const s = randomSecret(48);
  try {
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  } catch {}
  return s;
}

const SESSION_SECRET = _ensureSessionSecret();

function isInitialized() {
  return !!authStore.read().passwordHash;
}

async function setupPassword(password) {
  if (isInitialized()) throw new Error('Already initialized');
  if (!password || String(password).length < 6) throw new Error('Password too short (min 6)');
  const hash = await bcrypt.hash(String(password), 10);
  const data = authStore.read();
  data.passwordHash = hash;
  data.createdAt = Date.now();
  authStore.touch();
  await authStore.flush();
}

async function changePassword(oldPassword, newPassword) {
  if (!isInitialized()) throw new Error('Not initialized');
  if (!newPassword || String(newPassword).length < 6) throw new Error('New password too short');
  const data = authStore.read();
  const ok = await bcrypt.compare(String(oldPassword || ''), data.passwordHash);
  if (!ok) throw new Error('Wrong current password');
  data.passwordHash = await bcrypt.hash(String(newPassword), 10);
  authStore.touch();
  await authStore.flush();
}

async function verify(password) {
  if (!isInitialized()) return false;
  return bcrypt.compare(String(password || ''), authStore.read().passwordHash);
}

// Per-IP login backoff: count consecutive failures, force a small delay.
const _failures = new Map(); // ip -> { count, last }
function _failureDelay(ip) {
  const f = _failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.last > 5 * 60_000) { _failures.delete(ip); return 0; }
  // Cap at 4s.
  return Math.min(4000, 250 * Math.pow(2, Math.max(0, f.count - 2)));
}
function _noteFailure(ip) {
  const f = _failures.get(ip) || { count: 0, last: 0 };
  f.count += 1; f.last = Date.now();
  _failures.set(ip, f);
}
function _clearFailures(ip) { _failures.delete(ip); }

// Express middleware: gates everything that isn't whitelisted.
function requireAuth(opts = {}) {
  const allowPaths = new Set([
    '/login',
    '/setup',
    '/discord.png',
    '/favicon.ico',
  ]);
  const allowPrefixes = ['/api/auth/', '/src/', '/public/'];
  return (req, res, next) => {
    const url = req.path || req.url;
    if (allowPaths.has(url)) return next();
    if (allowPrefixes.some(p => url.startsWith(p))) return next();
    if (url.endsWith('.css') || url.endsWith('.js') || url.endsWith('.png') ||
        url.endsWith('.svg') || url.endsWith('.ico') || url.endsWith('.woff') ||
        url.endsWith('.woff2')) return next();
    if (req.session && req.session.user) return next();

    if (url.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    if (!isInitialized()) return res.redirect('/setup');
    return res.redirect('/login');
  };
}

module.exports = {
  SESSION_SECRET,
  isInitialized,
  setupPassword,
  changePassword,
  verify,
  requireAuth,
  _failureDelay,
  _noteFailure,
  _clearFailures,
};
