const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const { Client, RichPresence, CustomStatus } = require('discord.js-selfbot-v13');
const { getStore } = require('./lib/jsonStore');
const { encrypt, decrypt, tryDecrypt, isEncrypted } = require('./lib/crypto');
const { buildProxyAgents, testProxy, maskProxy } = require('./lib/proxy');
const auth = require('./lib/auth');
const users = require('./lib/users');
const oauth = require('./lib/oauth');
const {
  ctx: userCtx, runWithUser, withUser, currentUserId,
  scopedStore, clientsPool, activeRef, SYSTEM_UID,
} = require('./lib/userScope');
const helmet = require('helmet');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const PORT = 5000;

// Bounded-set helper — prevents Sets used for "first-time-only" warnings or
// dedupe windows from growing without limit. When the cap is hit we drop the
// oldest insertion (Set iteration order = insertion order).
function addBounded(set, value, max) {
  if (!set.has(value) && set.size >= max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

// Bounded-map helper — same idea for Maps with a "ts" field per entry.
function addBoundedMap(map, key, value, max) {
  if (!map.has(key) && map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// ── Security middleware ────────────────────────────────────────────────
// Helmet sets sane HTTP security headers. CSP is disabled because the app
// uses many inline event handlers throughout the legacy frontend; tightening
// CSP would require refactoring every component.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

app.use(session({
  name: 'dam.sid',
  secret: auth.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // every request extends the cookie's expiry
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // proxy terminates TLS; cookie still flows over HTTPS via proxy
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days; device-token cookie is 1y
  },
}));

// API rate limiter — 300 requests / minute / IP for /api/*. SSE endpoints
// bypass via their own keyGenerator? Using global is fine; SSE keeps a
// single open connection rather than spamming requests.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/auth/') === false && req.path.includes('/stream'),
  message: { success: false, error: 'rate_limited' },
});
app.use('/api/', apiLimiter);

// Stricter limiter on auth endpoints to slow brute force.
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too_many_attempts' },
});
app.use('/api/auth/', authLimiter);

// Default Discord-style avatar (used as fallback) — public.
const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="32" fill="#5865F2"/>
  <path fill="#fff" d="M44.6 19.5c-2.3-1-4.7-1.8-7.3-2.2-.3.6-.7 1.4-1 2-2.7-.4-5.4-.4-8 0-.3-.6-.7-1.4-1-2-2.5.5-5 1.3-7.3 2.3-4.6 6.9-5.8 13.6-5.2 20.2 3.1 2.3 6 3.7 8.9 4.6.7-1 1.4-2 1.9-3.1-1.1-.4-2.1-.9-3.1-1.5.3-.2.5-.4.8-.6 5.9 2.7 12.4 2.7 18.3 0 .3.2.5.4.8.6-1 .6-2 1.1-3.1 1.5.6 1.1 1.2 2.1 1.9 3.1 2.9-.9 5.8-2.3 8.9-4.6.7-7.7-1.2-14.3-5.2-20.2zM25.4 36.1c-1.8 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.3 1.6 3.2 3.6c0 2-1.4 3.6-3.2 3.6zm13.1 0c-1.8 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.3 1.6 3.2 3.6c0 2-1.4 3.6-3.2 3.6z"/>
</svg>`;
app.get('/discord.png', (req, res) => {
  res.set('Content-Type', 'image/svg+xml').send(DEFAULT_AVATAR_SVG);
});
app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/svg+xml').send(DEFAULT_AVATAR_SVG);
});

// ── Authentication endpoints (no auth required) ────────────────────
app.get('/login', (req, res) => {
  // Try device-token restore so a returning user lands straight on /
  try { auth.tryRestoreFromDeviceToken(req); } catch {}
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/signup', (req, res) => res.redirect('/login?mode=signup'));

app.get('/api/auth/status', (req, res) => {
  try { auth.tryRestoreFromDeviceToken(req); } catch {}
  // Surface the short-lived Discord verification (used to pre-fill the login
  // form after the user came back from the OAuth round-trip). Expires in 5
  // minutes so a stale session can't be used to phish a username.
  let discordVerifiedFor = null;
  const dv = req.session?.discordVerifiedFor;
  if (dv && (Date.now() - dv.ts) < 5 * 60 * 1000) {
    discordVerifiedFor = {
      username: dv.username,
      avatar: dv.avatar,
      discordUsername: dv.discordUsername,
    };
  } else if (dv) {
    delete req.session.discordVerifiedFor;
  }
  // Also surface a pending Discord identity for the signup pre-fill.
  let pendingDiscord = null;
  if (req.session?.pendingDiscord) {
    pendingDiscord = {
      username: req.session.pendingDiscord.username,
      avatar: req.session.pendingDiscord.avatar,
    };
  }
  res.json({
    success: true,
    initialized: users.count() > 0,
    authed: !!(req.session && req.session.user),
    user: req.session?.user ? users.publicUser(users.findById(req.session.user.id)) : null,
    discordOAuth: oauth.isConfigured(),
    discordVerifiedFor,
    pendingDiscord,
  });
});

// Sign up: create a new account with username + password.
// Optionally include `linkPendingDiscord: true` to link a Discord identity
// the user just authorised in this session (kept in `req.session.pendingDiscord`).
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    let discord = null;
    if (req.session?.pendingDiscord) discord = req.session.pendingDiscord;
    const u = await users.createUser({ username, password, discord });
    delete req.session.pendingDiscord;
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ success: false, error: 'session_error' });
      req.session.user = { id: u.id, username: u.username, loginAt: Date.now() };
      users.touchLogin(u.id);
      // Always issue a long-lived device token so the user never has to log in
      // again from this browser unless they explicitly log out.
      try {
        const tok = users.issueDeviceToken(u.id, { ua: req.headers['user-agent'], ip: req.ip });
        auth.setDeviceCookie(res, tok);
      } catch {}
      res.json({ success: true, user: users.publicUser(users.findById(u.id)) });
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const ip = req.ip;
    const delay = auth._failureDelay(ip);
    if (delay) await new Promise(r => setTimeout(r, delay));
    const { username, password } = req.body || {};
    const u = await users.verifyPassword(username, password);
    if (!u) {
      auth._noteFailure(ip);
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    auth._clearFailures(ip);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ success: false, error: 'session_error' });
      req.session.user = { id: u.id, username: u.username, loginAt: Date.now() };
      users.touchLogin(u.id);
      // Always issue a long-lived device token — once the user logs in here,
      // this browser stays signed in until they hit Logout.
      try {
        const tok = users.issueDeviceToken(u.id, { ua: req.headers['user-agent'], ip: req.ip });
        auth.setDeviceCookie(res, tok);
      } catch {}
      res.json({ success: true, user: users.publicUser(users.findById(u.id)) });
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  auth.clearDeviceCookie(res);
  res.clearCookie('dam.sid');
  res.json({ success: true });
});

// Change password (requires current session)
app.post('/api/auth/change-password', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ success: false, error: 'unauthorized' });
  try {
    const { oldPassword, newPassword } = req.body || {};
    await users.changePassword(req.session.user.id, oldPassword, newPassword);
    // Revoke all device tokens on password change for safety
    users.revokeAllDevices(req.session.user.id);
    auth.clearDeviceCookie(res);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ── Discord OAuth ────────────────────────────────────────────────
// Two intents: 'signup' (start signup-via-Discord), 'login' (sign in if linked),
// 'link' (attach Discord to current account).
app.get('/api/auth/discord/start', (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(503).send('Discord OAuth not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
  }
  const intent = ['signup', 'login', 'link'].includes(req.query.intent) ? req.query.intent : 'login';
  if (intent === 'link' && !req.session?.user) {
    return res.status(401).send('Sign in first to link Discord.');
  }
  const state = oauth.newState();
  req.session.oauthState = state;
  req.session.oauthIntent = intent;
  const url = oauth.authorizeUrl(req, state);
  res.redirect(url);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query || {};
    if (error) return res.redirect(`/login?error=${encodeURIComponent(String(error))}`);
    if (!code || !state || state !== req.session?.oauthState) {
      return res.redirect('/login?error=invalid_state');
    }
    const intent = req.session.oauthIntent || 'login';
    delete req.session.oauthState;
    delete req.session.oauthIntent;

    const tokenResp = await oauth.exchangeCode(req, String(code));
    const me = await oauth.fetchMe(tokenResp.access_token);
    const discordIdentity = { id: me.id, username: me.username, avatar: me.avatar };

    // Linking Discord to an *already signed-in* account is a one-step write.
    if (intent === 'link' && req.session?.user) {
      try {
        users.linkDiscord(req.session.user.id, discordIdentity);
        return res.redirect('/?linked=discord');
      } catch (e) {
        return res.redirect(`/?error=${encodeURIComponent(e.message)}`);
      }
    }

    // For login/signup intents we NEVER bypass the password step. Discord here
    // is only used to identify which account the user wants to sign into (or
    // to start a signup pre-filled with their Discord identity). The password
    // is still required so a friend with access to their Discord cannot take
    // over their managed-token vault.
    const existing = users.findByDiscordId(me.id);
    if (existing) {
      // Refresh stored discord profile (avatar may have changed) and stash a
      // short-lived "discord verified" hint so the login form can pre-fill the
      // username and show whose account they're signing into.
      users.linkDiscord(existing.id, discordIdentity);
      req.session.discordVerifiedFor = {
        userId: existing.id,
        username: existing.username,
        avatar: discordIdentity.avatar,
        discordUsername: discordIdentity.username,
        ts: Date.now(),
      };
      return res.redirect('/login?mode=login&discord_verified=1');
    }

    // Unknown Discord account → signup pre-filled with the Discord identity.
    // The user must still pick a username and password.
    req.session.pendingDiscord = discordIdentity;
    return res.redirect('/login?mode=signup&discord=1');
  } catch (e) {
    return res.redirect(`/login?error=${encodeURIComponent(e.message || 'oauth_failed')}`);
  }
});

app.post('/api/auth/discord/unlink', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ success: false, error: 'unauthorized' });
  try { users.unlinkDiscord(req.session.user.id); res.json({ success: true }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Auth gate: everything below requires a valid session ──────────────
app.use(auth.requireAuth());

// Attach user context (AsyncLocalStorage) so per-user storage and the
// scoped client pool resolve to the right namespace inside every handler.
app.use((req, res, next) => {
  const uid = req.session?.user?.id || SYSTEM_UID;
  userCtx.run({ userId: uid }, next);
});

// /api/me — current authenticated user (with Discord link, if any)
app.get('/api/me', (req, res) => {
  const u = users.findById(req.session.user.id);
  if (!u) return res.status(401).json({ success: false, error: 'unauthorized' });
  res.json({
    success: true,
    user: users.publicUser(u),
    devices: users.listDevices(u.id),
    discordOAuth: oauth.isConfigured(),
  });
});

app.use(express.static(path.join(__dirname)));

// ── Persistent stores (per-user, scoped via AsyncLocalStorage) ─────────
// Each user's data lives under data/users/<userId>/. The scoped wrappers
// transparently resolve to the right per-user JsonStore based on the
// current user context (lib/userScope.js).
const tokensStore = scopedStore('saved_tokens.json', []);

// ───────────────────────────────────────────────
// Multi-token client pool — scoped per user (AsyncLocalStorage)
// `clients` is the per-user namespaced view of the global pool. The same
// Map-like API as before, but the current user's id is implicit.
// ───────────────────────────────────────────────
const clients = clientsPool;            // scoped wrapper, see lib/userScope.js

// Per-user "active client name" backed by AsyncLocalStorage.
const _activeProxy = new Proxy({}, {});
// Use accessors instead of bare variable references — required because
// "active" is now per-user. We keep `activeName` and `discordClient`
// identifiers as no-op writable bindings so legacy code that *assigns*
// to them still parses, but reads route through the helpers below.
let activeName = null;                  // legacy mirror — DO NOT READ DIRECTLY
let discordClient = null;               // legacy mirror — DO NOT READ DIRECTLY
function _clearActive() { activeRef.set(null); }

function getActive() { return getActiveClient(); }
function getActiveClient() {
  const n = activeRef.get();
  if (!n) return null;
  const entry = clients.get(n);
  return entry ? entry.client : null;
}
function getClientByName(name) {
  const entry = clients.get(name);
  return entry ? entry.client : null;
}
// True when `userId` belongs to ANY of THIS USER's currently-connected accounts.
// Used to skip self-driven loops (mirror reactions, mention echoes…).
function isOwnConnectedUserId(userId) {
  if (!userId) return false;
  for (const e of clients.values()) {
    if (e?.client?.user?.id === userId) return true;
  }
  return false;
}
function setActive(name) {
  const entry = clients.get(name);
  if (!entry) return false;
  activeRef.set(name);
  return true;
}
// Helper: pick client from `?account=NAME` or `req.body.account`, fall back to active.
function pickClient(req) {
  const name = (req.query?.account || req.body?.account || '').trim();
  if (name) {
    const c = getClientByName(name);
    if (c) return c;
  }
  return getActiveClient();
}

// Default avatar fallback URL Discord uses (based on discriminator/index).
function defaultAvatarUrl(idOrIdx = 0) {
  const i = typeof idOrIdx === 'string' ? Number(BigInt(idOrIdx) >> 22n) % 6 : idOrIdx % 6;
  return `https://cdn.discordapp.com/embed/avatars/${i}.png`;
}

// ───────────────────────────────────────────────
// Anti-detection helpers
// ───────────────────────────────────────────────
function jitter(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Browser-like headers so axios calls blend in with the official Discord client.
// Used everywhere we hit the REST API directly (instead of going through
// discord.js-selfbot-v13). Reduces hCaptcha / Cloudflare detection signals.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9050 Chrome/124.0.6367.243 Electron/30.2.0 Safari/537.36';
const SUPER_PROPS_B64 = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
  client_version: '1.0.9050', os_version: '10.0.19045', os_arch: 'x64',
  app_arch: 'x64', system_locale: 'en-US', browser_user_agent: BROWSER_UA,
  browser_version: '30.2.0', client_build_number: 312855, native_build_number: 50890,
  client_event_source: null
})).toString('base64');
function discordHeaders(token, extra = {}) {
  return {
    'Authorization': token,
    'User-Agent': BROWSER_UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US',
    'Content-Type': 'application/json',
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'Etc/UTC',
    'X-Super-Properties': SUPER_PROPS_B64,
    'X-Debug-Options': 'bugReporterEnabled',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="124", "Discord Client";v="1"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Origin': 'https://discord.com',
    'Referer': 'https://discord.com/channels/@me',
    ...extra
  };
}

async function humanizedSend(channel, text, { typing = true } = {}) {
  if (typing && channel.sendTyping) {
    try {
      await channel.sendTyping();
      // typing speed ~ 4-7 chars/sec; cap at 4s
      const delay = Math.min(4000, Math.max(600, text.length * jitter(120, 200)));
      await sleep(delay);
    } catch (e) {}
  }
  return channel.send(text);
}

// Standardized error handler
function ok(res, payload = {}) { res.json({ success: true, ...payload }); }
function fail(res, err) {
  const msg = err?.response?.data?.message || err?.message || String(err);
  res.json({ success: false, error: msg });
}

// ───────────────────────────────────────────────
// Validation helpers (used by token save / bio / avatar)
// ───────────────────────────────────────────────
function isLikelyDiscordToken(t) {
  // Discord tokens are base64-ish, ~70+ chars, with two dots separating
  // header.payload.signature. Bot tokens start with `Bot ` typically.
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (s.length < 50 || s.length > 200) return false;
  // user tokens: 3-part dot-separated, payload ≈ snowflake base64
  return /^[A-Za-z0-9_\-.]{50,200}$/.test(s);
}
function dataUrlSizeBytes(dataUrl) {
  // returns approx decoded byte count for a base64 data: URL
  if (typeof dataUrl !== 'string') return 0;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return 0;
  const b64 = m[2];
  // base64 → bytes: floor(len*3/4) minus padding
  const pad = (b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0));
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
}
function dataUrlMime(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;]+);/);
  return m ? m[1].toLowerCase() : null;
}
const ALLOWED_AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const MAX_AVATAR_BYTES = 8 * 1024 * 1024; // Discord caps avatars at ~10MB; keep safety margin
const MAX_BANNER_BYTES = 10 * 1024 * 1024; // Discord caps banners at ~10MB
const MAX_BIO_LEN = 190;
const MAX_CUSTOM_STATUS_LEN = 128;

// ═══════════════════════════════════════════════
//  CONNECT / DISCONNECT (multi-token aware)
// ═══════════════════════════════════════════════

async function connectOne(token, name, proxy) {
  // Capture the owning user once so all derived listeners/timers can run
  // inside this user's AsyncLocalStorage scope.
  const ownerUid = currentUserId();
  const finalName = (name || `acc_${clients.size + 1}`).trim();
  if (clients.has(finalName)) {
    // disconnect previous before re-binding name
    try { await clients.get(finalName).client.destroy(); } catch (e) {}
    clients.delete(finalName);
  }
  const opts = { checkUpdate: false, fetchAllMembers: false };
  if (proxy) {
    try {
      const a = buildProxyAgents(proxy);
      if (a) {
        opts.http = { agent: a.http };
        opts.ws   = { agent: a.ws };
        console.log(`[proxy] ${finalName} → ${maskProxy(proxy)}`);
      }
    } catch (e) {
      throw new Error(`Proxy invalid for ${finalName}: ${e.message}`);
    }
  }
  const client = new Client(opts);
  await client.login(token);
  clients.set(finalName, { client, token, name: finalName, proxy: proxy || null, ownerUid });
  if (!activeRef.get()) setActive(finalName);
  // Auto-bind realtime listeners — wrapped so async events keep user scope.
  // Each attach* helper closes over the captured ownerUid via withUser() inside.
  try { if (typeof attachDMListener === 'function') attachDMListener(finalName, client, ownerUid); } catch (e) {}
  try { if (typeof attachMentionListener === 'function') attachMentionListener(finalName, client, ownerUid); } catch (e) {}
  try { if (typeof attachPicListener === 'function') attachPicListener(finalName, client, ownerUid); } catch (e) {}
  try { if (typeof attachAntiPruneListener === 'function') attachAntiPruneListener(finalName, client, ownerUid); } catch (e) {}
  try { if (typeof attachDMDeleteListener === 'function') attachDMDeleteListener(finalName, client, ownerUid); } catch (e) {}

  // ── Auto-rejoin voice sessions from previous run ──
  setTimeout(() => withUser(ownerUid, () => {
    try {
      const saved = loadVoicePersist();
      const mine  = saved.filter(s => s.name === finalName);
      for (const s of mine) {
        try {
          const shard = client.ws?.shards?.first?.() || client.ws?.shards?.get?.(0);
          if (!shard) continue;
          shard.send({ op: 4, d: { guild_id: s.guildId, channel_id: s.channelId, self_mute: !!s.selfMute, self_deaf: !!s.selfDeaf, self_video: !!s.selfVideo, self_stream: !!s.selfStream } });
          voiceSessions.set(voiceSessionKey(finalName, s.guildId), { ...s, joinedAt: Date.now() });
        } catch (e) { /* skip failed guild */ }
      }
    } catch (e) { /* non-fatal */ }
  }), 3000); // 3s delay — lets the WS connection fully stabilise before sending voice op

  return { name: finalName, username: client.user.tag, id: client.user.id };
}

app.post('/api/discord/connect', async (req, res) => {
  try {
    const { token, name, proxy } = req.body;
    const info = await connectOne(token, name, proxy);
    setActive(info.name);
    try { recordHistory({ account: info.name, type: 'connect', target: { username: info.username, id: info.id }, status: 'success' }); } catch (e) {}
    ok(res, { username: info.username, name: info.name, id: info.id });
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/disconnect', async (req, res) => {
  try {
    if (getActiveClient() && activeRef.get()) {
      const wasName = activeRef.get();
      try { await getActiveClient().destroy(); } catch (e) {}
      clients.delete(activeRef.get());
      activeRef.set(null);
      /* getActiveClient() cleared via activeRef */;
      // promote first remaining client
      const next = clients.keys().next().value;
      if (next) setActive(next);
      try { recordHistory({ account: wasName, type: 'disconnect', target: {}, status: 'success' }); } catch (e) {}
    }
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/disconnect-all', async (req, res) => {
  try {
    for (const [n, entry] of clients.entries()) {
      try { await entry.client.destroy(); } catch (e) {}
    }
    clients.clear();
    /* getActiveClient() cleared via activeRef */;
    activeRef.set(null);
    ok(res);
  } catch (e) { fail(res, e); }
});

app.get('/api/discord/clients', (req, res) => {
  const list = Array.from(clients.entries()).map(([name, e]) => ({
    name,
    username: e.client.user?.tag || null,
    displayName: e.client.user?.globalName || e.client.user?.username || null,
    id: e.client.user?.id || null,
    avatar: e.client.user?.displayAvatarURL?.() || null,
    status: e.client.user?.presence?.status || 'unknown',
    active: name === activeRef.get()
  }));
  ok(res, { clients: list, active: activeRef.get() });
});

app.post('/api/discord/active', (req, res) => {
  const { name } = req.body;
  if (setActive(name)) return ok(res, { active: activeRef.get() });
  fail(res, new Error('Client not found'));
});

// Auto-connect saved tokens that are flagged autoConnect — for ALL users.
// Each user's tokens are processed inside their own AsyncLocalStorage scope
// so per-user storage and the scoped client pool resolve correctly.
async function autoConnectSaved() {
  try {
    const ids = users.allUserIds();
    for (const uid of ids) {
      await runWithUser(uid, async () => {
        try {
          // Lazy migration of any plaintext-stored tokens for this user.
          migrateTokenEncryptionForCurrentUser();
          const tokens = readTokens();
          for (const t of tokens) {
            if (t.autoConnect) {
              try {
                await connectOne(t.token, t.name, t.proxy);
                console.log(`[auto-connect] ${uid}/${t.name} ✓`);
              } catch (e) {
                console.log(`[auto-connect] ${uid}/${t.name} ✗ ${e.message}`);
              }
            }
          }
        } catch (e) { /* per-user errors should not abort the loop */ }
      });
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════
//  FRIENDS
// ═══════════════════════════════════════════════
app.get('/api/discord/friends', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected to Discord'));
    const r = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: c.token }
    });
    const friends = r.data.filter(x => x.type === 1).map(f => ({
      id: f.user.id,
      username: f.user.username,
      displayName: f.user.global_name || f.user.username,
      avatar: f.user.avatar
        ? `https://cdn.discordapp.com/avatars/${f.user.id}/${f.user.avatar}.png?size=64`
        : defaultAvatarUrl(f.user.id),
      bot: !!f.user.bot
    }));
    ok(res, { friends });
  } catch (e) { fail(res, e); }
});

app.delete('/api/discord/friends/:friendId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    await axios.delete(`https://discord.com/api/v9/users/@me/relationships/${req.params.friendId}`, {
      headers: discordHeaders(c.token)
    });
    ok(res);
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  SERVERS
// ═══════════════════════════════════════════════
app.get('/api/discord/servers', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.guilds) return fail(res, new Error('Not connected'));
    // Owners need to manage their own servers too — filtering them out
    // hid them from the entire UI (Servers, Messages, Reactions, Clone…).
    const servers = Array.from(c.guilds.cache.values())
      .filter(s => !!s)
      .map(s => ({
        id: s.id,
        name: s.name,
        icon: s.iconURL({ size: 64, forceStatic: false }) || '/discord.png',
        members: s.memberCount || 0,
        owned: s.ownerId === c.user.id
      }));
    ok(res, { servers });
  } catch (e) { fail(res, e); }
});

app.get('/api/discord/servers/:serverId/channels', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const r = await axios.get(`https://discord.com/api/v9/guilds/${req.params.serverId}/channels`, {
      headers: discordHeaders(c.token)
    });
    const channels = r.data
      .filter(ch => ch.type === 0 || ch.type === 5) // text + announcement
      .map(ch => ({ id: ch.id, name: ch.name, parent: ch.parent_id }));
    ok(res, { channels });
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/servers/:serverId/leave', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.guilds) return fail(res, new Error('Not connected'));
    const guild = c.guilds.cache.get(req.params.serverId);
    if (!guild) return fail(res, new Error('Server not found'));
    await guild.leave();
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/servers/:serverId/mute', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${req.params.serverId}/settings`,
      { muted: true },
      { headers: discordHeaders(c.token) });
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/servers/:serverId/unmute', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${req.params.serverId}/settings`,
      { muted: false },
      { headers: discordHeaders(c.token) });
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/read-all', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const guilds = Array.from(c.guilds.cache.values());
    for (const g of guilds) { try { await g.markAsRead(); } catch (e) {} }
    ok(res);
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  DMs
// ═══════════════════════════════════════════════
app.get('/api/discord/dms', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const botsOnly = req.query.botsOnly === 'true' || req.query.botsOnly === '1';
    const list = Array.from(c.channels.cache.values())
      .filter(ch => ch.type === 'DM' && ch.recipient)
      .filter(ch => !botsOnly || !!ch.recipient?.bot);
    const dms = list.map(d => {
      const r = d.recipient;
      const av = r?.displayAvatarURL?.({ size: 64, forceStatic: false })
              || r?.avatarURL?.({ size: 64 })
              || defaultAvatarUrl(r?.id || '0');
      return {
        id: d.id,
        userId: r?.id || '',
        username: r?.username || 'Unknown',
        displayName: r?.globalName || r?.username || 'Unknown',
        avatar: av,
        bot: !!r?.bot
      };
    });
    ok(res, { dms });
  } catch (e) { fail(res, e); }
});

app.get('/api/discord/dms/:channelId/messages', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const channel = await c.channels.fetch(req.params.channelId);
    if (!channel || channel.type !== 'DM') return fail(res, new Error('Invalid DM channel'));
    const { before } = req.query;
    const opts = before ? { before, limit: 100 } : { limit: 100 };
    const msgs = await channel.messages.fetch(opts);
    res.json({
      success: true,
      currentUserId: c.user.id,
      messages: Array.from(msgs.values()).map(m => ({
        id: m.id,
        content: m.content,
        isDeletable: m.author.id === c.user.id && !m.system,
        author: { id: m.author.id }
      }))
    });
  } catch (e) { fail(res, e); }
});

app.delete('/api/discord/dms/:channelId/messages/:messageId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const channel = await c.channels.fetch(req.params.channelId);
    if (!channel || channel.type !== 'DM') return fail(res, new Error('Invalid DM channel'));
    const m = await channel.messages.fetch(req.params.messageId);
    await m.delete();
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/dms/:channelId/close', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const channel = await c.channels.fetch(req.params.channelId);
    if (!channel || channel.type !== 'DM') return fail(res, new Error('Invalid DM channel'));
    await channel.delete();
    ok(res);
  } catch (e) { fail(res, e); }
});

// Open (or find) a DM channel with a user by their userId
app.post('/api/discord/dm/open', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const { userId } = req.body || {};
    if (!userId) return fail(res, new Error('userId required'));
    const user = await c.users.fetch(userId);
    const dm = await user.createDM();
    ok(res, { channelId: dm.id, userId: user.id, username: user.username });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  GROUPS
// ═══════════════════════════════════════════════
app.get('/api/discord/groups', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const groups = Array.from(c.channels.cache.values())
      .filter(ch => ch.type === 'GROUP_DM')
      .map(g => {
        // Generate fallback avatar from recipient names
        const firstNames = Array.from(g.recipients?.values?.() || [])
          .slice(0, 3).map(u => (u.username || '?')[0].toUpperCase()).join('');
        return {
          id: g.id,
          name: g.name || (Array.from(g.recipients?.values?.() || [])
            .slice(0, 3).map(u => u.username).join(', ') || 'Group'),
          icon: g.iconURL?.({ size: 64, forceStatic: false }) || null,
          fallback: firstNames || 'G',
          recipients: g.recipients?.size || 0
        };
      });
    ok(res, { groups });
  } catch (e) { fail(res, e); }
});

app.post('/api/discord/groups/:groupId/leave', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const g = await c.channels.fetch(req.params.groupId);
    if (!g || g.type !== 'GROUP_DM') return fail(res, new Error('Invalid group'));
    await g.delete();
    ok(res);
  } catch (e) { fail(res, e); }
});

app.get('/api/discord/groups/:channelId/messages', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const { before } = req.query;
    const url = `https://discord.com/api/v9/channels/${req.params.channelId}/messages?limit=100${before ? `&before=${before}` : ''}`;
    const r = await axios.get(url, {
      headers: discordHeaders(c.token)
    });
    res.json({
      success: true,
      currentUserId: c.user.id,
      messages: r.data.map(m => ({ id: m.id, content: m.content, author: { id: m.author.id } }))
    });
  } catch (e) { fail(res, e); }
});

app.delete('/api/discord/groups/:channelId/messages/:messageId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    await axios.delete(`https://discord.com/api/v9/channels/${req.params.channelId}/messages/${req.params.messageId}`, {
      headers: discordHeaders(c.token)
    });
    ok(res);
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  TOKEN STORAGE (saved tokens with autoConnect)
//  Tokens are encrypted at rest with AES-256-GCM via lib/crypto.js.
//  readTokens()  → decrypted in-memory copies (safe for internal use)
//  writeTokens() → encrypts before persisting
// ═══════════════════════════════════════════════
function readTokens() {
  const raw = tokensStore.read() || [];
  return raw.map(t => ({
    ...t,
    token: t?.token ? (tryDecrypt(t.token) ?? t.token) : t?.token,
    proxy: t?.proxy ? (tryDecrypt(t.proxy) ?? t.proxy) : (t?.proxy || null),
  }));
}
function writeTokens(arr) {
  const encrypted = (arr || []).map(t => ({
    ...t,
    token: t?.token ? (isEncrypted(t.token) ? t.token : encrypt(t.token)) : t?.token,
    proxy: t?.proxy ? (isEncrypted(t.proxy) ? t.proxy : encrypt(t.proxy)) : (t?.proxy || null),
  }));
  tokensStore.write(encrypted);
}

// One-shot migration runs lazily, the first time a user touches their
// own tokens store. With per-user storage the migration is per-user and
// idempotent (encrypted entries are left alone).
function migrateTokenEncryptionForCurrentUser() {
  try {
    const raw = tokensStore.read() || [];
    const needsMigration = raw.some(t => t?.token && !isEncrypted(t.token));
    if (!needsMigration) return;
    const re = raw.map(t => ({
      ...t,
      token: t?.token && !isEncrypted(t.token) ? encrypt(t.token) : t?.token,
    }));
    tokensStore.write(re);
    console.log(`[security] migrated ${raw.length} saved token(s) to encrypted storage`);
  } catch (e) {
    console.warn('[security] token migration failed:', e.message);
  }
}

app.get('/api/tokens', (req, res) => {
  try {
    const tokens = readTokens();
    // Mark which are connected; mask proxy URL so credentials never reach the UI.
    const enriched = tokens.map(t => ({
      ...t,
      connected: clients.has(t.name),
      proxy: t.proxy ? maskProxy(t.proxy) : null,
      hasProxy: !!t.proxy,
    }));
    ok(res, { tokens: enriched });
  } catch (e) { fail(res, e); }
});

app.post('/api/tokens', (req, res) => {
  try {
    const { name, token, autoConnect = false, proxy } = req.body;
    const cleanName = String(name || '').trim();
    const cleanToken = String(token || '').trim();
    const cleanProxy = (proxy ?? '').toString().trim() || null;
    if (!cleanName) return fail(res, new Error('Name is required'));
    if (cleanName.length > 64) return fail(res, new Error('Name is too long (max 64 chars)'));
    if (!cleanToken) return fail(res, new Error('Token is required'));
    if (!isLikelyDiscordToken(cleanToken)) {
      return fail(res, new Error('Token does not look like a valid Discord token. Re-copy it from your client/devtools.'));
    }
    if (cleanProxy) {
      try { buildProxyAgents(cleanProxy); }
      catch (e) { return fail(res, new Error('Invalid proxy: ' + e.message)); }
    }
    const tokens = readTokens();
    if (tokens.some(t => t.name === cleanName)) {
      return fail(res, new Error('A token with this name already exists'));
    }
    if (tokens.some(t => t.token === cleanToken)) {
      const dupe = tokens.find(t => t.token === cleanToken);
      return fail(res, new Error(`This token is already saved under "${dupe.name}". Delete the duplicate first.`));
    }
    tokens.push({ name: cleanName, token: cleanToken, autoConnect: !!autoConnect, proxy: cleanProxy });
    writeTokens(tokens);
    try { recordHistory({ account: cleanName, type: 'save_token', target: { name: cleanName }, status: 'success' }); } catch (e) {}
    ok(res);
  } catch (e) { fail(res, e); }
});

app.patch('/api/tokens/:name', (req, res) => {
  try {
    const tokens = readTokens();
    const idx = tokens.findIndex(t => t.name === req.params.name);
    if (idx === -1) return fail(res, new Error('Token not found'));
    tokens[idx] = { ...tokens[idx], ...req.body };
    writeTokens(tokens);
    ok(res);
  } catch (e) { fail(res, e); }
});

app.delete('/api/tokens/:name', (req, res) => {
  try {
    const tokens = readTokens().filter(t => t.name !== req.params.name);
    writeTokens(tokens);
    try { recordHistory({ account: req.params.name, type: 'delete_token', target: { name: req.params.name }, status: 'success' }); } catch (e) {}
    ok(res);
  } catch (e) { fail(res, e); }
});

// Connect a saved token (without putting it as the active one if there is one already)
app.post('/api/tokens/:name/connect', async (req, res) => {
  try {
    const t = readTokens().find(x => x.name === req.params.name);
    if (!t) return fail(res, new Error('Token not found'));
    const info = await connectOne(t.token, t.name, t.proxy);
    try { recordHistory({ account: info.name, type: 'connect', target: { username: info.username, id: info.id }, status: 'success' }); } catch (e) {}
    ok(res, info);
  } catch (e) { fail(res, e); }
});

// ── Proxy management for a saved account
// If the account is currently connected, transparently reconnect through the
// new proxy so the user does not need to manually disconnect/reconnect.
app.put('/api/tokens/:name/proxy', async (req, res) => {
  try {
    const tokens = readTokens();
    const idx = tokens.findIndex(t => t.name === req.params.name);
    if (idx === -1) return fail(res, new Error('Token not found'));
    const raw = (req.body?.proxy ?? '').toString().trim();
    if (raw) {
      // Validate by attempting to build the agents (throws on bad URL/scheme).
      try { buildProxyAgents(raw); }
      catch (e) { return fail(res, new Error('Invalid proxy: ' + e.message)); }
      tokens[idx].proxy = raw;
    } else {
      tokens[idx].proxy = null;
    }
    writeTokens(tokens);

    // ── Auto-reconnect if the account is currently connected ──
    let reconnected = false;
    const entry = clients.get(req.params.name);
    if (entry?.client) {
      const wasActive = activeRef.get() === req.params.name;
      try { await entry.client.destroy(); } catch (e) {}
      clients.delete(req.params.name);
      try {
        const decryptedToken = isEncrypted(tokens[idx].token) ? decrypt(tokens[idx].token) : tokens[idx].token;
        await connectOne(decryptedToken, tokens[idx].name, tokens[idx].proxy);
        if (wasActive) setActive(tokens[idx].name);
        reconnected = true;
      } catch (e) {
        console.warn(`[proxy] auto-reconnect failed for ${tokens[idx].name}: ${e.message}`);
      }
    }
    ok(res, {
      proxy: tokens[idx].proxy ? maskProxy(tokens[idx].proxy) : null,
      reconnected,
    });
  } catch (e) { fail(res, e); }
});

app.post('/api/tokens/:name/proxy/test', async (req, res) => {
  try {
    // Allow ad-hoc test (body.proxy) OR test the currently-saved one.
    let raw = (req.body?.proxy ?? '').toString().trim();
    if (!raw) {
      const t = readTokens().find(x => x.name === req.params.name);
      if (!t || !t.proxy) return fail(res, new Error('No proxy set for this account'));
      raw = t.proxy;
    }
    const r = await testProxy(raw);
    ok(res, { ok: true, ip: r.ip, masked: maskProxy(raw) });
  } catch (e) { fail(res, e); }
});

app.post('/api/tokens/:name/disconnect', async (req, res) => {
  try {
    const entry = clients.get(req.params.name);
    if (!entry) return fail(res, new Error('Not connected'));
    try { await entry.client.destroy(); } catch (e) {}
    clients.delete(req.params.name);
    if (activeName === req.params.name) {
      activeRef.set(null);
      /* getActiveClient() cleared via activeRef */;
      const next = clients.keys().next().value;
      if (next) setActive(next);
    }
    try { recordHistory({ account: req.params.name, type: 'disconnect', target: {}, status: 'success' }); } catch (e) {}
    ok(res);
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  PRESENCE / STATUS / BIO
// ═══════════════════════════════════════════════
const statusRotations = new Map();   // name -> intervalId

function resolvePresence(s) {
  const v = String(s || '').toLowerCase();
  if (['online','idle','dnd','invisible','offline'].includes(v)) return v === 'offline' ? 'invisible' : v;
  return 'online';
}

app.post('/api/presence/set', async (req, res) => {
  try {
    const { tokens = [], status, customStatus, activity, emoji } = req.body;
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    const results = [];
    for (const n of targets) {
      const c = getClientByName(n);
      if (!c) { results.push({ name: n, ok: false, error: 'not connected' }); continue; }
      try {
        if (status) c.user.setStatus(resolvePresence(status));
        if (customStatus !== undefined) {
          const cs = new CustomStatus(c).setState(customStatus || null);
          if (emoji) cs.setEmoji(emoji);
          c.user.setActivity(cs.toJSON ? cs.toJSON() : cs);
        }
        if (activity) {
          // activity: { name, type, url? } - 0 playing, 1 streaming, 2 listening, 3 watching, 5 competing
          const opts = { type: activity.type || 0 };
          if (activity.url) opts.url = activity.url;
          c.user.setActivity(activity.name, opts);
        }
        results.push({ name: n, ok: true });
      } catch (e) { results.push({ name: n, ok: false, error: e.message }); }
    }
    ok(res, { results });
  } catch (e) { fail(res, e); }
});

app.post('/api/presence/bio', async (req, res) => {
  try {
    const { tokens = [], bio = '' } = req.body;
    // Discord rejects bios > 190 chars with a 400 — surface a clean error early
    if (typeof bio !== 'string') return fail(res, new Error('Bio must be a string'));
    if (bio.length > MAX_BIO_LEN) {
      return fail(res, new Error(`Bio is too long: ${bio.length}/${MAX_BIO_LEN} chars. Discord rejects anything longer.`));
    }
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    const results = [];
    for (const n of targets) {
      const entry = clients.get(n);
      if (!entry) { results.push({ name: n, ok: false, error: 'not connected' }); continue; }
      try {
        await axios.patch('https://discord.com/api/v9/users/@me/profile',
          { bio },
          { headers: discordHeaders(entry.client.token) });
        results.push({ name: n, ok: true });
      } catch (e) { results.push({ name: n, ok: false, error: e.response?.data?.message || e.message }); }
      await sleep(jitter(300, 800));
    }
    ok(res, { results });
  } catch (e) { fail(res, e); }
});

// Status rotation — PERSISTED so it survives restarts
function _persistRotations() {
  try {
    const d = readData();
    const out = {};
    for (const [n, info] of statusRotations.entries()) {
      // info may be either the legacy timer id (number) or the new {timer, states, intervalMs} shape
      if (info && info.states) out[n] = { states: info.states, intervalMs: info.intervalMs };
    }
    d.statusRotations = out;
    writeData(d);
  } catch (_) {}
}
function _startRotationFor(n, states, intervalMs) {
  const old = statusRotations.get(n);
  if (old?.timer) clearInterval(old.timer);
  let i = 0;
  const tick = async () => {
    const c = getClientByName(n);
    if (!c) return;
    const s = states[i % states.length]; i++;
    try {
      if (s.status) c.user.setStatus(resolvePresence(s.status));
      if (s.customStatus !== undefined) {
        const cs = new CustomStatus(c).setState(s.customStatus || null);
        if (s.emoji) cs.setEmoji(s.emoji);
        c.user.setActivity(cs.toJSON ? cs.toJSON() : cs);
      }
    } catch (e) {}
  };
  tick();
  const safe = Math.max(15000, intervalMs); // min 15s to be safe
  const timer = setInterval(tick, safe);
  statusRotations.set(n, { timer, states, intervalMs: safe });
}
app.post('/api/presence/rotate/start', (req, res) => {
  try {
    const { tokens = [], states = [], intervalMs = 60000 } = req.body;
    if (!states.length) return fail(res, new Error('No states provided'));
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    for (const n of targets) _startRotationFor(n, states, intervalMs);
    _persistRotations();
    ok(res, { rotating: targets });
  } catch (e) { fail(res, e); }
});

app.post('/api/presence/rotate/stop', (req, res) => {
  try {
    const { tokens = [] } = req.body;
    const targets = (tokens.length ? tokens : Array.from(statusRotations.keys()));
    for (const n of targets) {
      const info = statusRotations.get(n);
      if (info?.timer) { clearInterval(info.timer); }
      statusRotations.delete(n);
    }
    _persistRotations();
    ok(res, { stopped: targets });
  } catch (e) { fail(res, e); }
});

// Restore rotations after clients connect (give autoConnect a head start)
setTimeout(() => {
  try {
    const d = readData();
    const r = d.statusRotations || {};
    let restored = 0;
    for (const [name, info] of Object.entries(r)) {
      if (!info?.states?.length) continue;
      _startRotationFor(name, info.states, info.intervalMs || 60000);
      restored++;
    }
    if (restored) console.log(`[rotation] restored ${restored} status rotation(s)`);
  } catch (_) {}
}, 12000);

// ── Avatar update (single or many tokens)
app.post('/api/presence/avatar', async (req, res) => {
  try {
    const { tokens = [], avatar } = req.body; // avatar = data URL or http URL
    if (!avatar) return fail(res, new Error('No avatar provided'));
    // Validate format + size for data URLs (URLs are passed through as-is)
    if (typeof avatar === 'string' && avatar.startsWith('data:')) {
      const mime = dataUrlMime(avatar);
      if (!mime || !ALLOWED_AVATAR_MIMES.includes(mime)) {
        return fail(res, new Error(`Unsupported image type "${mime || 'unknown'}". Use PNG, JPG, GIF, or WebP.`));
      }
      const sz = dataUrlSizeBytes(avatar);
      if (sz <= 0) return fail(res, new Error('Could not read image data — re-upload the file.'));
      if (sz > MAX_AVATAR_BYTES) {
        return fail(res, new Error(`Image is too large: ${(sz / (1024*1024)).toFixed(2)} MB. Max ${(MAX_AVATAR_BYTES/(1024*1024)).toFixed(0)} MB.`));
      }
    }
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    const results = [];
    for (const n of targets) {
      const c = getClientByName(n);
      if (!c) { results.push({ name: n, ok: false, error: 'not connected' }); continue; }
      try {
        await c.user.setAvatar(avatar);
        results.push({ name: n, ok: true });
      } catch (e) {
        results.push({ name: n, ok: false, error: e.message });
      }
      await sleep(jitter(400, 1000));
    }
    ok(res, { results });
  } catch (e) { fail(res, e); }
});

// ── Banner update (Nitro required by Discord)
app.post('/api/presence/banner', async (req, res) => {
  try {
    const { tokens = [], banner } = req.body; // banner = data URL (data:image/...;base64,...) or null to remove
    // Validate format + size for data URLs (URLs and null are passed through as-is)
    if (typeof banner === 'string' && banner.startsWith('data:')) {
      const mime = dataUrlMime(banner);
      if (!mime || !ALLOWED_AVATAR_MIMES.includes(mime)) {
        return fail(res, new Error(`Unsupported image type "${mime || 'unknown'}". Use PNG, JPG, GIF, or WebP.`));
      }
      const sz = dataUrlSizeBytes(banner);
      if (sz <= 0) return fail(res, new Error('Could not read image data — re-upload the file.'));
      if (sz > MAX_BANNER_BYTES) {
        return fail(res, new Error(`Banner is too large: ${(sz / (1024*1024)).toFixed(2)} MB. Max ${(MAX_BANNER_BYTES/(1024*1024)).toFixed(0)} MB.`));
      }
    }
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    const results = [];
    for (const n of targets) {
      const entry = clients.get(n);
      if (!entry) { results.push({ name: n, ok: false, error: 'not connected' }); continue; }
      try {
        await axios.patch('https://discord.com/api/v9/users/@me',
          { banner: banner || null },
          { headers: discordHeaders(entry.client.token) });
        results.push({ name: n, ok: true });
      } catch (e) {
        const msg = e.response?.data?.message || e.message;
        const detail = e.response?.data?.errors?.banner?._errors?.[0]?.message;
        results.push({ name: n, ok: false, error: detail || msg });
      }
      await sleep(jitter(400, 1000));
    }
    ok(res, { results });
  } catch (e) { fail(res, e); }
});

// ── Human-like activity simulator (online ↔ idle ↔ invisible at random intervals)
// Persisted across restarts — tracking "running" matters because users start
// it and forget; a server reboot would silently leave their accounts stuck on
// whatever status they had.
const activitySims = new Map(); // name -> { timer, modes, minMs, maxMs }
function _persistActivitySims() {
  try {
    const d = readData();
    const out = {};
    for (const [n, info] of activitySims.entries()) {
      if (info?.modes) out[n] = { modes: info.modes, minMs: info.minMs, maxMs: info.maxMs };
    }
    d.activitySims = out;
    writeData(d);
  } catch (_) {}
}
function _scheduleNextCycle(name, modes, minMs, maxMs) {
  const c = getClientByName(name);
  if (!c) return;
  const next = jitter(minMs, maxMs);
  const id = setTimeout(() => {
    try {
      const cur = c.user.presence?.status || 'online';
      const choices = modes.filter(m => m !== cur);
      const pick = choices.length ? choices[Math.floor(Math.random() * choices.length)] : modes[0];
      c.user.setStatus(resolvePresence(pick));
    } catch (e) {}
    _scheduleNextCycle(name, modes, minMs, maxMs);
  }, next);
  const info = activitySims.get(name) || {};
  activitySims.set(name, { ...info, timer: id, modes, minMs, maxMs });
}

app.post('/api/presence/activity/start', (req, res) => {
  try {
    const { tokens = [], modes = ['online','idle','invisible'], minSec = 60, maxSec = 600 } = req.body;
    const minMs = Math.max(15, parseInt(minSec)) * 1000;
    const maxMs = Math.max(minMs + 1000, parseInt(maxSec) * 1000);
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    for (const n of targets) {
      const old = activitySims.get(n);
      if (old?.timer) clearTimeout(old.timer);
      _scheduleNextCycle(n, modes, minMs, maxMs);
    }
    _persistActivitySims();
    ok(res, { simulating: targets });
  } catch (e) { fail(res, e); }
});

app.post('/api/presence/activity/stop', (req, res) => {
  try {
    const { tokens = [] } = req.body;
    const targets = (tokens.length ? tokens : Array.from(activitySims.keys()));
    for (const n of targets) {
      const info = activitySims.get(n);
      if (info?.timer) clearTimeout(info.timer);
      activitySims.delete(n);
    }
    _persistActivitySims();
    ok(res, { stopped: targets });
  } catch (e) { fail(res, e); }
});

app.get('/api/presence/activity/list', (req, res) => {
  ok(res, { running: Array.from(activitySims.keys()) });
});

// Restore activity simulators after clients reconnect (give autoConnect time)
setTimeout(() => {
  try {
    const d = readData();
    const r = d.activitySims || {};
    let restored = 0;
    for (const [name, info] of Object.entries(r)) {
      if (!info?.modes?.length) continue;
      _scheduleNextCycle(name, info.modes, info.minMs || 60000, info.maxMs || 600000);
      restored++;
    }
    if (restored) console.log(`[activity] restored ${restored} simulator(s)`);
  } catch (_) {}
}, 12000);

// ═══════════════════════════════════════════════
//  MESSAGES MANAGER (send / repeat / schedule)
// ═══════════════════════════════════════════════
const messageJobs = new Map(); // jobId -> { type, timer, info }
let jobCounter = 1;

// Persisted scheduled jobs survive restarts. Repeating jobs are NOT persisted
// because they would silently keep running after a crash without the user
// knowing — schedules are one-shots so we know exactly when they should fire.
function _persistSchedules() {
  try {
    const d = readData();
    const out = {};
    for (const [id, j] of messageJobs.entries()) {
      if (j.type === 'schedule') out[id] = { info: j.info };
    }
    d.scheduledJobs = out;
    writeData(d);
  } catch (_) {}
}
function _restoreSchedules() {
  try {
    const d = readData();
    const sj = d.scheduledJobs || {};
    let restored = 0, expired = 0;
    for (const [id, j] of Object.entries(sj)) {
      const info = j.info;
      if (!info?.runAt) continue;
      const ms = new Date(info.runAt).getTime() - Date.now();
      if (ms < 0) { expired++; continue; }
      // Re-create the timer on this fresh process
      const timer = setTimeout(async () => {
        try {
          await executeSend({ tokens: info.tokens, scope: info.scope, messages: info.messages, mode: info.mode });
        } catch (_) {}
        messageJobs.delete(id);
        _persistSchedules();
      }, ms);
      messageJobs.set(id, { type: 'schedule', timer, info });
      // Keep id-counter ahead of restored ids so new ones don't collide
      const n = parseInt(id, 10);
      if (Number.isFinite(n) && n >= jobCounter) jobCounter = n + 1;
      restored++;
    }
    if (restored || expired) console.log(`[schedule] restored ${restored}, dropped ${expired} expired`);
    if (expired) _persistSchedules();
  } catch (_) {}
}
// Run once at startup (clients may not be ready yet but executeSend handles that)
setTimeout(_restoreSchedules, 5000);

async function resolveTargets(client, scope) {
  // scope: { type: 'channel'|'all_channels'|'all_dms'|'all_groups', serverId?, channelIds?[] }
  if (!client) return [];
  const out = [];
  if (scope.type === 'channel' && scope.channelIds?.length) {
    for (const id of scope.channelIds) {
      try { out.push(await client.channels.fetch(id)); } catch (e) {}
    }
  } else if (scope.type === 'all_channels' && scope.serverId) {
    try {
      const r = await axios.get(`https://discord.com/api/v9/guilds/${scope.serverId}/channels`, {
        headers: { Authorization: client.token }
      });
      const ids = r.data.filter(c => c.type === 0 || c.type === 5).map(c => c.id);
      for (const id of ids) {
        try { out.push(await client.channels.fetch(id)); } catch (e) {}
      }
    } catch (e) {}
  } else if (scope.type === 'all_dms') {
    out.push(...Array.from(client.channels.cache.values()).filter(c => c.type === 'DM'));
  } else if (scope.type === 'all_groups') {
    out.push(...Array.from(client.channels.cache.values()).filter(c => c.type === 'GROUP_DM'));
  }
  return out.filter(Boolean);
}

async function executeSend({ tokens, scope, messages, mode }) {
  // mode: { type: 'fast'|'natural', perMessageDelayMs?, betweenMessagesMs? }
  const targets = (tokens?.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
  const results = [];
  for (const tName of targets) {
    const client = getClientByName(tName);
    if (!client) { results.push({ token: tName, ok: false, error: 'not connected' }); continue; }
    const channels = await resolveTargets(client, scope);
    for (const ch of channels) {
      for (const text of messages) {
        try {
          if (mode?.type === 'natural') {
            await humanizedSend(ch, text);
          } else {
            await ch.send(text);
          }
          results.push({ token: tName, channel: ch.id, ok: true });
        } catch (e) {
          results.push({ token: tName, channel: ch.id, ok: false, error: e.message });
        }
        // gap between messages (faster default while still staying polite)
        const gap = mode?.type === 'natural'
          ? jitter(1100, 2600)
          : (mode?.perMessageDelayMs ?? 500);
        await sleep(gap);
      }
      // gap between channels
      await sleep(jitter(400, 900));
    }
  }
  return results;
}

app.post('/api/messages/send', async (req, res) => {
  try {
    const { tokens = [], scope, messages = [], mode = { type: 'natural' } } = req.body;
    if (!scope || !messages.length) return fail(res, new Error('scope and messages required'));
    const results = await executeSend({ tokens, scope, messages, mode });
    const targets = (tokens?.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    for (const tn of targets) {
      const tr = results.filter(r => r.token === tn);
      recordHistory({
        account: tn, type: 'send', target: scope,
        messages: messages.length, channels: new Set(tr.map(r => r.channel)).size,
        status: tr.length === 0 ? 'failed' : (tr.every(r => r.ok) ? 'success' : (tr.some(r => r.ok) ? 'partial' : 'failed')),
        ok: tr.filter(r => r.ok).length,
        fail: tr.filter(r => !r.ok).length,
        error: tr.find(r => !r.ok)?.error || null
      });
    }
    ok(res, { results });
  } catch (e) { fail(res, e); }
});

app.post('/api/messages/repeat/start', (req, res) => {
  try {
    const { tokens = [], scope, messages = [], mode = { type: 'natural' }, intervalMs = 60000, count = 0 } = req.body;
    if (!scope || !messages.length) return fail(res, new Error('scope and messages required'));
    const id = String(jobCounter++);
    let runs = 0;
    const tick = async () => {
      runs++;
      try { await executeSend({ tokens, scope, messages, mode }); } catch (e) {}
      if (count > 0 && runs >= count) {
        const job = messageJobs.get(id);
        if (job?.timer) clearInterval(job.timer);
        messageJobs.delete(id);
      }
    };
    tick();
    const timer = setInterval(tick, Math.max(2000, intervalMs));
    messageJobs.set(id, { type: 'repeat', timer, info: { tokens, scope, messages, mode, intervalMs, count } });
    ok(res, { jobId: id });
  } catch (e) { fail(res, e); }
});

app.post('/api/messages/schedule', (req, res) => {
  try {
    const { tokens = [], scope, messages = [], mode = { type: 'natural' }, runAt } = req.body;
    if (!scope || !messages.length || !runAt) return fail(res, new Error('scope, messages, runAt required'));
    const ms = new Date(runAt).getTime() - Date.now();
    if (ms < 0) return fail(res, new Error('runAt is in the past'));
    const id = String(jobCounter++);
    const targets = (tokens?.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    for (const tn of targets) {
      recordHistory({ account: tn, type: 'schedule', target: scope, messages: messages.length, status: 'pending', runAt });
    }
    const timer = setTimeout(async () => {
      try {
        const r = await executeSend({ tokens, scope, messages, mode });
        for (const tn of targets) {
          const tr = r.filter(x => x.token === tn);
          recordHistory({
            account: tn, type: 'schedule_run', target: scope, messages: messages.length,
            status: tr.length === 0 ? 'failed' : (tr.every(x => x.ok) ? 'success' : (tr.some(x => x.ok) ? 'partial' : 'failed')),
            ok: tr.filter(x => x.ok).length, fail: tr.filter(x => !x.ok).length
          });
        }
      } catch (e) {}
      messageJobs.delete(id);
      _persistSchedules();
    }, ms);
    messageJobs.set(id, { type: 'schedule', timer, info: { tokens, scope, messages, mode, runAt } });
    _persistSchedules();
    ok(res, { jobId: id, runIn: ms });
  } catch (e) { fail(res, e); }
});

app.get('/api/messages/jobs', (req, res) => {
  const list = Array.from(messageJobs.entries()).map(([id, j]) => ({
    id, type: j.type, info: j.info
  }));
  ok(res, { jobs: list });
});

app.post('/api/messages/jobs/:id/stop', (req, res) => {
  const job = messageJobs.get(req.params.id);
  if (!job) return fail(res, new Error('Job not found'));
  if (job.timer) {
    if (job.type === 'repeat') clearInterval(job.timer);
    else clearTimeout(job.timer);
  }
  messageJobs.delete(req.params.id);
  if (job.type === 'schedule') _persistSchedules();
  ok(res);
});

// ═══════════════════════════════════════════════
//  REACTION MANAGER (auto-react / auto-button)
// ═══════════════════════════════════════════════
// One handler per (token, scope) combo
const reactionListeners = new Map(); // listenerId -> { tokens, dispose }

function scopeMatches(scope, msg) {
  if (scope.type === 'all') return true;
  if (scope.type === 'server' && msg.guild?.id === scope.id) return true;
  if (scope.type === 'group' && msg.channel?.type === 'GROUP_DM' && msg.channel.id === scope.id) return true;
  if (scope.type === 'dm' && msg.channel?.type === 'DM' && msg.channel.id === scope.id) return true;
  if (scope.type === 'all_dms' && msg.channel?.type === 'DM') return true;
  if (scope.type === 'all_groups' && msg.channel?.type === 'GROUP_DM') return true;
  if (scope.type === 'all_servers' && msg.guild) return true;
  return false;
}

function attachReactionListener({ tokens, scope, mode, emojis = [], buttonNames = [] }) {
  // mode: 'mirror' | 'specific' (mirror => react with whatever emoji someone else used; specific => use given emojis)
  const id = String(jobCounter++);
  const handlers = [];

  for (const tName of tokens) {
    const c = getClientByName(tName);
    if (!c) continue;

    // Auto-react on new messages
    const onMessage = async (msg) => {
      try {
        if (msg.author?.id === c.user.id) return;
        // Don't auto-react to messages from any of OUR connected accounts
        // (otherwise mirror mode creates a self-reinforcing loop)
        if (isOwnConnectedUserId(msg.author?.id)) return;
        if (!scopeMatches(scope, msg)) return;

        if (mode === 'specific' && emojis.length) {
          for (const em of emojis) {
            try { await msg.react(em); } catch (e) {}
            await sleep(jitter(300, 700));
          }
        }

        // Auto-click buttons — exact label match (case-insensitive, trimmed)
        // to avoid clicking unrelated buttons that happen to contain the keyword
        if (buttonNames.length && msg.components?.length) {
          const wanted = buttonNames.map(n => String(n).trim().toLowerCase()).filter(Boolean);
          for (const row of msg.components) {
            for (const comp of row.components || []) {
              const label = String(comp.label || '').trim().toLowerCase();
              if (label && wanted.includes(label)) {
                try {
                  if (typeof comp.click === 'function') await comp.click(msg);
                } catch (e) {}
                await sleep(jitter(400, 900));
              }
            }
          }
        }
      } catch (e) {}
    };

    // Mirror reactions when others react
    const onReactionAdd = async (reaction, user) => {
      try {
        if (user.id === c.user.id) return;
        // Skip if reactor is one of OUR connected accounts → prevents
        // ping-pong between two accounts watching the same channel.
        if (isOwnConnectedUserId(user.id)) return;
        if (!scopeMatches(scope, reaction.message)) return;
        if (mode === 'mirror') {
          const em = reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name;
          try { await reaction.message.react(em); } catch (e) {}
        }
      } catch (e) {}
    };

    c.on('messageCreate', onMessage);
    c.on('messageReactionAdd', onReactionAdd);
    handlers.push({ client: c, onMessage, onReactionAdd });
  }

  reactionListeners.set(id, {
    tokens, scope, mode, emojis, buttonNames,
    dispose: () => {
      for (const h of handlers) {
        h.client.off('messageCreate', h.onMessage);
        h.client.off('messageReactionAdd', h.onReactionAdd);
      }
    }
  });
  return id;
}

app.post('/api/reactions/start', (req, res) => {
  try {
    const { tokens = [], scope, mode = 'mirror', emojis = [], buttonNames = [] } = req.body;
    if (!scope) return fail(res, new Error('scope required'));
    const targets = (tokens.length ? tokens : (activeRef.get() ? [activeRef.get()] : []));
    const id = attachReactionListener({ tokens: targets, scope, mode, emojis, buttonNames });
    ok(res, { listenerId: id });
  } catch (e) { fail(res, e); }
});

app.get('/api/reactions/list', (req, res) => {
  const list = Array.from(reactionListeners.entries()).map(([id, l]) => ({
    id, tokens: l.tokens, scope: l.scope, mode: l.mode, emojis: l.emojis, buttonNames: l.buttonNames
  }));
  ok(res, { listeners: list });
});

app.post('/api/reactions/:id/stop', (req, res) => {
  const l = reactionListeners.get(req.params.id);
  if (!l) return fail(res, new Error('Listener not found'));
  l.dispose();
  reactionListeners.delete(req.params.id);
  ok(res);
});

// ═══════════════════════════════════════════════
//  HISTORY (Old Manager) - kept from before
// ═══════════════════════════════════════════════
function snowflakeToMs(id) { return Number(BigInt(id) >> 22n) + 1420070400000; }

function fmtMsg(msg, channel, guild) {
  const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : snowflakeToMs(msg.id);
  const av = msg.author.avatar
    ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png`
    : '/discord.png';
  return {
    id: msg.id,
    content: msg.content || (msg.attachments?.length ? '[Attachment]' : '[Empty message]'),
    timestamp: ts,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      displayName: msg.author.global_name || msg.author.username,
      avatar: av
    },
    channel: channel || null,
    guild: guild || null
  };
}

app.get('/api/history/user/:userId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const r = await axios.get(`https://discord.com/api/v9/users/${req.params.userId}`, {
      headers: discordHeaders(c.token)
    });
    const u = r.data;
    ok(res, {
      user: {
        id: u.id,
        username: u.username,
        displayName: u.global_name || u.username,
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : '/discord.png'
      }
    });
  } catch (e) { res.json({ success: false, error: 'User not found' }); }
});

app.get('/api/history/user-search', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const query = (req.query.q || '').toLowerCase().replace('@', '');
    const frResp = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: discordHeaders(c.token)
    });
    const friend = frResp.data.filter(x => x.type === 1).find(r =>
      r.user.username.toLowerCase().includes(query) ||
      (r.user.global_name || '').toLowerCase().includes(query));
    if (friend) {
      const u = friend.user;
      return ok(res, { user: { id: u.id, username: u.username, displayName: u.global_name || u.username, avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : '/discord.png' } });
    }
    const dmMatch = Array.from(c.channels.cache.values())
      .filter(ch => ch.type === 'DM' && ch.recipient)
      .find(ch => ch.recipient.username.toLowerCase().includes(query) || (ch.recipient.globalName || '').toLowerCase().includes(query));
    if (dmMatch) {
      const u = dmMatch.recipient;
      return ok(res, { user: { id: u.id, username: u.username, displayName: u.globalName || u.username, avatar: u.avatarURL() || '/discord.png' } });
    }
    fail(res, new Error('User not found in your friends or DMs'));
  } catch (e) { fail(res, e); }
});

app.get('/api/history/dm-first-with/:userId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    let dm = Array.from(c.channels.cache.values())
      .find(ch => ch.type === 'DM' && ch.recipient?.id === req.params.userId);
    if (!dm) {
      try {
        const user = await c.users.fetch(req.params.userId);
        dm = await user.createDM();
      } catch (e) { return fail(res, new Error('No DM conversation with this user')); }
    }
    const r = await axios.get(`https://discord.com/api/v9/channels/${dm.id}/messages?limit=1&after=0`, { headers: discordHeaders(c.token) });
    if (!r.data.length) return fail(res, new Error('No messages found'));
    ok(res, { message: fmtMsg(r.data[0], { id: dm.id, name: `DM with @${dm.recipient?.username || 'Unknown'}` }, null) });
  } catch (e) { fail(res, e); }
});

app.get('/api/history/oldest-dm', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const dms = Array.from(c.channels.cache.values())
      .filter(ch => ch.type === 'DM')
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, 30);
    let oldest = null;
    for (const dm of dms) {
      try {
        const r = await axios.get(`https://discord.com/api/v9/channels/${dm.id}/messages?limit=1&after=0`, { headers: discordHeaders(c.token) });
        if (r.data.length) {
          const m = fmtMsg(r.data[0], { id: dm.id, name: `DM with @${dm.recipient?.username || 'Unknown'}` }, null);
          if (!oldest || m.timestamp < oldest.timestamp) oldest = m;
        }
        await sleep(120);
      } catch (e) {}
    }
    if (!oldest) return fail(res, new Error('No messages found'));
    ok(res, { message: oldest });
  } catch (e) { fail(res, e); }
});

app.get('/api/history/server-my-first/:serverId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const myId = c.user.id;
    const guild = c.guilds.cache.get(req.params.serverId);
    const sr = await axios.get(
      `https://discord.com/api/v9/guilds/${req.params.serverId}/messages/search?sort_by=timestamp&sort_order=asc&author_id=${myId}&limit=25`,
      { headers: discordHeaders(c.token) });
    const results = sr.data.messages;
    if (!results?.length) return fail(res, new Error('No messages found'));
    const target = results[0].find(m => m.author.id === myId) || results[0][0];
    let chName = target.channel_id;
    try {
      const cr = await axios.get(`https://discord.com/api/v9/channels/${target.channel_id}`, { headers: discordHeaders(c.token) });
      chName = cr.data.name;
    } catch (e) {}
    ok(res, { message: fmtMsg(target, { id: target.channel_id, name: chName }, guild ? { id: guild.id, name: guild.name } : null) });
  } catch (e) { fail(res, e); }
});

app.get('/api/history/server-first/:serverId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const guild = c.guilds.cache.get(req.params.serverId);
    if (!guild) return fail(res, new Error('Server not found'));
    const cr = await axios.get(`https://discord.com/api/v9/guilds/${req.params.serverId}/channels`, { headers: discordHeaders(c.token) });
    const channels = cr.data.filter(ch => ch.type === 0 || ch.type === 5).slice(0, 15);
    let oldest = null;
    for (const ch of channels) {
      try {
        const r = await axios.get(`https://discord.com/api/v9/channels/${ch.id}/messages?limit=1&after=0`, { headers: discordHeaders(c.token) });
        if (Array.isArray(r.data) && r.data.length) {
          const m = fmtMsg(r.data[0], { id: ch.id, name: ch.name }, { id: guild.id, name: guild.name });
          if (!oldest || m.timestamp < oldest.timestamp) oldest = m;
        }
        await sleep(120);
      } catch (e) {}
    }
    if (!oldest) return fail(res, new Error('No accessible messages'));
    ok(res, { message: oldest });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  PRIVATE MANAGER — chat-style realtime DM hub
// ═══════════════════════════════════════════════
// Per-account in-memory unread/last-message store
const dmState = new Map(); // key: account|channelId -> { lastMsg, unread, ts }
const DM_STATE_MAX = 5000; // cap so a 24/7 server with thousands of DMs doesn't leak
const sseClients = new Set(); // { res, account }
const SSE_PRIVATE_MAX = 200;  // hard cap on concurrent listeners

function bumpDM(accountName, channelId, msg, fromMe = false) {
  const k = `${accountName}|${channelId}`;
  const prev = dmState.get(k) || { unread: 0 };
  // Re-insert at the end so LRU eviction below favours dropping cold entries.
  if (dmState.has(k)) dmState.delete(k);
  dmState.set(k, {
    lastMsg: msg.content || (msg.attachments?.size ? '[attachment]' : ''),
    lastAuthor: msg.author?.id,
    fromMe,
    unread: fromMe ? 0 : (prev.unread || 0) + 1,
    ts: msg.createdTimestamp || Date.now()
  });
  if (dmState.size > DM_STATE_MAX) {
    const drop = dmState.size - DM_STATE_MAX;
    const it = dmState.keys();
    for (let i = 0; i < drop; i++) dmState.delete(it.next().value);
  }
}

function attachDMListener(name, client, ownerUid) {
  ownerUid = ownerUid || currentUserId();
  if (client.__dmListenerBound) return;
  client.__dmListenerBound = true;
  client.on('messageCreate', (msg) => withUser(ownerUid, () => {
    try {
      if (!msg.channel || msg.channel.type !== 'DM') return;
      const fromMe = msg.author?.id === client.user.id;
      bumpDM(name, msg.channel.id, msg, fromMe);
      const payload = JSON.stringify({
        type: 'dm',
        account: name,
        channelId: msg.channel.id,
        userId: msg.channel.recipient?.id,
        username: msg.channel.recipient?.username,
        avatar: msg.channel.recipient?.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(msg.channel.recipient?.id || '0'),
        fromMe,
        message: {
          id: msg.id,
          content: msg.content || '',
          ts: msg.createdTimestamp,
          author: { id: msg.author.id, username: msg.author.username }
        }
      });
      for (const sc of sseClients) {
        if (!sc.account || sc.account === name) {
          try { sc.res.write(`data: ${payload}\n\n`); } catch (e) {}
        }
      }
    } catch (e) {}
  }));
}

// NOTE: skipping "bind for already-connected clients" auto-loop —
// listeners are bound during connectOne() which is the only entry point now,
// and attempting to iterate the scoped pool here (outside any user ctx)
// would resolve to an empty namespace anyway.

app.get('/api/private/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`: connected\n\n`);
  const account = (req.query.account || '').trim();
  const sc = { res, account };

  // Drop the oldest listener if we're at the cap so a runaway client can't OOM us.
  if (sseClients.size >= SSE_PRIVATE_MAX) {
    const oldest = sseClients.values().next().value;
    if (oldest) {
      try { oldest.res.end(); } catch {}
      sseClients.delete(oldest);
    }
  }
  sseClients.add(sc);

  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch (e) {} }, 25000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    sseClients.delete(sc);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

app.get('/api/private/dms', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const accountName = (req.query.account || activeRef.get() || '').trim();
    const dms = Array.from(c.channels.cache.values())
      .filter(ch => ch.type === 'DM' && ch.recipient)
      .map(d => {
        const r = d.recipient;
        const k = `${accountName}|${d.id}`;
        const st = dmState.get(k);
        let preview = st?.lastMsg || '';
        let ts = st?.ts || 0;
        if (!st) {
          const last = d.lastMessage || (d.messages?.cache?.last?.());
          if (last) { preview = last.content || ''; ts = last.createdTimestamp || 0; }
        }
        return {
          id: d.id,
          userId: r?.id || '',
          username: r?.username || 'Unknown',
          displayName: r?.globalName || r?.username || 'Unknown',
          avatar: r?.displayAvatarURL?.({ size: 64, forceStatic: false }) || defaultAvatarUrl(r?.id || '0'),
          bot: !!r?.bot,
          unread: st?.unread || 0,
          preview,
          ts
        };
      })
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    ok(res, { dms, account: accountName });
  } catch (e) { fail(res, e); }
});

app.get('/api/private/messages/:channelId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const ch = await c.channels.fetch(req.params.channelId);
    if (!ch || ch.type !== 'DM') return fail(res, new Error('Invalid DM channel'));
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const opts = req.query.before ? { before: req.query.before, limit } : { limit };
    const msgs = await ch.messages.fetch(opts);
    const arr = Array.from(msgs.values())
      .map(m => ({
        id: m.id,
        content: m.content || '',
        ts: m.createdTimestamp,
        author: {
          id: m.author.id,
          username: m.author.username,
          displayName: m.author.globalName || m.author.username,
          avatar: m.author.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(m.author.id),
          bot: !!m.author.bot
        },
        replyTo: m.reference?.messageId || null,
        attachments: Array.from(m.attachments?.values?.() || []).map(a => ({
          url: a.url, name: a.name, contentType: a.contentType || '',
          width: a.width || null, height: a.height || null, size: a.size || 0
        })),
        reactions: Array.from(m.reactions?.cache?.values?.() || []).map(r => ({
          emoji: r.emoji.id ? `<:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name,
          name: r.emoji.name,
          id: r.emoji.id || null,
          count: r.count,
          me: !!r.me
        }))
      }))
      .sort((a, b) => a.ts - b.ts);
    res.json({ success: true, currentUserId: c.user.id, messages: arr });
  } catch (e) { fail(res, e); }
});

app.post('/api/private/send', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const { channelId, content, replyTo, files } = req.body || {};
    if (!channelId) return fail(res, new Error('channelId required'));
    if (!content && !(files && files.length)) return fail(res, new Error('content or file required'));
    const ch = await c.channels.fetch(channelId);
    if (!ch || ch.type !== 'DM') return fail(res, new Error('Invalid DM channel'));
    const opts = {};
    if (content) opts.content = content;
    if (replyTo) opts.reply = { messageReference: replyTo, failIfNotExists: false };
    if (files && files.length) {
      const extFor = (mime) => {
        const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
          'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
        return map[(mime || '').toLowerCase()] || null;
      };
      opts.files = files.map(f => {
        if (f.dataUrl) {
          const m = String(f.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
          if (!m) return null;
          const mime = m[1];
          const ext = extFor(mime);
          let name = f.name || 'file';
          // Force a proper image extension so Discord renders as inline preview (embed-style)
          if (ext && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) name = `image.${ext}`;
          return { attachment: Buffer.from(m[2], 'base64'), name, contentType: mime };
        }
        if (f.url) {
          const ext = (String(f.url).match(/\.(png|jpe?g|gif|webp|bmp)(?:\?|$)/i) || [])[1];
          let name = f.name || (ext ? `image.${ext}` : 'file');
          return { attachment: f.url, name };
        }
        return null;
      }).filter(Boolean);
    }
    const m = await ch.send(opts);
    ok(res, { id: m.id, ts: m.createdTimestamp });
  } catch (e) { fail(res, e); }
});

app.post('/api/private/react', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const { channelId, messageId, emoji, remove } = req.body || {};
    if (!channelId || !messageId || !emoji) return fail(res, new Error('channelId, messageId, emoji required'));
    const ch = await c.channels.fetch(channelId);
    const m = await ch.messages.fetch(messageId);
    if (remove) {
      const r = m.reactions?.cache?.find(x => x.emoji.name === emoji || (x.emoji.id && `<:${x.emoji.name}:${x.emoji.id}>` === emoji));
      if (r) await r.users.remove(c.user.id);
    } else {
      await m.react(emoji);
    }
    ok(res);
  } catch (e) { fail(res, e); }
});

app.post('/api/private/read/:channelId', (req, res) => {
  const accountName = (req.body?.account || activeRef.get() || '').trim();
  const k = `${accountName}|${req.params.channelId}`;
  const st = dmState.get(k);
  if (st) { st.unread = 0; dmState.set(k, st); }
  ok(res);
});

// ─── Private Manager: Strong global search ──────────────────────────
// Strategy (Discord-style):
//   1) FAST PASS — instantly match against locally-cached messages so the user
//      gets results in <50ms while the server makes the deeper call.
//   2) DEEP PASS — call Discord's NATIVE per-channel search API
//      (`GET /channels/:id/messages/search?content=<q>`) in parallel with a
//      concurrency cap. This covers the FULL message history for each DM, not
//      just what's cached. Results are merged + de-duplicated and returned.
//   3) CACHE — keep a 60-second per-(account|query) result cache so repeated
//      typing/scrolling reuses the deep results instantly.
const _pmSearchCache = new Map(); // key = account|q  -> { ts, matches }
const _PM_SEARCH_TTL = 60 * 1000;

async function _runPoolP(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++; try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function _mkMatch(ch, m) {
  const recip = ch.recipient || (ch.recipients && ch.recipients.first?.());
  const channelAvatar = recip?.displayAvatarURL?.({ size: 64 })
    || (m.author?.displayAvatarURL?.({ size: 64 }))
    || defaultAvatarUrl(recip?.id || ch.id || '0');
  return {
    channelId: ch.id,
    channelType: ch.type,
    channelName: recip?.username || ch.name || 'DM',
    channelAvatar,
    messageId: m.id,
    content: String(m.content || ''),
    author: {
      id: m.author?.id,
      username: m.author?.username || '',
      avatar: m.author?.displayAvatarURL?.({ size: 32 })
        || (m.author?.id ? defaultAvatarUrl(m.author.id) : null),
    },
    ts: m.createdTimestamp || (m.timestamp ? new Date(m.timestamp).getTime() : Date.now()),
  };
}

// Convert Discord's native search hit (raw API JSON) into our match shape.
function _mkMatchFromRaw(ch, raw) {
  const recip = ch.recipient || (ch.recipients && ch.recipients.first?.());
  const author = raw.author || {};
  const authorAvatar = author.avatar
    ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${author.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
    : defaultAvatarUrl(author.id || '0');
  const channelAvatar = recip?.displayAvatarURL?.({ size: 64 })
    || authorAvatar
    || defaultAvatarUrl(recip?.id || ch.id || '0');
  return {
    channelId: ch.id,
    channelType: ch.type,
    channelName: recip?.username || ch.name || 'DM',
    channelAvatar,
    messageId: raw.id,
    content: String(raw.content || ''),
    author: { id: author.id, username: author.username || '', avatar: authorAvatar },
    ts: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
  };
}

app.get('/api/private/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return ok(res, { matches: [], total: 0, source: 'short' });
    const account = (req.query.account || '').toString().trim();
    const includeGroups = req.query.groups === '1' || req.query.groups === 'true';
    const limit = Math.min(80, Math.max(5, parseInt(req.query.limit || '40', 10)));
    const deep = req.query.deep !== '0'; // default: deep search ON

    const c = account ? getClientByName(account) : (getActiveClient() || null);
    if (!c?.token) return fail(res, new Error('Not connected'));

    const cacheKey = `${account || activeRef.get() || '_'}|${q.toLowerCase()}|${includeGroups ? 'g' : ''}`;
    const cached = _pmSearchCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < _PM_SEARCH_TTL) {
      return ok(res, { matches: cached.matches.slice(0, limit), total: cached.matches.length, source: 'cache' });
    }

    const ql = q.toLowerCase();
    const channels = Array.from(c.channels.cache.values()).filter(ch =>
      ch.type === 'DM' || (includeGroups && ch.type === 'GROUP_DM'));

    // ── 1) FAST PASS: scan local cache (no network) ──────────────────
    const seen = new Set();
    const matches = [];
    for (const ch of channels) {
      const recipName = (ch.recipient?.username || ch.name || '').toLowerCase();
      const recipNick = (ch.recipient?.globalName || '').toLowerCase();
      // Surface channels matching by name/handle even when they have no message hits
      const channelHitByName = recipName.includes(ql) || recipNick.includes(ql);
      const cached = Array.from(ch.messages?.cache?.values?.() || []);
      for (const m of cached) {
        const cn = String(m.content || '').toLowerCase();
        const an = (m.author?.username || '').toLowerCase();
        if (cn.includes(ql) || an.includes(ql)) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          matches.push(_mkMatch(ch, m));
        }
      }
      if (channelHitByName && !matches.some(x => x.channelId === ch.id)) {
        // Synthetic "channel" hit so DM still appears in messages section
        const last = cached.sort((a, b) => (b.createdTimestamp||0)-(a.createdTimestamp||0))[0];
        if (last) { seen.add(last.id); matches.push(_mkMatch(ch, last)); }
      }
    }

    // ── 2) DEEP PASS: native Discord search API in parallel ──────────
    if (deep && c?.token && channels.length) {
      const headers = { Authorization: c.token, 'Content-Type': 'application/json' };
      // Run searches in parallel, with a tight concurrency cap to be polite.
      const PAR = 8;
      const perChannelLimit = 25;
      const t0 = Date.now();
      const TIMEOUT_MS = 8000; // hard cap so the request stays snappy
      await _runPoolP(channels, PAR, async (ch) => {
        if ((Date.now() - t0) > TIMEOUT_MS) return;
        try {
          const url = `https://discord.com/api/v9/channels/${ch.id}/messages/search`
            + `?content=${encodeURIComponent(q)}&limit=${perChannelLimit}`;
          const r = await axios.get(url, { headers, timeout: 6000, validateStatus: () => true });
          if (r.status === 429) return;
          if (r.status >= 400 || !r.data) return;
          const groups = r.data.messages || [];
          for (const grp of groups) {
            const hit = (grp || []).find(x => x?.hit) || (grp || [])[0];
            if (!hit || seen.has(hit.id)) continue;
            seen.add(hit.id);
            matches.push(_mkMatchFromRaw(ch, hit));
          }
        } catch (e) {}
      });
    }

    // Sort by recency, hard cap, cache
    matches.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const final = matches.slice(0, 200);
    _pmSearchCache.set(cacheKey, { ts: Date.now(), matches: final });
    if (_pmSearchCache.size > 200) {
      const oldest = [..._pmSearchCache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0]?.[0];
      if (oldest) _pmSearchCache.delete(oldest);
    }
    ok(res, { matches: final.slice(0, limit), total: final.length, source: 'fresh' });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  STATS DASHBOARD
// ═══════════════════════════════════════════════
app.get('/api/stats/summary', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const dms = Array.from(c.channels.cache.values()).filter(ch => ch.type === 'DM');
    const groups = Array.from(c.channels.cache.values()).filter(ch => ch.type === 'GROUP_DM');
    const guilds = Array.from(c.guilds.cache.values());
    const owned = guilds.filter(g => g.ownerId === c.user.id);
    const bots = dms.filter(d => d.recipient?.bot).length;
    // Top DMs by recent unread + activity (from dmState)
    const accountName = (req.query.account || activeRef.get() || '').trim();
    // Live-fallback: if dmState hasn't observed this DM yet (e.g. fresh boot),
    // use the channel's lastMessage timestamp so the dashboard isn't empty.
    const topDMs = dms.map(d => {
      const k = `${accountName}|${d.id}`;
      const st = dmState.get(k);
      let ts = st?.ts || 0;
      if (!ts) {
        const last = d.lastMessage || d.messages?.cache?.last?.();
        if (last) ts = last.createdTimestamp || 0;
      }
      return {
        username: d.recipient?.username || 'unknown',
        avatar: d.recipient?.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(d.recipient?.id || '0'),
        ts,
        unread: st?.unread || 0
      };
    }).filter(x => x.ts > 0).sort((a,b)=>b.ts-a.ts).slice(0, 6);

    const totalMembers = guilds.reduce((s,g)=>s+(g.memberCount||0),0);
    ok(res, {
      stats: {
        accountName,
        username: c.user.tag,
        avatar: c.user.displayAvatarURL?.({ size: 128 }) || null,
        accounts:    clients.size,
        connected:   Array.from(clients.values()).filter(e => e.client?.user).length,
        servers:     guilds.length,
        ownedServers: owned.length,
        members:     totalMembers,
        dms:         dms.length,
        botDMs:      bots,
        humanDMs:    dms.length - bots,
        groups:      groups.length,
        topDMs
      }
    });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  SERVER LOOKUP
// ═══════════════════════════════════════════════
// Boosts required for each tier (Discord constants)
const _BOOST_TIER_REQ = { 0: 2, 1: 7, 2: 14, 3: 0 };
function _verifNum(v) {
  // Discord.js v13 maps strings; handle both
  const map = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };
  if (typeof v === 'number') return v;
  return map[v] ?? null;
}
function _verifLabel(v) { return ['NONE','LOW','MEDIUM','HIGH','VERY_HIGH'][_verifNum(v) ?? 0] || null; }
function _filterLabel(v) {
  if (typeof v === 'number') return ['DISABLED','MEMBERS_WITHOUT_ROLES','ALL_MEMBERS'][v] || null;
  return v || null;
}
function _nsfwLabel(v) {
  if (typeof v === 'number') return ['DEFAULT','EXPLICIT','SAFE','AGE_RESTRICTED'][v] || null;
  return v || null;
}

app.get('/api/lookup/server/:id', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const id = req.params.id;
    const guild = c.guilds.cache.get(id);

    if (guild) {
      const me = guild.members.cache.get(c.user.id);
      // Channel breakdown
      const isText  = ch => ch.type === 'GUILD_TEXT'  || ch.type === 0;
      const isVoice = ch => ch.type === 'GUILD_VOICE' || ch.type === 2;
      const isCat   = ch => ch.type === 'GUILD_CATEGORY' || ch.type === 4;
      const isAnn   = ch => ch.type === 'GUILD_NEWS' || ch.type === 5;
      const isStage = ch => ch.type === 'GUILD_STAGE_VOICE' || ch.type === 13;
      const isForum = ch => ch.type === 'GUILD_FORUM' || ch.type === 15;
      const allCh = Array.from(guild.channels.cache.values());
      const visibleText = allCh.filter(ch => isText(ch) && ch.viewable).length;
      const totalText   = allCh.filter(isText).length;
      const totalVoice  = allCh.filter(isVoice).length;
      const totalCats   = allCh.filter(isCat).length;
      const totalAnn    = allCh.filter(isAnn).length;
      const totalStage  = allCh.filter(isStage).length;
      const totalForum  = allCh.filter(isForum).length;

      // Roles
      const roles = Array.from(guild.roles.cache.values())
        .filter(r => r.id !== guild.id)  // exclude @everyone
        .sort((a, b) => (b.position||0) - (a.position||0));
      const myRoles = me?.roles?.cache
        ? Array.from(me.roles.cache.values())
            .filter(r => r.id !== guild.id)
            .sort((a, b) => (b.position||0) - (a.position||0))
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor || null, position: r.position }))
        : [];
      const myHighest = myRoles[0] || null;

      // Owner
      const owner = await guild.members.fetch(guild.ownerId).catch(()=>null);

      // Try to get extra preview data (online count, description) in parallel —
      // even when we're already a member.
      const headers = { Authorization: c.token };
      const [previewRes, vanityRes] = await Promise.all([
        axios.get(`https://discord.com/api/v9/guilds/${guild.id}/preview`, { headers, validateStatus: () => true })
          .catch(() => ({ status: 0, data: null })),
        guild.vanityURLCode
          ? axios.get(`https://discord.com/api/v9/guilds/${guild.id}/vanity-url`, { headers, validateStatus: () => true })
              .catch(() => ({ status: 0, data: null }))
          : Promise.resolve({ status: 0, data: null }),
      ]);
      const preview = previewRes?.status === 200 ? previewRes.data : null;
      const vanityData = vanityRes?.status === 200 ? vanityRes.data : null;

      // Boost progress to next tier
      const tier = guild.premiumTier || 0;
      const boosts = guild.premiumSubscriptionCount || 0;
      let nextTierAt = null, boostProgress = null;
      const tierNum = typeof tier === 'number' ? tier : (parseInt(tier, 10) || 0);
      if (tierNum < 3) {
        nextTierAt = _BOOST_TIER_REQ[tierNum];
        boostProgress = nextTierAt > 0 ? Math.min(1, boosts / nextTierAt) : null;
      }

      // Resolve special channels by id
      const _chName = (cid) => cid ? (guild.channels.cache.get(cid)?.name || null) : null;

      // My permissions (admin-style summary)
      let myPermsList = null;
      try {
        if (me?.permissions?.toArray) myPermsList = me.permissions.toArray();
      } catch (e) {}

      ok(res, {
        joined: true,
        server: {
          id: guild.id,
          name: guild.name,
          icon: guild.iconURL?.({ size: 256, forceStatic: false }) || null,
          banner: guild.bannerURL?.({ size: 600 }) || null,
          splash: guild.splashURL?.({ size: 600 }) || null,
          discoverySplash: guild.discoverySplashURL?.({ size: 600 }) || null,
          createdAt: guild.createdTimestamp,
          description: guild.description || preview?.description || '',
          // members / presence
          members: guild.memberCount || preview?.approximate_member_count || 0,
          online: preview?.approximate_presence_count || null,
          maximum: guild.maximumMembers || null,
          // channels
          visibleText, totalText, totalVoice, totalCats, totalAnn, totalStage, totalForum,
          totalChannels: allCh.length,
          // roles
          totalRoles: roles.length,
          topRoles: roles.slice(0, 8).map(r => ({ id: r.id, name: r.name, color: r.hexColor || null, members: r.members?.size ?? null })),
          // owner
          ownerId: guild.ownerId,
          ownerName: owner?.user?.tag || null,
          ownerAvatar: owner?.user?.displayAvatarURL?.({ size: 64 }) || null,
          // my membership
          myRoles: myRoles.length,
          // Cap the embedded list at 50 to avoid sending massive payloads
          // for accounts with hundreds of roles (UI only shows ~10 at a time)
          myRolesList: myRoles.slice(0, 50),
          myRolesTruncated: myRoles.length > 50,
          myHighestRole: myHighest,
          myNickname: me?.nickname || null,
          myJoinedAt: me?.joinedTimestamp || null,
          myPermissions: myPermsList,
          isOwner: guild.ownerId === c.user.id,
          // boosts
          boosts, tier: tierNum, nextTierAt, boostProgress,
          boostBarEnabled: guild.premiumProgressBarEnabled ?? null,
          // settings
          verificationLevel: _verifLabel(guild.verificationLevel),
          explicitFilter: _filterLabel(guild.explicitContentFilter),
          nsfwLevel: _nsfwLabel(guild.nsfwLevel),
          mfaLevel: typeof guild.mfaLevel === 'number' ? (guild.mfaLevel === 1 ? 'ELEVATED' : 'NONE') : (guild.mfaLevel || null),
          preferredLocale: guild.preferredLocale || null,
          region: guild.region || null,
          // special channels
          afkChannelId: guild.afkChannelId || null,
          afkChannelName: _chName(guild.afkChannelId),
          afkTimeout: guild.afkTimeout || null,
          systemChannelId: guild.systemChannelId || null,
          systemChannelName: _chName(guild.systemChannelId),
          rulesChannelId: guild.rulesChannelId || null,
          rulesChannelName: _chName(guild.rulesChannelId),
          publicUpdatesChannelId: guild.publicUpdatesChannelId || null,
          publicUpdatesChannelName: _chName(guild.publicUpdatesChannelId),
          widgetEnabled: guild.widgetEnabled ?? null,
          widgetChannelId: guild.widgetChannelId || null,
          // emojis / stickers
          emojiCount:    guild.emojis?.cache?.size ?? null,
          animatedEmojis: guild.emojis?.cache ? Array.from(guild.emojis.cache.values()).filter(e => e.animated).length : null,
          stickerCount:  guild.stickers?.cache?.size ?? null,
          // vanity / invite
          vanityCode:    guild.vanityURLCode || null,
          vanityUses:    vanityData?.uses ?? null,
          // features
          features: guild.features || [],
          // partner / verified flags surfaced from features
          partnered: (guild.features || []).includes('PARTNERED'),
          verified:  (guild.features || []).includes('VERIFIED'),
          community: (guild.features || []).includes('COMMUNITY'),
        }
      });
      return;
    }

    // ── Not joined — public preview + invite info (parallel) ────────
    const headers = discordHeaders(c.token);
    const [previewRes] = await Promise.all([
      axios.get(`https://discord.com/api/v9/guilds/${id}/preview`, { headers, validateStatus: () => true }),
    ]);
    if (previewRes.status >= 400 || !previewRes.data) {
      // Uniform "not found" reply — do NOT distinguish 403 (private/non-discoverable)
      // from 404 (does not exist) so we don't leak guild existence to ID-scrapers.
      return ok(res, { joined: false, found: false, server: null });
    }
    const d = previewRes.data;
    ok(res, {
      joined: false,
      server: {
        id: d.id, name: d.name,
        icon: d.icon ? `https://cdn.discordapp.com/icons/${d.id}/${d.icon}.png?size=256` : null,
        banner: d.banner ? `https://cdn.discordapp.com/banners/${d.id}/${d.banner}.png?size=600` : null,
        splash: d.splash ? `https://cdn.discordapp.com/splashes/${d.id}/${d.splash}.png?size=600` : null,
        discoverySplash: d.discovery_splash ? `https://cdn.discordapp.com/discovery-splashes/${d.id}/${d.discovery_splash}.png?size=600` : null,
        createdAt: Number((BigInt(d.id) >> 22n) + 1420070400000n),
        members: d.approximate_member_count || 0,
        online: d.approximate_presence_count || 0,
        description: d.description || '',
        emojiCount: (d.emojis || []).length,
        animatedEmojis: (d.emojis || []).filter(e => e.animated).length,
        stickerCount: (d.stickers || []).length,
        features: d.features || [],
        partnered: (d.features || []).includes('PARTNERED'),
        verified:  (d.features || []).includes('VERIFIED'),
        community: (d.features || []).includes('COMMUNITY'),
      }
    });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  APP DATA + FEATURE SSE
// ═══════════════════════════════════════════════
// Per-user app data store — see lib/userScope.js. Resolves to
// data/users/<currentUserId>/app_data.json based on async context.
const dataStore = scopedStore('app_data.json', {});
function readData() { return dataStore.read(); }
function writeData(_d) { dataStore.touch(); } // mutations are on the cached object — just mark dirty
function ensureData() {
  const d = dataStore.read();
  if (!d.history) d.history = [];
  if (!d.tokenHealth) d.tokenHealth = {};
  if (!d.cloneSnapshots) d.cloneSnapshots = [];
  if (!d.picConfig) d.picConfig = { enabled: false, accounts: [], scope: 'all', servers: [], webhook: '', inApp: true };
  if (!d.picBuffer) d.picBuffer = [];
  if (!d.antiPruneConfig) d.antiPruneConfig = { enabled: false, accounts: [], scope: 'all', servers: [], message: 'You were removed from {server} by mistake — please rejoin: {invite}', distribute: true };
  if (!d.antiPruneLog) d.antiPruneLog = [];
  if (!Array.isArray(d.bots)) d.bots = [];
  if (typeof d.botsLastNumber !== 'number') d.botsLastNumber = 0;
  if (!d.botsConfig) d.botsConfig = { captcha2captchaKey: '' };
  dataStore.touch();
  return d;
}
ensureData();

const featureSSE = new Set();
function sseBroadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  for (const s of featureSSE) {
    if (!s.types || s.types.includes(type)) {
      try { s.res.write(`data: ${data}\n\n`); } catch (e) {}
    }
  }
}
// ═══════════════════════════════════════════════
//  BOT TOKENS — automated bot creation from a user account
// ═══════════════════════════════════════════════
const crypto = require('crypto');

function genPassword(len = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(0, chars.length)];
  return out;
}

const botTask = {
  state: 'idle',           // idle | running | waiting_captcha | cancelled | done | error
  startedAt: 0,
  account: null,
  total: 0,
  done: 0,
  failed: 0,
  current: '',
  cooldownMs: 120000,
  pendingCaptcha: null,    // { sitekey, rqdata, rqtoken, service, resolve, reject, attemptedAuto }
  cancelRequested: false,
  lastError: null
};

function botSnapshot() {
  return {
    state: botTask.state,
    startedAt: botTask.startedAt,
    account: botTask.account,
    total: botTask.total,
    done: botTask.done,
    failed: botTask.failed,
    current: botTask.current,
    cooldownMs: botTask.cooldownMs,
    waitingCaptcha: !!botTask.pendingCaptcha,
    captcha: botTask.pendingCaptcha ? {
      sitekey: botTask.pendingCaptcha.sitekey,
      service: botTask.pendingCaptcha.service,
      rqdata: botTask.pendingCaptcha.rqdata
    } : null,
    lastError: botTask.lastError
  };
}

function pushBotEvent(type, payload = {}) {
  sseBroadcast(type, { ...payload, task: botSnapshot() });
}

async function solveHCaptcha2captcha(apiKey, sitekey, pageUrl, rqdata) {
  if (!apiKey) throw new Error('No 2captcha key configured');
  const inParams = new URLSearchParams({
    key: apiKey, method: 'hcaptcha', sitekey, pageurl: pageUrl, json: '1'
  });
  if (rqdata) inParams.set('data', rqdata);
  const inResp = await axios.post('https://2captcha.com/in.php', inParams.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000
  });
  if (inResp.data.status !== 1) throw new Error('2captcha submit failed: ' + inResp.data.request);
  const captchaId = inResp.data.request;
  // Poll up to 180s
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await axios.get(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`, { timeout: 30000 });
    if (r.data.status === 1) return r.data.request;
    if (r.data.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha solve failed: ' + r.data.request);
  }
  throw new Error('2captcha timed out');
}

async function discordRequestWithCaptcha({ method, url, token, body, pageUrl = 'https://discord.com' }) {
  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  let captchaKey = null, captchaRqtoken = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (botTask.cancelRequested) throw new Error('Cancelled');
    const reqHeaders = { ...headers };
    if (captchaKey) {
      reqHeaders['X-Captcha-Key'] = captchaKey;
      if (captchaRqtoken) reqHeaders['X-Captcha-Rqtoken'] = captchaRqtoken;
    }
    try {
      const r = await axios({ method, url, headers: reqHeaders, data: body, validateStatus: () => true, timeout: 30000 });
      if (r.status >= 200 && r.status < 300) return r.data;
      const e = r.data || {};
      if (e.captcha_key && (e.captcha_sitekey || e.captcha_service)) {
        const sitekey = e.captcha_sitekey || '';
        const service = e.captcha_service || 'hcaptcha';
        const rqdata  = e.captcha_rqdata || null;
        const rqtoken = e.captcha_rqtoken || null;
        const cfg = ensureData();
        const apiKey = (cfg.botsConfig?.captcha2captchaKey || '').trim();
        let token2;
        if (apiKey && service === 'hcaptcha') {
          try {
            pushBotEvent('bot_progress', { msg: 'auto-solving captcha…' });
            token2 = await solveHCaptcha2captcha(apiKey, sitekey, pageUrl, rqdata);
          } catch (err) {
            // Auto-solve failed → fall through to manual
            token2 = await waitManualCaptcha({ sitekey, service, rqdata, rqtoken });
          }
        } else {
          token2 = await waitManualCaptcha({ sitekey, service, rqdata, rqtoken });
        }
        captchaKey = token2;
        captchaRqtoken = rqtoken;
        continue; // retry with captcha key
      }
      const msg = e.message || e.errors?._errors?.[0]?.message || `Discord ${r.status}`;
      const err = new Error(msg);
      err.status = r.status; err.body = e;
      throw err;
    } catch (e) {
      if (attempt === 2) throw e;
      if (!e.captcha) throw e;
    }
  }
  throw new Error('Captcha retry exhausted');
}

function waitManualCaptcha({ sitekey, service, rqdata, rqtoken }) {
  return new Promise((resolve, reject) => {
    botTask.state = 'waiting_captcha';
    botTask.pendingCaptcha = { sitekey, service, rqdata, rqtoken, resolve, reject };
    pushBotEvent('bot_captcha', { sitekey, service });
    // 10-minute timeout
    setTimeout(() => {
      if (botTask.pendingCaptcha && botTask.pendingCaptcha.resolve === resolve) {
        botTask.pendingCaptcha = null;
        if (botTask.state === 'waiting_captcha') botTask.state = 'running';
        reject(new Error('Captcha solve timed out'));
      }
    }, 10 * 60 * 1000);
  });
}

async function createOneBot({ userToken, name, avatarDataUrl, bannerDataUrl }) {
  // 1) Create application
  const app = await discordRequestWithCaptcha({
    method: 'POST', url: 'https://discord.com/api/v9/applications',
    token: userToken, body: { name, team_id: null }
  });
  const appId = app.id;

  // 2) Convert to bot (creates the bot user, returns initial token)
  const botCreate = await discordRequestWithCaptcha({
    method: 'POST', url: `https://discord.com/api/v9/applications/${appId}/bot`,
    token: userToken, body: {}
  });
  let botToken = botCreate.token;
  if (!botToken) {
    // Some accounts must reset to receive the token
    const reset = await discordRequestWithCaptcha({
      method: 'POST', url: `https://discord.com/api/v9/applications/${appId}/bot/reset`,
      token: userToken, body: {}
    });
    botToken = reset.token;
  }
  const botUserId = botCreate.id || botCreate.user?.id || appId;

  // 3) Apply avatar/banner via PATCH /applications/{id}/bot using user token
  const patchBody = {};
  if (avatarDataUrl) patchBody.avatar = avatarDataUrl;
  if (bannerDataUrl) patchBody.banner = bannerDataUrl;
  if (Object.keys(patchBody).length) {
    try {
      await discordRequestWithCaptcha({
        method: 'PATCH', url: `https://discord.com/api/v9/applications/${appId}/bot`,
        token: userToken, body: patchBody
      });
    } catch (e) {
      // Soft-fail: keep the bot, surface the error
      pushBotEvent('bot_progress', { msg: `avatar/banner failed: ${e.message}` });
    }
  }

  // 4) Validate the bot token works
  let validated = false;
  try {
    const r = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${botToken}` }, validateStatus: () => true, timeout: 15000
    });
    validated = r.status === 200;
  } catch (e) {}

  return { appId, botUserId, botToken, validated };
}

async function runBotCreationTask({ ownerName, userToken, count, namePattern, avatarDataUrl, bannerDataUrl, customPasswordPattern }) {
  botTask.state = 'running';
  botTask.startedAt = Date.now();
  botTask.account = ownerName;
  botTask.total = count;
  botTask.done = 0;
  botTask.failed = 0;
  botTask.current = '';
  botTask.lastError = null;
  botTask.cancelRequested = false;
  pushBotEvent('bot_progress', { msg: 'starting' });

  for (let i = 0; i < count; i++) {
    if (botTask.cancelRequested) break;
    const d = ensureData();
    const num = (d.botsLastNumber || 0) + 1;
    let name = String(namePattern || 'Bot {n}')
      .replace(/\{n\}/g, String(num).padStart(2, '0'))
      .replace(/\{i\}/g, String(i + 1))
      .trim()
      .slice(0, 32);
    // Discord requires application names of length 2..32. If the user-provided
    // pattern resolved to something too short, pad with the number to keep going.
    if (name.length < 2) name = `Bot ${String(num).padStart(2, '0')}`.slice(0, 32);
    botTask.current = name;
    pushBotEvent('bot_progress', { msg: `creating ${name}` });
    try {
      const r = await createOneBot({ userToken, name, avatarDataUrl, bannerDataUrl });
      // Local password is optional. Bot tokens are the real credential, so we no
      // longer auto-generate a meaningless local password. Only set one if the
      // user explicitly provided a pattern in customPasswordPattern.
      const password = customPasswordPattern
        ? String(customPasswordPattern).replace(/\{n\}/g, String(num)).replace(/\{name\}/g, name)
        : '';
      const record = {
        id: 'bot_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'),
        number: num,
        name,
        appId: r.appId,
        botUserId: r.botUserId,
        token: r.botToken,
        password,
        validated: r.validated,
        avatar: !!avatarDataUrl,
        banner: !!bannerDataUrl,
        createdBy: ownerName,
        createdAt: Date.now()
      };
      d.bots.push(record);
      d.botsLastNumber = num;
      writeData(d);
      botTask.done += 1;
      pushBotEvent('bot_created', { bot: { ...record, token: undefined } });
      try { recordHistory({ account: ownerName, type: 'bot_create', target: { name, appId: r.appId }, status: 'success' }); } catch (e) {}
    } catch (e) {
      botTask.failed += 1;
      botTask.lastError = e.message;
      pushBotEvent('bot_failed', { name, error: e.message });
      if (/Cancelled/i.test(e.message)) break;
      // If 429, sleep an extra 30s
      if (e.status === 429) await new Promise(r => setTimeout(r, 30000));
    }
    // Cooldown with ±20% jitter (skip after the last)
    if (i < count - 1 && !botTask.cancelRequested) {
      const base = Math.max(30000, botTask.cooldownMs);
      const jitter = base * (0.8 + Math.random() * 0.4);
      pushBotEvent('bot_progress', { msg: `cooldown ${Math.round(jitter / 1000)}s` });
      await new Promise(r => setTimeout(r, jitter));
    }
  }
  botTask.state = botTask.cancelRequested ? 'cancelled' : 'done';
  botTask.current = '';
  pushBotEvent('bot_done', {});
}

// ── Endpoints
app.get('/api/bots', (req, res) => {
  const d = ensureData();
  const list = (d.bots || []).slice().sort((a, b) => a.number - b.number);
  ok(res, { bots: list });
});

app.get('/api/bots/all-tokens', (req, res) => {
  const d = ensureData();
  const list = (d.bots || []).slice().sort((a, b) => a.number - b.number);
  if ((req.query.format || 'text') === 'json') return ok(res, { bots: list });
  const lines = list.map(b => `${String(b.number).padStart(3, '0')}\t${b.name}\t${b.token}\t${b.password || ''}`);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="bot_tokens.txt"');
  res.send(`# number\tname\ttoken\tpassword\n${lines.join('\n')}\n`);
});

app.delete('/api/bots/:id', (req, res) => {
  const d = ensureData();
  const i = (d.bots || []).findIndex(b => b.id === req.params.id);
  if (i < 0) return fail(res, new Error('Not found'));
  const removed = d.bots.splice(i, 1)[0];
  writeData(d);
  ok(res, { removed: { id: removed.id, name: removed.name } });
});

app.get('/api/bots/status', (req, res) => ok(res, { task: botSnapshot() }));

app.post('/api/bots/create', (req, res) => {
  if (botTask.state === 'running' || botTask.state === 'waiting_captcha') {
    return fail(res, new Error('A bot creation task is already running'));
  }
  const { account, count, namePattern, avatarDataUrl, bannerDataUrl, cooldownMs, customPasswordPattern } = req.body || {};
  if (!account) return fail(res, new Error('account is required'));
  const c = clients.get(account);
  if (!c?.token) return fail(res, new Error('Account is not connected'));
  const n = Math.max(1, Math.min(50, parseInt(count || 1) || 1));
  botTask.cooldownMs = Math.max(30000, parseInt(cooldownMs || 120000) || 120000);

  // Run async
  runBotCreationTask({
    ownerName: account,
    userToken: c.token,
    count: n,
    namePattern: String(namePattern || 'Bot {n}').slice(0, 32),
    avatarDataUrl: avatarDataUrl || null,
    bannerDataUrl: bannerDataUrl || null,
    customPasswordPattern: customPasswordPattern || ''
  }).catch(e => {
    botTask.state = 'error';
    botTask.lastError = e.message;
    pushBotEvent('bot_done', {});
  });
  ok(res, { started: true, task: botSnapshot() });
});

app.post('/api/bots/cancel', (req, res) => {
  botTask.cancelRequested = true;
  if (botTask.pendingCaptcha) {
    try { botTask.pendingCaptcha.reject(new Error('Cancelled')); } catch (e) {}
    botTask.pendingCaptcha = null;
  }
  ok(res, { task: botSnapshot() });
});

app.post('/api/bots/captcha', (req, res) => {
  if (!botTask.pendingCaptcha) return fail(res, new Error('No captcha pending'));
  const { captchaKey } = req.body || {};
  if (!captchaKey) return fail(res, new Error('captchaKey required'));
  try {
    botTask.pendingCaptcha.resolve(captchaKey);
    botTask.pendingCaptcha = null;
    botTask.state = 'running';
    pushBotEvent('bot_progress', { msg: 'captcha received' });
    ok(res, { task: botSnapshot() });
  } catch (e) { fail(res, e); }
});

app.get('/api/bots/config', (req, res) => {
  const d = ensureData();
  const cfg = d.botsConfig || {};
  ok(res, { config: { has2captcha: !!(cfg.captcha2captchaKey || '').trim() } });
});

app.post('/api/bots/config', (req, res) => {
  const { captcha2captchaKey } = req.body || {};
  const d = ensureData();
  if (typeof captcha2captchaKey === 'string') d.botsConfig.captcha2captchaKey = captcha2captchaKey.trim();
  writeData(d);
  ok(res, { saved: true });
});

const SSE_FEATURES_MAX = 200;
app.get('/api/features/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  res.write(`: connected\n\n`);
  const types = (req.query.types || '').split(',').filter(Boolean);
  const sc = { res, types: types.length ? types : null };

  if (featureSSE.size >= SSE_FEATURES_MAX) {
    const oldest = featureSSE.values().next().value;
    if (oldest) {
      try { oldest.res.end(); } catch {}
      featureSSE.delete(oldest);
    }
  }
  featureSSE.add(sc);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    featureSSE.delete(sc);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

function accountAvatarMap() {
  const m = {};
  for (const [n, e] of clients.entries()) {
    m[n] = {
      avatar: e.client.user?.displayAvatarURL?.({ size: 32 }) || null,
      username: e.client.user?.tag || n
    };
  }
  return m;
}

// ═══════════════════════════════════════════════
//  1. HISTORY LOG
// ═══════════════════════════════════════════════
function recordHistory(entry) {
  try {
    const d = readData();
    const arr = d.history || [];
    arr.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      ...entry
    });
    if (arr.length > 1000) arr.length = 1000;
    d.history = arr;
    writeData(d);
    sseBroadcast('history', { entry: arr[0] });
  } catch (e) {}
}

app.get('/api/history-log', (req, res) => {
  const d = readData();
  let h = d.history || [];
  const { account, type, status, q } = req.query;
  if (account) h = h.filter(x => x.account === account);
  if (type) h = h.filter(x => x.type === type);
  if (status) h = h.filter(x => x.status === status);
  if (q) {
    const ql = String(q).toLowerCase();
    h = h.filter(x => JSON.stringify(x).toLowerCase().includes(ql));
  }
  ok(res, { history: h.slice(0, 500), accounts: accountAvatarMap() });
});

app.delete('/api/history-log', (req, res) => {
  const d = readData(); d.history = []; writeData(d); ok(res);
});

// ═══════════════════════════════════════════════
//  2. TOKEN HEALTH CHECK
// ═══════════════════════════════════════════════
// Map Discord error codes / HTTP statuses to human reasons + preventive hints
function classifyTokenFailure(httpCode, discordCode, message) {
  const m = String(message || '').toLowerCase();
  if (httpCode === 401) return { status: 'invalid', reason: 'Token revoked or invalid', hint: 'Re-login on Discord and replace this token' };
  if (httpCode === 403) {
    if (m.includes('disabled')) return { status: 'disabled', reason: 'Account disabled by Discord', hint: 'Slow down all accounts and avoid spam-like patterns' };
    if (m.includes('age'))      return { status: 'age_locked', reason: 'Age verification required', hint: 'Confirm DOB on this account from Discord client' };
    if (m.includes('phone'))    return { status: 'phone_locked', reason: 'Phone verification required', hint: 'Verify a phone number on this account' };
    if (m.includes('captcha'))  return { status: 'captcha', reason: 'Captcha challenge triggered', hint: 'Pause activity for ~10 min, reduce concurrency' };
    return { status: 'banned', reason: 'Account banned/locked', hint: 'Stop using this token; review last 50 actions to find the trigger' };
  }
  if (httpCode === 429) return { status: 'rate_limited', reason: 'Cloudflare/Discord rate-limit', hint: 'Increase per-action delay (≥ 1500ms) and stagger accounts' };
  if (discordCode === 40002) return { status: 'unverified', reason: 'Account requires verification', hint: 'Verify email/phone before further actions' };
  if (discordCode === 50035) return { status: 'invalid_input', reason: 'Invalid form body', hint: 'Re-check payload (avatar/banner/bio length)' };
  return { status: 'error', reason: message || 'Unknown error', hint: 'Retry later; check connectivity' };
}

async function checkOneToken(name, token) {
  try {
    const r = await axios.get('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: token }, timeout: 10000
    });
    return {
      name, ok: true, status: 'healthy',
      user: { id: r.data.id, username: r.data.username, displayName: r.data.global_name || r.data.username,
              avatar: r.data.avatar ? `https://cdn.discordapp.com/avatars/${r.data.id}/${r.data.avatar}.png?size=64` : defaultAvatarUrl(r.data.id) },
      checkedAt: Date.now()
    };
  } catch (e) {
    const httpCode = e.response?.status;
    const discordCode = e.response?.data?.code;
    const msg = e.response?.data?.message || e.message || String(e);
    const cls = classifyTokenFailure(httpCode, discordCode, msg);
    // Apply preventive broadcast so other accounts can react (slow down, pause, etc.)
    try {
      sseBroadcast('ban_alert', {
        name, status: cls.status, reason: cls.reason, hint: cls.hint,
        httpCode, discordCode, at: Date.now()
      });
      // Persist last incident for the audit log
      const d = readData();
      d.banAlerts = d.banAlerts || [];
      d.banAlerts.unshift({ name, status: cls.status, reason: cls.reason, hint: cls.hint, httpCode, discordCode, at: Date.now() });
      if (d.banAlerts.length > 200) d.banAlerts.length = 200;
      writeData(d);
    } catch (_) {}
    return { name, ok: false, status: cls.status, error: msg, reason: cls.reason, hint: cls.hint, httpCode, discordCode, checkedAt: Date.now() };
  }
}

async function runHealthCheck() {
  try {
    const tokens = readTokens();
    const d = readData();
    d.tokenHealth = d.tokenHealth || {};
    for (const t of tokens) {
      const r = await checkOneToken(t.name, t.token);
      d.tokenHealth[t.name] = r;
      sseBroadcast('token_health', { name: t.name, result: r });
      await sleep(jitter(400, 900));
    }
    writeData(d);
  } catch (e) {}
}

app.get('/api/token-health', (req, res) => {
  const d = readData();
  ok(res, { health: d.tokenHealth || {}, accounts: accountAvatarMap() });
});

app.post('/api/token-health/check', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (name) {
      const t = readTokens().find(x => x.name === name);
      if (!t) return fail(res, new Error('Token not found'));
      const r = await checkOneToken(t.name, t.token);
      const d = readData();
      d.tokenHealth = d.tokenHealth || {};
      d.tokenHealth[t.name] = r;
      writeData(d);
      sseBroadcast('token_health', { name: t.name, result: r });
      return ok(res, { result: r });
    }
    runHealthCheck();
    ok(res, { running: true });
  } catch (e) { fail(res, e); }
});

// Self-rescheduling timer with ±15% jitter so all instances of the app
// don't hammer Discord at the same wall-clock minute (and to look less
// botty). Base = 30 min, range ≈ 25.5–34.5 min.
function _scheduleNextHealthCheck() {
  const base = 30 * 60 * 1000;
  const next = base + Math.floor((Math.random() * 0.3 - 0.15) * base);
  setTimeout(async () => {
    try { await runHealthCheck(); } catch (_) {}
    _scheduleNextHealthCheck();
  }, next);
}
_scheduleNextHealthCheck();
setTimeout(runHealthCheck, 8000); // initial after start

// ═══════════════════════════════════════════════
//  3. CLONE MANAGER
// ═══════════════════════════════════════════════
app.get('/api/clone/sources', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const guilds = Array.from(c.guilds.cache.values()).map(g => ({
      id: g.id, name: g.name,
      icon: g.iconURL?.({ size: 64 }) || null,
      members: g.memberCount || 0,
      owner: g.ownerId === c.user.id
    }));
    const dms = Array.from(c.channels.cache.values()).filter(ch => ch.type === 'DM').map(d => ({
      id: d.id, type: 'dm',
      name: d.recipient?.username || 'Unknown',
      icon: d.recipient?.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(d.recipient?.id || '0')
    }));
    const groups = Array.from(c.channels.cache.values()).filter(ch => ch.type === 'GROUP_DM').map(g => ({
      id: g.id, type: 'group',
      name: g.name || Array.from(g.recipients?.values?.() || []).slice(0, 3).map(u => u.username).join(', '),
      icon: g.iconURL?.({ size: 64 }) || null,
      recipients: g.recipients?.size || 0
    }));
    ok(res, { guilds, dms, groups });
  } catch (e) { fail(res, e); }
});

app.get('/api/clone/snapshot/server/:guildId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.token) return fail(res, new Error('Not connected'));
    const id = req.params.guildId;
    const guild = c.guilds.cache.get(id);
    if (!guild) return fail(res, new Error('Server not found in this account'));

    const includeMessages = req.query.messages === '1' || req.query.messages === 'true';
    // Bumped cap from 200 → 5000 so power users can capture a deeper history
    // when they really need it; default stays at 50 to keep snapshots quick.
    const perChannel = Math.min(Math.max(parseInt(req.query.perChannel, 10) || 50, 1), 5000);

    const [chRes, roleRes] = await Promise.all([
      axios.get(`https://discord.com/api/v9/guilds/${id}/channels`, { headers: { Authorization: c.token } }),
      axios.get(`https://discord.com/api/v9/guilds/${id}/roles`, { headers: { Authorization: c.token } }).catch(() => ({ data: [] }))
    ]);
    const channels = chRes.data.map(ch => ({
      id: ch.id, name: ch.name, type: ch.type, parent_id: ch.parent_id || null,
      position: ch.position, topic: ch.topic || '', nsfw: !!ch.nsfw,
      rate_limit_per_user: ch.rate_limit_per_user || 0, bitrate: ch.bitrate || 0, user_limit: ch.user_limit || 0,
      permission_overwrites: (ch.permission_overwrites || []).map(po => ({
        id: po.id, type: po.type, allow: String(po.allow || '0'), deny: String(po.deny || '0')
      }))
    })).sort((a, b) => a.position - b.position);
    const categories = channels.filter(c => c.type === 4);
    const textChans = channels.filter(c => c.type === 0 || c.type === 5);
    const voiceChans = channels.filter(c => c.type === 2);
    const roles = (roleRes.data || []).map(r => ({
      id: r.id, name: r.name, color: r.color, hoist: r.hoist, permissions: String(r.permissions || '0'),
      mentionable: r.mentionable, position: r.position,
      // Role icons (Boost-tier 2 feature). icon = custom uploaded image hash,
      // unicode_emoji = a fallback emoji. Both can be sent back when re-creating.
      icon: r.icon || null,
      unicode_emoji: r.unicode_emoji || null,
      iconUrl: r.icon ? `https://cdn.discordapp.com/role-icons/${r.id}/${r.icon}.png?size=64` : null
    })).sort((a, b) => b.position - a.position);
    const emojis = Array.from(guild.emojis?.cache?.values?.() || []).map(e => ({
      id: e.id, name: e.name, animated: e.animated, url: e.url
    }));

    const channelMessages = {};
    if (includeMessages) {
      // Capture in parallel batches of 4 channels at a time to keep things fast & polite to Discord.
      const BATCH = 4;
      for (let i = 0; i < textChans.length; i += BATCH) {
        const slice = textChans.slice(i, i + BATCH);
        const results = await Promise.all(slice.map(async (ch) => {
          try {
            const raw = await fetchChannelMessages(c, ch.id, perChannel);
            return [ch.id, raw.map(m => ({
              id: m.id, content: m.content || '',
              ts: new Date(m.timestamp).getTime(),
              author: {
                id: m.author.id, username: m.author.username,
                displayName: m.author.global_name || m.author.username,
                avatar: m.author.avatar
                  ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64`
                  : defaultAvatarUrl(m.author.id)
              },
              attachments: (m.attachments || []).map(a => ({
                url: a.url, name: a.filename, contentType: a.content_type || ''
              })),
              embeds: m.embeds || []
            }))];
          } catch (e) { return [ch.id, []]; }
        }));
        for (const [cid, msgs] of results) channelMessages[cid] = msgs;
      }
    }

    ok(res, {
      snapshot: {
        kind: 'server',
        capturedAt: Date.now(),
        server: {
          id: guild.id, name: guild.name,
          icon: guild.iconURL?.({ size: 256 }) || null,
          banner: guild.bannerURL?.({ size: 600 }) || null,
          description: guild.description || '',
          features: guild.features || [],
          memberCount: guild.memberCount || 0,
          verificationLevel: guild.verificationLevel || 0,
          afkTimeout: guild.afkTimeout || 0,
          systemChannelId: guild.systemChannelId || null
        },
        categories, textChannels: textChans, voiceChannels: voiceChans,
        roles, emojis,
        channelMessages,
        hasMessages: includeMessages
      }
    });
  } catch (e) { fail(res, e); }
});

async function fetchChannelMessages(client, channelId, max = 100) {
  const out = [];
  let before = null;
  while (out.length < max) {
    const url = `https://discord.com/api/v9/channels/${channelId}/messages?limit=${Math.min(100, max - out.length)}${before ? `&before=${before}` : ''}`;
    let batch;
    try {
      const r = await axios.get(url, { headers: { Authorization: client.token } });
      batch = r.data;
    } catch (e) { break; }
    if (!Array.isArray(batch) || !batch.length) break;
    for (const m of batch) out.push(m);
    before = batch[batch.length - 1].id;
    if (batch.length < 50) break;
    await sleep(150);
  }
  return out.reverse(); // oldest first
}

app.get('/api/clone/snapshot/dm/:channelId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const max = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const ch = await c.channels.fetch(req.params.channelId);
    if (!ch || ch.type !== 'DM') return fail(res, new Error('Invalid DM channel'));
    const raw = await fetchChannelMessages(c, ch.id, max);
    const messages = raw.map(m => ({
      id: m.id, content: m.content || '',
      ts: new Date(m.timestamp).getTime(),
      author: { id: m.author.id, username: m.author.username,
                displayName: m.author.global_name || m.author.username,
                avatar: m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : defaultAvatarUrl(m.author.id) },
      attachments: (m.attachments || []).map(a => ({ url: a.url, name: a.filename, contentType: a.content_type || '' })),
      embeds: m.embeds || []
    }));
    ok(res, {
      snapshot: {
        kind: 'dm', capturedAt: Date.now(),
        recipient: {
          id: ch.recipient?.id, username: ch.recipient?.username,
          displayName: ch.recipient?.globalName || ch.recipient?.username,
          avatar: ch.recipient?.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(ch.recipient?.id || '0')
        },
        messages
      }
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/clone/snapshot/group/:channelId', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const max = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const ch = await c.channels.fetch(req.params.channelId);
    if (!ch || ch.type !== 'GROUP_DM') return fail(res, new Error('Invalid group'));
    const raw = await fetchChannelMessages(c, ch.id, max);
    const messages = raw.map(m => ({
      id: m.id, content: m.content || '',
      ts: new Date(m.timestamp).getTime(),
      author: { id: m.author.id, username: m.author.username,
                displayName: m.author.global_name || m.author.username,
                avatar: m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : defaultAvatarUrl(m.author.id) },
      attachments: (m.attachments || []).map(a => ({ url: a.url, name: a.filename, contentType: a.content_type || '' })),
      embeds: m.embeds || []
    }));
    ok(res, {
      snapshot: {
        kind: 'group', capturedAt: Date.now(),
        group: {
          id: ch.id,
          name: ch.name || Array.from(ch.recipients?.values?.() || []).slice(0, 3).map(u => u.username).join(', '),
          icon: ch.iconURL?.({ size: 64 }) || null,
          recipients: Array.from(ch.recipients?.values?.() || []).map(u => ({
            id: u.id, username: u.username,
            displayName: u.globalName || u.username,
            avatar: u.displayAvatarURL?.({ size: 32 }) || defaultAvatarUrl(u.id)
          }))
        },
        messages
      }
    });
  } catch (e) { fail(res, e); }
});

app.get('/api/clone/saved', (req, res) => {
  const d = readData();
  const list = (d.cloneSnapshots || []).map(s => ({
    id: s.id, kind: s.snapshot?.kind, name: s.name, savedAt: s.savedAt,
    summary: s.snapshot?.kind === 'server'
      ? { channels: (s.snapshot.textChannels?.length || 0) + (s.snapshot.voiceChannels?.length || 0), roles: s.snapshot.roles?.length || 0 }
      : { messages: s.snapshot?.messages?.length || 0 }
  }));
  ok(res, { snapshots: list });
});

app.post('/api/clone/saved', (req, res) => {
  try {
    const { snapshot, name } = req.body || {};
    if (!snapshot) return fail(res, new Error('snapshot required'));
    const d = readData();
    d.cloneSnapshots = d.cloneSnapshots || [];
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    d.cloneSnapshots.unshift({ id, name: name || (snapshot.kind + ' ' + new Date().toLocaleString()), savedAt: Date.now(), snapshot });
    if (d.cloneSnapshots.length > 100) d.cloneSnapshots.length = 100;
    writeData(d);
    ok(res, { id });
  } catch (e) { fail(res, e); }
});

app.get('/api/clone/saved/:id', (req, res) => {
  const d = readData();
  const s = (d.cloneSnapshots || []).find(x => x.id === req.params.id);
  if (!s) return fail(res, new Error('Not found'));
  ok(res, { snapshot: s.snapshot, name: s.name, savedAt: s.savedAt });
});

app.delete('/api/clone/saved/:id', (req, res) => {
  const d = readData();
  d.cloneSnapshots = (d.cloneSnapshots || []).filter(x => x.id !== req.params.id);
  writeData(d);
  ok(res);
});

// ── Clone Presets — reusable paste configurations
app.get('/api/clone/presets', (req, res) => {
  const d = readData();
  ok(res, { presets: (d.clonePresets || []).map(p => ({
    id: p.id, name: p.name, savedAt: p.savedAt,
    accounts: (p.accounts || []).length,
    channels: (p.selectedChannels || []).length,
    options: p.options || {}
  })) });
});

app.get('/api/clone/presets/:id', (req, res) => {
  const d = readData();
  const p = (d.clonePresets || []).find(x => x.id === req.params.id);
  if (!p) return fail(res, new Error('Preset not found'));
  ok(res, { preset: p });
});

app.post('/api/clone/presets', (req, res) => {
  try {
    const { name, options = {}, selectedChannels = [], accounts = [], targetGuildId = null } = req.body || {};
    if (!name || !String(name).trim()) return fail(res, new Error('Name required'));
    const d = readData();
    d.clonePresets = d.clonePresets || [];
    // Replace existing with same name (case-insensitive) instead of duplicating
    const idx = d.clonePresets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    const id = idx >= 0 ? d.clonePresets[idx].id
                        : (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const preset = {
      id, name: String(name).trim(), savedAt: Date.now(),
      options, selectedChannels, accounts, targetGuildId
    };
    if (idx >= 0) d.clonePresets[idx] = preset;
    else d.clonePresets.unshift(preset);
    if (d.clonePresets.length > 50) d.clonePresets.length = 50;
    writeData(d);
    ok(res, { id, preset });
  } catch (e) { fail(res, e); }
});

app.delete('/api/clone/presets/:id', (req, res) => {
  const d = readData();
  d.clonePresets = (d.clonePresets || []).filter(x => x.id !== req.params.id);
  writeData(d);
  ok(res);
});

// ── Ban / health alerts log
app.get('/api/ban-alerts', (req, res) => {
  const d = readData();
  ok(res, { alerts: (d.banAlerts || []).slice(0, 100) });
});

app.delete('/api/ban-alerts', (req, res) => {
  const d = readData();
  d.banAlerts = [];
  writeData(d);
  ok(res);
});

// Webhook paste — fast (no token rate-limit, only webhook 5/sec)
async function postWebhook(url, payload, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      return { ok: true, data: r.data };
    } catch (e) {
      const code = e.response?.status;
      if (code === 429) {
        const retry = parseFloat(e.response.headers['retry-after'] || e.response.data?.retry_after || 1);
        await sleep(retry * 1000);
        continue;
      }
      if (code >= 400 && code < 500) return { ok: false, error: e.response?.data?.message || e.message };
      await sleep(500 * (i + 1));
    }
  }
  return { ok: false, error: 'Failed after retries' };
}

app.post('/api/clone/paste/webhook', async (req, res) => {
  try {
    const { webhookUrl, messages = [], includeAuthor = true, gapMs = 250 } = req.body || {};
    if (!webhookUrl || !messages.length) return fail(res, new Error('webhookUrl and messages required'));
    const out = [];
    for (const m of messages) {
      const att = (m.attachments || []).map(a => a.url).join('\n');
      let content = m.content || '';
      if (att) content = (content ? content + '\n' : '') + att;
      if (!content && !(m.embeds || []).length) continue;
      const payload = {
        content: content.slice(0, 1900) || ' ',
        username: includeAuthor ? (m.author?.displayName || m.author?.username || 'Anon') : undefined,
        avatar_url: includeAuthor ? (m.author?.avatar || undefined) : undefined,
        allowed_mentions: { parse: [] }
      };
      const r = await postWebhook(webhookUrl, payload);
      out.push({ id: m.id, ok: r.ok, error: r.error || null });
      await sleep(gapMs);
    }
    recordHistory({
      account: 'webhook', type: 'clone_paste',
      target: { kind: 'webhook' }, messages: messages.length,
      status: out.every(x => x.ok) ? 'success' : (out.some(x => x.ok) ? 'partial' : 'failed'),
      ok: out.filter(x => x.ok).length, fail: out.filter(x => !x.ok).length
    });
    ok(res, { results: out });
  } catch (e) { fail(res, e); }
});

// New comprehensive paste — supports multi-account, selective options, channel-perm overwrites, messages.
app.post('/api/clone/paste/server-build', async (req, res) => {
  try {
    const { accounts: rawAccounts, account, snapshot, targetGuildId, options = {} } = req.body || {};
    if (!snapshot || snapshot.kind !== 'server') return fail(res, new Error('Server snapshot required'));
    if (!targetGuildId) return fail(res, new Error('targetGuildId required'));

    const accountList = Array.isArray(rawAccounts) && rawAccounts.length
      ? rawAccounts
      : [account || activeRef.get()].filter(Boolean);
    if (!accountList.length) return fail(res, new Error('No accounts specified'));

    // The "structure builder" must own (or have admin on) the target server.
    let builderName = null, builder = null, builderGuild = null;
    for (const n of accountList) {
      const cc = getClientByName(n);
      if (!cc?.token) continue;
      const g = cc.guilds.cache.get(targetGuildId);
      if (g && (g.ownerId === cc.user.id || g.members.me?.permissions?.has?.('ADMINISTRATOR'))) {
        builderName = n; builder = cc; builderGuild = g;
        break;
      }
    }
    if (!builder) {
      // Fallback: use first connected account that has the guild visible.
      for (const n of accountList) {
        const cc = getClientByName(n);
        const g = cc?.guilds?.cache?.get?.(targetGuildId);
        if (cc?.token && g) { builderName = n; builder = cc; builderGuild = g; break; }
      }
    }
    if (!builder) return fail(res, new Error('None of the chosen accounts can see the target server'));

    const opts = {
      categories:    !!options.categories,
      textChannels:  !!options.textChannels,
      voiceChannels: !!options.voiceChannels,
      roles:         !!options.roles,
      rolePerms:     !!options.rolePerms,
      roleIcons:     !!options.roleIcons,         // NEW: copy role unicode/icon emoji
      channelPerms:  !!options.channelPerms,
      emojis:        !!options.emojis,
      messages:      !!options.messages,
      messageChannelIds: Array.isArray(options.messageChannelIds) ? options.messageChannelIds : null, // null = all
      // Per-channel cap, configurable. Was hard-coded ~200 elsewhere; we let the
      // user dial it up to 5000 if they really need a deep clone.
      messagesPerChannel: Math.min(Math.max(parseInt(options.messagesPerChannel, 10) || 200, 1), 5000),
      messageGapMs: Math.max(parseInt(options.messageGapMs, 10) || 220, 80),
    };

    const created = {
      categories: 0, textChannels: 0, voiceChannels: 0,
      roles: 0, channelPerms: 0, emojis: 0, messagesPosted: 0, errors: []
    };
    const catMap = new Map();      // snapshot cat id -> new cat id
    const newChMap = new Map();    // snapshot text channel id -> new channel id
    const roleMap = new Map();     // snapshot role id -> new role id
    roleMap.set('@everyone', builderGuild.roles.everyone?.id);

    // ── Roles
    if (opts.roles) {
      // Pre-fetch role icons (PNG bytes -> base64 data URI) when the user opted
      // in. Discord ignores `icon` if the target guild's tier is too low so
      // failures here are non-fatal — we just fall back to a unicode emoji.
      const _roleIconCache = new Map();
      if (opts.roleIcons) {
        for (const r of snapshot.roles || []) {
          if (!r.iconUrl) continue;
          try {
            const ir = await axios.get(r.iconUrl, { responseType: 'arraybuffer', validateStatus: () => true });
            if (ir.status === 200 && ir.data) {
              const b64 = Buffer.from(ir.data).toString('base64');
              _roleIconCache.set(r.id, `data:image/png;base64,${b64}`);
            }
          } catch (_) {}
          await sleep(jitter(120, 220));
        }
      }
      for (const r of (snapshot.roles || []).slice().reverse()) {
        if (r.name === '@everyone') continue;
        try {
          const body = {
            name: r.name, color: r.color, hoist: r.hoist,
            permissions: opts.rolePerms ? r.permissions : '0',
            mentionable: r.mentionable
          };
          if (opts.roleIcons) {
            const ic = _roleIconCache.get(r.id);
            if (ic) body.icon = ic;
            else if (r.unicode_emoji) body.unicode_emoji = r.unicode_emoji;
          }
          const rr = await axios.post(
            `https://discord.com/api/v9/guilds/${targetGuildId}/roles`,
            body,
            { headers: { Authorization: builder.token, 'Content-Type': 'application/json' } }
          );
          roleMap.set(r.id, rr.data.id);
          created.roles++;
          await sleep(jitter(350, 600));
        } catch (e) {
          created.errors.push(`role ${r.name}: ${e.response?.data?.message || e.message}`);
        }
      }
    }

    function buildOverwrites(channelOverwrites) {
      if (!opts.channelPerms || !Array.isArray(channelOverwrites)) return undefined;
      const out = [];
      for (const po of channelOverwrites) {
        // type 0 = role, type 1 = member. Skip member overwrites — those users don't exist on target.
        if (po.type !== 0) continue;
        // For @everyone, the snapshot's @everyone id is the source guild id; map separately.
        const isEveryone = po.id === snapshot.server?.id;
        const newId = isEveryone ? roleMap.get('@everyone') : roleMap.get(po.id);
        if (!newId) continue;
        out.push({ id: newId, type: 0, allow: po.allow, deny: po.deny });
      }
      return out.length ? out : undefined;
    }

    // ── Categories
    if (opts.categories) {
      for (const cat of snapshot.categories || []) {
        try {
          const r = await axios.post(
            `https://discord.com/api/v9/guilds/${targetGuildId}/channels`,
            { name: cat.name, type: 4, permission_overwrites: buildOverwrites(cat.permission_overwrites) },
            { headers: { Authorization: builder.token, 'Content-Type': 'application/json' } }
          );
          catMap.set(cat.id, r.data.id);
          created.categories++;
          if (opts.channelPerms && cat.permission_overwrites?.length) created.channelPerms++;
          await sleep(jitter(250, 500));
        } catch (e) {
          created.errors.push(`category ${cat.name}: ${e.response?.data?.message || e.message}`);
        }
      }
    }

    // ── Text channels
    if (opts.textChannels) {
      for (const ch of snapshot.textChannels || []) {
        try {
          const r = await axios.post(
            `https://discord.com/api/v9/guilds/${targetGuildId}/channels`,
            {
              name: ch.name, type: 0,
              parent_id: catMap.get(ch.parent_id) || null,
              topic: ch.topic, nsfw: ch.nsfw,
              rate_limit_per_user: ch.rate_limit_per_user,
              permission_overwrites: buildOverwrites(ch.permission_overwrites)
            },
            { headers: { Authorization: builder.token, 'Content-Type': 'application/json' } }
          );
          newChMap.set(ch.id, r.data.id);
          created.textChannels++;
          if (opts.channelPerms && ch.permission_overwrites?.length) created.channelPerms++;
          await sleep(jitter(250, 500));
        } catch (e) {
          created.errors.push(`text ${ch.name}: ${e.response?.data?.message || e.message}`);
        }
      }
    }

    // ── Voice channels
    if (opts.voiceChannels) {
      for (const ch of snapshot.voiceChannels || []) {
        try {
          await axios.post(
            `https://discord.com/api/v9/guilds/${targetGuildId}/channels`,
            {
              name: ch.name, type: 2,
              parent_id: catMap.get(ch.parent_id) || null,
              bitrate: ch.bitrate, user_limit: ch.user_limit,
              permission_overwrites: buildOverwrites(ch.permission_overwrites)
            },
            { headers: { Authorization: builder.token, 'Content-Type': 'application/json' } }
          );
          created.voiceChannels++;
          if (opts.channelPerms && ch.permission_overwrites?.length) created.channelPerms++;
          await sleep(jitter(250, 500));
        } catch (e) {
          created.errors.push(`voice ${ch.name}: ${e.response?.data?.message || e.message}`);
        }
      }
    }

    // ── Custom emojis (download + upload)
    if (opts.emojis && Array.isArray(snapshot.emojis)) {
      for (const em of snapshot.emojis) {
        try {
          const img = await axios.get(em.url, { responseType: 'arraybuffer', timeout: 15000 });
          const ct = img.headers['content-type'] || (em.animated ? 'image/gif' : 'image/png');
          const b64 = `data:${ct};base64,${Buffer.from(img.data).toString('base64')}`;
          await axios.post(
            `https://discord.com/api/v9/guilds/${targetGuildId}/emojis`,
            { name: em.name.replace(/[^\w]/g, '').slice(0, 32) || 'emoji', image: b64 },
            { headers: { Authorization: builder.token, 'Content-Type': 'application/json' } }
          );
          created.emojis++;
          await sleep(jitter(450, 800));
        } catch (e) {
          created.errors.push(`emoji ${em.name}: ${e.response?.data?.message || e.message}`);
        }
      }
    }

    // ── Messages: post via webhooks for speed and to preserve author display.
    // Multi-account speedup: round-robin webhook posters across accounts (each gets its own webhook).
    if (opts.messages && snapshot.channelMessages && (opts.textChannels || newChMap.size)) {
      // Pick channels to restore. If textChannels weren't created in this run, we can still
      // post into existing channels with the same name in the target.
      const wantedChannelIds = opts.messageChannelIds || Object.keys(snapshot.channelMessages);

      // Resolve target channel id for each source channel id
      const targetByCh = new Map();
      for (const sourceCh of (snapshot.textChannels || [])) {
        if (!wantedChannelIds.includes(sourceCh.id)) continue;
        let newId = newChMap.get(sourceCh.id);
        if (!newId) {
          const found = builderGuild.channels.cache.find(
            ch => ch.type === 'GUILD_TEXT' && ch.name === sourceCh.name
          );
          if (found) newId = found.id;
        }
        if (newId) targetByCh.set(sourceCh.id, newId);
      }

      // Connected accounts that can hit the target guild — used as webhook posters.
      const posters = accountList
        .map(n => ({ name: n, client: getClientByName(n) }))
        .filter(p => p.client?.token);

      // For each target channel: create one webhook per poster, post messages round-robin, then delete.
      for (const [srcId, tgtId] of targetByCh.entries()) {
        const messages = snapshot.channelMessages[srcId] || [];
        if (!messages.length) continue;

        const channelWebhooks = [];
        for (const p of posters) {
          try {
            const wh = await axios.post(
              `https://discord.com/api/v9/channels/${tgtId}/webhooks`,
              { name: `clone-${p.name}`.slice(0, 80) },
              { headers: { Authorization: p.client.token, 'Content-Type': 'application/json' } }
            );
            channelWebhooks.push({
              poster: p.name,
              url: `https://discord.com/api/webhooks/${wh.data.id}/${wh.data.token}`,
              id: wh.data.id,
              token: p.client.token
            });
          } catch (e) {
            created.errors.push(`webhook ${tgtId} via ${p.name}: ${e.response?.data?.message || e.message}`);
          }
        }
        if (!channelWebhooks.length) continue;

        // Post messages round-robin across webhooks for parallel throughput.
        let idx = 0;
        const concurrency = Math.min(channelWebhooks.length, 3);
        const queue = messages.slice();
        const workers = Array.from({ length: concurrency }, async () => {
          while (queue.length) {
            const m = queue.shift();
            const wh = channelWebhooks[idx++ % channelWebhooks.length];
            const att = (m.attachments || []).map(a => a.url).join('\n');
            let content = m.content || '';
            if (att) content = (content ? content + '\n' : '') + att;
            if (!content) continue;
            const payload = {
              content: content.slice(0, 1900),
              username: (m.author?.displayName || m.author?.username || 'User').slice(0, 80),
              avatar_url: m.author?.avatar || undefined,
              allowed_mentions: { parse: [] }
            };
            const r = await postWebhook(wh.url, payload);
            if (r.ok) created.messagesPosted++;
            else created.errors.push(`msg via ${wh.poster}: ${r.error}`);
            await sleep(opts.messageGapMs);
          }
        });
        await Promise.all(workers);

        // Cleanup webhooks
        for (const wh of channelWebhooks) {
          try {
            await axios.delete(
              `https://discord.com/api/v9/webhooks/${wh.id}`,
              { headers: { Authorization: wh.token } }
            );
          } catch (e) {}
        }
      }
    }

    const status = created.errors.length === 0 ? 'success'
      : (created.categories + created.textChannels + created.voiceChannels + created.roles + created.messagesPosted > 0 ? 'partial' : 'failed');

    recordHistory({
      account: builderName, type: 'clone_build_server',
      target: { id: targetGuildId, accounts: accountList },
      status,
      ok: created.categories + created.textChannels + created.voiceChannels + created.roles + created.emojis + created.channelPerms,
      fail: created.errors.length
    });

    if (created.messagesPosted > 0) {
      recordHistory({
        account: accountList.join('+'),
        type: 'clone_messages',
        target: { id: targetGuildId, channels: Object.keys(snapshot.channelMessages || {}).length },
        status,
        ok: created.messagesPosted,
        fail: created.errors.filter(e => e.startsWith('msg ')).length
      });
    }

    ok(res, { created, builder: builderName, accounts: accountList });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  4. MENTIONS TRACKER
// ═══════════════════════════════════════════════
// Backed by app_data.json so mentions survive restarts (was in-memory only).
const mentionsStore = new Map(); // account -> [{...}]
let _mentionsDirty = false;
function _loadMentionsFromDisk() {
  try {
    const d = readData();
    const m = d.mentions || {};
    for (const [name, list] of Object.entries(m)) {
      if (Array.isArray(list)) mentionsStore.set(name, list);
    }
  } catch (_) {}
}
function _saveMentionsToDisk() {
  try {
    const d = readData();
    const out = {};
    for (const [name, list] of mentionsStore.entries()) out[name] = list.slice(0, 200);
    d.mentions = out;
    writeData(d);
    _mentionsDirty = false;
  } catch (_) {}
}
// Coalesce writes — listeners may fire dozens of times per second
setInterval(() => { if (_mentionsDirty) _saveMentionsToDisk(); }, 4000);
_loadMentionsFromDisk();

function addMention(account, msg) {
  const arr = mentionsStore.get(account) || [];
  const guild = msg.guild;
  arr.unshift({
    id: msg.id,
    account,
    channelId: msg.channel.id,
    channelName: msg.channel.name || (msg.channel.type === 'DM' ? 'DM' : 'channel'),
    channelType: msg.channel.type,
    guildId: guild?.id || null,
    guildName: guild?.name || null,
    guildIcon: guild?.iconURL?.({ size: 32 }) || null,
    content: msg.content || '',
    ts: msg.createdTimestamp,
    deleted: false,
    author: {
      id: msg.author.id, username: msg.author.username,
      displayName: msg.author.globalName || msg.author.username,
      avatar: msg.author.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(msg.author.id),
      bot: !!msg.author.bot
    },
    attachments: Array.from(msg.attachments?.values?.() || []).map(a => ({ url: a.url, name: a.name }))
  });
  if (arr.length > 200) arr.length = 200;
  mentionsStore.set(account, arr);
  _mentionsDirty = true;
  sseBroadcast('mention', { account, mention: arr[0] });
}
function markMentionDeleted(account, msgId) {
  const arr = mentionsStore.get(account);
  if (!arr) return;
  const it = arr.find(x => x.id === msgId);
  if (it) { it.deleted = true; _mentionsDirty = true; sseBroadcast('mention_deleted', { account, id: msgId }); }
}

function attachMentionListener(name, client, ownerUid) {
  ownerUid = ownerUid || currentUserId();
  if (client.__mentionListenerBound) return;
  client.__mentionListenerBound = true;
  client.on('messageCreate', (msg) => withUser(ownerUid, () => {
    try {
      if (msg.author?.id === client.user.id) return;
      const mentioned = msg.mentions?.users?.has?.(client.user.id) ||
                        (msg.content || '').includes(`<@${client.user.id}>`) ||
                        (msg.content || '').includes(`<@!${client.user.id}>`);
      if (!mentioned) return;
      addMention(name, msg);
    } catch (e) {}
  }));
  client.on('messageDelete', (msg) => withUser(ownerUid, () => {
    try { markMentionDeleted(name, msg.id); } catch (e) {}
  }));
}
// Listeners are bound during connectOne(); no need to re-iterate here.

app.get('/api/mentions', (req, res) => {
  const account = (req.query.account || activeRef.get() || '').trim();
  const all = req.query.all === '1' || req.query.all === 'true';
  let list = [];
  if (all) {
    for (const [n, arr] of mentionsStore.entries()) list.push(...arr);
    list.sort((a, b) => b.ts - a.ts);
    list = list.slice(0, 200);
  } else {
    list = mentionsStore.get(account) || [];
  }
  ok(res, { mentions: list, accounts: accountAvatarMap() });
});

app.delete('/api/mentions', (req, res) => {
  const { account } = req.body || {};
  if (account) mentionsStore.delete(account);
  else mentionsStore.clear();
  _mentionsDirty = true;
  _saveMentionsToDisk();
  ok(res);
});

// ═══════════════════════════════════════════════
//  5. PIC CAPTURE
// ═══════════════════════════════════════════════
function isImageAttachment(a) {
  if (!a) return false;
  const ct = (a.contentType || a.content_type || '').toLowerCase();
  if (ct.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(a.url || '');
}

async function handlePicMessage(name, msg) {
  try {
    const d = readData();
    const cfg = d.picConfig || {};
    if (!cfg.enabled) return;
    if (cfg.accounts?.length && !cfg.accounts.includes(name)) return;
    const guildId = msg.guild?.id;
    if (cfg.scope === 'servers' && (!guildId || !cfg.servers?.includes(guildId))) return;
    if (cfg.scope === 'all' && !guildId) return; // only servers (per request)

    const imgs = Array.from(msg.attachments?.values?.() || []).filter(isImageAttachment);
    if (!imgs.length) return;

    const meta = {
      id: msg.id,
      account: name,
      ts: msg.createdTimestamp,
      author: {
        id: msg.author.id, username: msg.author.username,
        displayName: msg.author.globalName || msg.author.username,
        avatar: msg.author.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(msg.author.id),
        bot: !!msg.author.bot
      },
      guild: msg.guild ? { id: msg.guild.id, name: msg.guild.name, icon: msg.guild.iconURL?.({ size: 32 }) || null } : null,
      channel: { id: msg.channel.id, name: msg.channel.name || 'channel' },
      content: msg.content || '',
      images: imgs.map(a => ({ url: a.url, name: a.name, width: a.width, height: a.height, contentType: a.contentType }))
    };

    if (cfg.inApp !== false) {
      const buf = d.picBuffer || [];
      // Dedupe: skip if we already saved this message ID (multiple connected
      // accounts can both see the same message → previously double-counted)
      if (buf.some(x => x.id === meta.id && x.account === meta.account)) {
        // already captured by this account — still mirror to webhook below if configured
      } else {
        buf.unshift(meta);
        if (buf.length > 500) buf.length = 500; // raised cap, was 200
        d.picBuffer = buf;
        writeData(d);
        sseBroadcast('pic', { capture: meta });
      }
    }
    if (cfg.webhook) {
      const lines = imgs.map(i => i.url).join('\n');
      const where = msg.guild ? `${msg.guild.name} · #${msg.channel.name}` : `#${msg.channel.name}`;
      const content = `**${meta.author.displayName}** · ${where}\n${meta.content ? meta.content + '\n' : ''}${lines}`;
      await postWebhook(cfg.webhook, {
        content: content.slice(0, 1900),
        username: meta.author.displayName,
        avatar_url: meta.author.avatar,
        allowed_mentions: { parse: [] }
      });
    }
  } catch (e) {}
}

function attachPicListener(name, client, ownerUid) {
  ownerUid = ownerUid || currentUserId();
  if (client.__picListenerBound) return;
  client.__picListenerBound = true;
  client.on('messageCreate', (msg) => withUser(ownerUid, () => handlePicMessage(name, msg)));
}
// Listeners are bound during connectOne(); no need to re-iterate here.

app.get('/api/pic/config', (req, res) => {
  const d = readData();
  ok(res, { config: d.picConfig || {} });
});

app.post('/api/pic/config', (req, res) => {
  try {
    const d = readData();
    d.picConfig = { ...(d.picConfig || {}), ...(req.body || {}) };
    writeData(d);
    ok(res, { config: d.picConfig });
  } catch (e) { fail(res, e); }
});

app.get('/api/pic/buffer', (req, res) => {
  const d = readData();
  ok(res, { buffer: (d.picBuffer || []).slice(0, 100), accounts: accountAvatarMap() });
});

app.delete('/api/pic/buffer', (req, res) => {
  const d = readData(); d.picBuffer = []; writeData(d); ok(res);
});

// ═══════════════════════════════════════════════
//  6. ANTI PRUNE
// ═══════════════════════════════════════════════
async function tryDmUser(client, userId, content) {
  try {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    await dm.send({ content, allowed_mentions: { parse: [] } });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Track guilds we've already warned the UI about to avoid spamming SSE
const _antiPruneNoAuditGuilds = new Set();
const _ANTIPRUNE_WARN_MAX = 500;
async function isPrunedRecently(client, guildId) {
  // Check audit log for MEMBER_PRUNE (28) within last 10s
  try {
    const r = await axios.get(`https://discord.com/api/v9/guilds/${guildId}/audit-logs?action_type=28&limit=1`, {
      headers: { Authorization: client.token }
    });
    const entry = r.data.audit_log_entries?.[0];
    if (!entry) return false;
    const t = snowflakeToMs(entry.id);
    return (Date.now() - t) < 12000;
  } catch (e) {
    // 403 = "Missing Permissions" → AntiPrune cannot detect prunes for this
    // server. Surface ONCE to the UI so the user knows why nothing fires.
    const status = e?.response?.status;
    if ((status === 403 || status === 401) && !_antiPruneNoAuditGuilds.has(guildId)) {
      addBounded(_antiPruneNoAuditGuilds, guildId, _ANTIPRUNE_WARN_MAX);
      try {
        const guildName = client.guilds.cache.get(guildId)?.name || guildId;
        sseBroadcast('antiprune_warning', {
          guildId, guildName,
          message: `AntiPrune cannot read audit logs for "${guildName}" — needs the View Audit Log permission. Pruned-member alerts will be skipped for this server.`
        });
        // Persist to the antiPrune log so the user can see it later
        try {
          const d = readData();
          d.antiPruneLog = d.antiPruneLog || [];
          d.antiPruneLog.unshift({
            ts: Date.now(), level: 'warning', guildId, guildName,
            message: 'Missing View Audit Log permission — prune detection disabled for this server.'
          });
          if (d.antiPruneLog.length > 200) d.antiPruneLog.length = 200;
          writeData(d);
        } catch (_) {}
      } catch (_) {}
    }
    return false;
  }
}

async function findInviteFor(client, guildId) {
  try {
    const r = await axios.get(`https://discord.com/api/v9/guilds/${guildId}/invites`, { headers: { Authorization: client.token } });
    if (Array.isArray(r.data) && r.data.length) return `https://discord.gg/${r.data[0].code}`;
  } catch (e) {}
  try {
    const guild = client.guilds.cache.get(guildId);
    const ch = guild?.systemChannel || Array.from(guild.channels.cache.values()).find(c => c.type === 'GUILD_TEXT' || c.type === 0);
    if (ch?.createInvite) {
      const inv = await ch.createInvite({ maxAge: 0, maxUses: 0, unique: false });
      return `https://discord.gg/${inv.code}`;
    }
  } catch (e) {}
  return '';
}

const recentPruneHandled = new Set(); // dedupe per (guild, user)

async function handleAntiPrune(name, member) {
  try {
    const d = readData();
    const cfg = d.antiPruneConfig || {};
    if (!cfg.enabled) return;
    if (cfg.accounts?.length && !cfg.accounts.includes(name)) return;
    const guildId = member.guild.id;
    if (cfg.scope === 'servers' && !cfg.servers?.includes(guildId)) return;

    const dedupeKey = `${guildId}|${member.id}`;
    if (recentPruneHandled.has(dedupeKey)) return;

    const client = getClientByName(name);
    if (!client) return;
    const isPrune = await isPrunedRecently(client, guildId);
    if (!isPrune) return;
    recentPruneHandled.add(dedupeKey);
    setTimeout(() => recentPruneHandled.delete(dedupeKey), 30000);

    const invite = await findInviteFor(client, guildId);
    const message = (cfg.message || 'You were removed from {server} by mistake — please rejoin: {invite}')
      .replace('{server}', member.guild.name)
      .replace('{invite}', invite || '(no invite available)')
      .replace('{user}', member.user?.username || '');

    let attempt = await tryDmUser(client, member.id, message);
    let by = name;
    if (!attempt.ok && cfg.distribute !== false) {
      // Try other connected accounts that share a server with the user
      for (const [otherName, e] of clients.entries()) {
        if (otherName === name) continue;
        if (cfg.accounts?.length && !cfg.accounts.includes(otherName)) continue;
        const shares = Array.from(e.client.guilds.cache.values()).some(g => g.members.cache.has(member.id) || g.id === guildId);
        if (!shares) continue;
        const r = await tryDmUser(e.client, member.id, message);
        if (r.ok) { attempt = r; by = otherName; break; }
        await sleep(jitter(300, 600));
      }
    }

    const log = d.antiPruneLog || [];
    log.unshift({
      ts: Date.now(),
      guild: { id: guildId, name: member.guild.name },
      user: { id: member.id, username: member.user?.username || 'unknown', avatar: member.user?.displayAvatarURL?.({ size: 32 }) || defaultAvatarUrl(member.id) },
      detectedBy: name,
      sentBy: attempt.ok ? by : null,
      ok: attempt.ok, error: attempt.error || null,
      invite
    });
    if (log.length > 300) log.length = 300;
    d.antiPruneLog = log;
    writeData(d);
    sseBroadcast('antiprune', { event: log[0] });
  } catch (e) {}
}

function attachAntiPruneListener(name, client, ownerUid) {
  ownerUid = ownerUid || currentUserId();
  if (client.__antipruneBound) return;
  client.__antipruneBound = true;
  client.on('guildMemberRemove', (member) => withUser(ownerUid, () => handleAntiPrune(name, member)));
}
// Listeners are bound during connectOne(); no need to re-iterate here.

app.get('/api/antiprune/config', (req, res) => {
  const d = readData();
  ok(res, { config: d.antiPruneConfig || {} });
});

app.post('/api/antiprune/config', (req, res) => {
  try {
    const d = readData();
    d.antiPruneConfig = { ...(d.antiPruneConfig || {}), ...(req.body || {}) };
    writeData(d);
    ok(res, { config: d.antiPruneConfig });
  } catch (e) { fail(res, e); }
});

app.get('/api/antiprune/log', (req, res) => {
  const d = readData();
  ok(res, { log: (d.antiPruneLog || []).slice(0, 200) });
});

app.delete('/api/antiprune/log', (req, res) => {
  const d = readData(); d.antiPruneLog = []; writeData(d); ok(res);
});

app.get('/api/updates', async (req, res) => {
  try {
    const r = await axios.get('https://raw.githubusercontent.com/Bherl1/DiscordAccMgr/refs/heads/main/package.json');
    const latest = r.data.version;
    const current = require('./package.json').version;
    res.json({ hasUpdate: latest > current, version: latest, downloadUrl: `https://github.com/Bherl1/DiscordAccMgr/releases/download/v${latest}/DiscordAccManager-Setup.exe` });
  } catch (e) { res.json({ hasUpdate: false }); }
});

// ═══════════════════════════════════════════════
//  Start server + auto-open browser locally
// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
//  6. BACKGROUND TASK SYSTEM
//  Single-task-per-account lock for anti-ban safety.
//  Live progress via SSE on /api/features/stream (type=task).
// ═══════════════════════════════════════════════
const tasks = new Map();
const taskAccountLocks = new Set();
const TASK_RING_MAX = 60;

function newTaskId() { return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function summarizeTask(t) {
  return {
    id: t.id, type: t.type, label: t.label, account: t.account,
    status: t.status, current: t.current, total: t.total,
    okCount: t.okCount, failCount: t.failCount,
    startedAt: t.startedAt, doneAt: t.doneAt,
    cancelled: t.cancelled, error: t.error || null,
    lastItem: t.items.length ? t.items[t.items.length - 1] : null
  };
}

function createTask({ type, label, total = 0, account = null }) {
  if (account && taskAccountLocks.has(account))
    throw new Error(`Account "${account}" is already running a task. Wait or cancel it first.`);
  const id = newTaskId();
  const t = {
    id, type, label, account,
    status: 'running', current: 0, total,
    okCount: 0, failCount: 0,
    items: [], errors: [],
    startedAt: Date.now(), doneAt: null,
    cancelled: false, error: null
  };
  tasks.set(id, t);
  if (account) taskAccountLocks.add(account);
  // Trim ring buffer of finished tasks
  if (tasks.size > TASK_RING_MAX) {
    const finished = Array.from(tasks.values()).filter(x => x.status !== 'running').sort((a, b) => a.startedAt - b.startedAt);
    while (tasks.size > TASK_RING_MAX && finished.length) {
      const oldest = finished.shift(); tasks.delete(oldest.id);
    }
  }
  sseBroadcast('task', { task: summarizeTask(t) });
  return t;
}
function pushTaskItem(t, item) {
  if (!t || t.status !== 'running') return;
  t.items.push(item); t.current++;
  if (item?.ok) t.okCount++; else t.failCount++;
  if (t.items.length > 200) t.items.splice(0, t.items.length - 200);
  sseBroadcast('task', { task: summarizeTask(t) });
}
function finishTask(t, status = 'done', error = null) {
  if (!t) return;
  t.status = status; t.doneAt = Date.now();
  if (error) t.error = String(error?.message || error);
  if (t.account) taskAccountLocks.delete(t.account);
  sseBroadcast('task', { task: summarizeTask(t) });
}
function isCancelled(t) { return !!t?.cancelled; }

app.get('/api/tasks', (req, res) => {
  const arr = Array.from(tasks.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(summarizeTask);
  ok(res, { tasks: arr });
});
app.get('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return fail(res, new Error('Task not found'));
  ok(res, { task: summarizeTask(t), items: t.items });
});
app.post('/api/tasks/:id/cancel', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return fail(res, new Error('Task not found'));
  if (t.status !== 'running') return fail(res, new Error('Task already finished'));
  t.cancelled = true;
  sseBroadcast('task', { task: summarizeTask(t) });
  ok(res);
});
app.delete('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return fail(res, new Error('Task not found'));
  if (t.status === 'running') return fail(res, new Error('Cannot delete a running task; cancel first'));
  tasks.delete(req.params.id); ok(res);
});

// ═══════════════════════════════════════════════
//  7. SEARCH MANAGER
// ═══════════════════════════════════════════════

// GET /users/{id}/profile  — Discord user profile (mutual_guilds, mutual_friends, badges …)
async function fetchUserProfile(token, userId) {
  const url = `https://discord.com/api/v9/users/${userId}/profile?with_mutual_guilds=true&with_mutual_friends_count=true`;
  const r = await axios.get(url, { headers: { Authorization: token } });
  return r.data;
}
async function fetchUserBasic(token, userId) {
  const r = await axios.get(`https://discord.com/api/v9/users/${userId}`, {
    headers: { Authorization: token }
  });
  return r.data;
}

// Look the user up in any connected client's local caches before hitting the
// Discord API. Many "Unauthorized" errors on /users/{id} are recoverable this
// way (e.g. token rate-limited but the user is in our friend list / guild
// member cache / DM recipients). Returns a minimal Discord-style user object
// or null if no cache hit.
function findUserInCaches(userId) {
  for (const [name, entry] of clients.entries()) {
    const c = entry?.client;
    if (!c) continue;
    // 1) global user cache
    try {
      const u = c.users?.cache?.get?.(userId);
      if (u) return { id: u.id, username: u.username, global_name: u.globalName, discriminator: u.discriminator, avatar: u.avatar, bot: u.bot, _cachedFrom: name };
    } catch (e) {}
    // 2) friend / relationship cache
    try {
      for (const rel of c.relationships?.cache?.values?.() || []) {
        const u = rel.user || rel;
        if (u?.id === userId) return { id: u.id, username: u.username, global_name: u.globalName || u.global_name, discriminator: u.discriminator, avatar: u.avatar, bot: !!u.bot, _cachedFrom: name };
      }
    } catch (e) {}
    // 3) guild member caches
    try {
      for (const g of c.guilds?.cache?.values?.() || []) {
        const m = g.members?.cache?.get?.(userId);
        if (m?.user) {
          const u = m.user;
          return { id: u.id, username: u.username, global_name: u.globalName, discriminator: u.discriminator, avatar: u.avatar, bot: !!u.bot, _cachedFrom: name };
        }
      }
    } catch (e) {}
    // 4) DM recipients
    try {
      for (const ch of c.channels?.cache?.values?.() || []) {
        if (ch.type === 'DM' && ch.recipient?.id === userId) {
          const u = ch.recipient;
          return { id: u.id, username: u.username, global_name: u.globalName, discriminator: u.discriminator, avatar: u.avatar, bot: !!u.bot, _cachedFrom: name };
        }
      }
    } catch (e) {}
  }
  return null;
}

function userToView(u) {
  return {
    id: u.id,
    username: u.username,
    globalName: u.global_name || u.globalName || u.username,
    discriminator: u.discriminator || '0',
    bot: !!u.bot,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}${u.avatar.startsWith('a_') ? '.gif' : '.png'}?size=256`
      : defaultAvatarUrl(u.id),
    banner: u.banner
      ? `https://cdn.discordapp.com/banners/${u.id}/${u.banner}${u.banner.startsWith('a_') ? '.gif' : '.png'}?size=600`
      : null,
    accentColor: u.accent_color || u.accentColor || null,
    bio: u.bio || '',
    pronouns: u.pronouns || '',
    flags: u.public_flags || u.flags || 0,
    createdAt: (() => { try { return Number((BigInt(u.id) >> 22n) + 1420070400000n); } catch { return null; } })()
  };
}

// Voice state finder — scan every connected client's guild caches
function findVoiceForUser(userId, accountFilter = null) {
  const out = [];
  for (const [name, entry] of clients.entries()) {
    if (accountFilter && name !== accountFilter) continue;
    const c = entry.client;
    if (!c?.guilds) continue;
    for (const g of c.guilds.cache.values()) {
      const vs = g.voiceStates?.cache?.get?.(userId);
      if (!vs || !vs.channelId) continue;
      const ch = g.channels?.cache?.get?.(vs.channelId);
      // Snapshot the entire voice room (everyone in it, with their states)
      const occupants = [];
      if (g.voiceStates?.cache) {
        for (const ovs of g.voiceStates.cache.values()) {
          if (ovs.channelId !== vs.channelId) continue;
          const m = g.members?.cache?.get?.(ovs.id);
          occupants.push({
            id: ovs.id,
            username: m?.user?.username || ovs.id,
            displayName: m?.displayName || m?.user?.globalName || m?.user?.username || ovs.id,
            avatar: m?.user?.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(ovs.id),
            self: ovs.id === c.user.id,
            target: ovs.id === userId,
            mute: !!(ovs.mute || ovs.selfMute),
            deaf: !!(ovs.deaf || ovs.selfDeaf),
            video: !!ovs.selfVideo,
            stream: !!ovs.streaming,
            serverMute: !!ovs.serverMute,
            serverDeaf: !!ovs.serverDeaf
          });
        }
      }
      out.push({
        seenBy: name,
        guild: { id: g.id, name: g.name, icon: g.iconURL?.({ size: 64 }) || null },
        channel: { id: ch?.id, name: ch?.name || 'voice', userLimit: ch?.userLimit || 0, type: ch?.type },
        target: {
          mute: !!(vs.mute || vs.selfMute),
          deaf: !!(vs.deaf || vs.selfDeaf),
          video: !!vs.selfVideo,
          stream: !!vs.streaming,
          serverMute: !!vs.serverMute,
          serverDeaf: !!vs.serverDeaf,
          requestToSpeakTimestamp: vs.requestToSpeakTimestamp || null
        },
        occupants
      });
    }
  }
  return out;
}

// Last message search across DMs we share + recent guild caches the user is in
async function findLastMessageForUser(userId, accountFilter = null) {
  const found = [];
  for (const [name, entry] of clients.entries()) {
    if (accountFilter && name !== accountFilter) continue;
    const c = entry.client;
    if (!c?.user) continue;

    // 1) DMs (cheap)
    try {
      for (const ch of c.channels.cache.values()) {
        if (ch.type !== 'DM' || ch.recipient?.id !== userId) continue;
        const last = ch.lastMessage || ch.messages?.cache?.last?.();
        if (last) {
          found.push({
            seenBy: name,
            kind: 'dm',
            channel: { id: ch.id, name: '@' + (ch.recipient?.username || 'dm'), type: 'DM' },
            guild: null,
            message: {
              id: last.id, content: last.content || '',
              ts: last.createdTimestamp || 0,
              attachments: Array.from(last.attachments?.values?.() || []).map(a => ({ url: a.url, name: a.name }))
            }
          });
        }
      }
    } catch (e) {}

    // 2) Guild message search via Discord search API (only guilds where user is a member)
    try {
      for (const g of c.guilds.cache.values()) {
        const member = g.members?.cache?.get?.(userId);
        if (!member) continue;
        try {
          const r = await axios.get(`https://discord.com/api/v9/guilds/${g.id}/messages/search`, {
            headers: { Authorization: c.token },
            params: { author_id: userId, limit: 1 }
          });
          const msg = r.data?.messages?.[0]?.[0];
          if (msg) {
            const ch = g.channels?.cache?.get?.(msg.channel_id);
            found.push({
              seenBy: name, kind: 'guild',
              guild: { id: g.id, name: g.name, icon: g.iconURL?.({ size: 64 }) || null },
              channel: { id: msg.channel_id, name: ch?.name || msg.channel_id, type: ch?.type },
              message: {
                id: msg.id, content: msg.content || '',
                ts: new Date(msg.timestamp).getTime(),
                attachments: (msg.attachments || []).map(a => ({ url: a.url, name: a.filename }))
              }
            });
          }
          await sleep(700 + jitter(0, 400)); // soft anti-rate (raised from 250ms — Discord rate-limits guild search aggressively)
        } catch (e) { /* search not allowed in some guilds */ }
      }
    } catch (e) {}
  }
  return found.sort((a, b) => (b.message?.ts || 0) - (a.message?.ts || 0));
}

// Mutual guilds / friends / DMs across all (or one) account
function gatherMutuals(userId, profileMutualGuilds = [], accountFilter = null) {
  const guildSet = new Map();
  let dms = [];
  for (const [name, entry] of clients.entries()) {
    if (accountFilter && name !== accountFilter) continue;
    const c = entry.client;
    if (!c?.guilds) continue;
    for (const g of c.guilds.cache.values()) {
      if (!g.members?.cache?.has?.(userId)) continue;
      const k = g.id;
      const existing = guildSet.get(k) || { id: g.id, name: g.name, icon: g.iconURL?.({ size: 64 }) || null, sharedBy: [] };
      existing.sharedBy.push(name);
      guildSet.set(k, existing);
    }
    for (const ch of c.channels.cache.values()) {
      if (ch.type === 'DM' && ch.recipient?.id === userId) {
        dms.push({ seenBy: name, channelId: ch.id });
      }
    }
  }
  // Merge with profile-API mutual guilds (covers servers the *target* shares with the requesting account
  // even when we don't have everyone cached)
  for (const mg of profileMutualGuilds || []) {
    if (!guildSet.has(mg.id)) {
      guildSet.set(mg.id, { id: mg.id, name: mg.name || mg.id, icon: mg.icon ? `https://cdn.discordapp.com/icons/${mg.id}/${mg.icon}.png?size=64` : null, sharedBy: ['(via profile API)'] });
    }
  }
  return { mutualGuilds: Array.from(guildSet.values()), mutualDMs: dms };
}

app.get('/api/search/user', async (req, res) => {
  try {
    const id = (req.query.id || '').trim();
    const username = (req.query.username || '').trim().toLowerCase();
    const accountFilter = (req.query.account || '').trim() || null;
    const allAccounts = req.query.all === '1' || req.query.all === 'true';
    if (!id && !username) return fail(res, new Error('Provide id or username'));

    const accountsToUse = (allAccounts || !accountFilter)
      ? Array.from(clients.keys())
      : [accountFilter];
    if (!accountsToUse.length) return fail(res, new Error('No accounts connected'));

    let resolvedId = id;
    let basic = null;
    let resolvedVia = null;

    // 1) ID path: pull authoritative user info
    if (resolvedId) {
      let lastErr = null;
      for (const acct of accountsToUse) {
        const c = clients.get(acct)?.client;
        if (!c?.token) continue;
        try { basic = await fetchUserBasic(c.token, resolvedId); resolvedVia = acct; break; }
        catch (e) { lastErr = e; }
      }
      // Fallback to local caches if every account failed (rate-limit / 401)
      if (!basic) {
        const cached = findUserInCaches(resolvedId);
        if (cached) {
          basic = cached;
          resolvedVia = `cache (${cached._cachedFrom})`;
        } else {
          const reason = lastErr?.response?.status === 401
            ? 'Discord rejected the lookup (token unauthorized for this user). User is not in any of your caches either.'
            : (lastErr?.response?.data?.message || lastErr?.message || 'User not found');
          return fail(res, new Error(reason));
        }
      }
    } else {
      // 2) Username path: fuzzy match against caches (friends/guild members/DMs/recipients)
      const candidates = new Map();
      for (const acct of accountsToUse) {
        const c = clients.get(acct)?.client;
        if (!c) continue;
        // friends via REST
        try {
          const r = await axios.get('https://discord.com/api/v9/users/@me/relationships', { headers: { Authorization: c.token } });
          for (const rel of r.data || []) {
            if (rel.type !== 1) continue;
            const u = rel.user || rel;
            const name = (u.username || '').toLowerCase();
            const gname = (u.global_name || '').toLowerCase();
            if (name === username || gname === username || name.includes(username) || gname.includes(username)) {
              candidates.set(u.id, u);
            }
          }
        } catch (e) {}
        // guild members caches
        for (const g of c.guilds?.cache?.values?.() || []) {
          for (const m of g.members?.cache?.values?.() || []) {
            const u = m.user;
            const name = (u.username || '').toLowerCase();
            const gname = (u.globalName || '').toLowerCase();
            const display = (m.displayName || '').toLowerCase();
            if (name === username || gname === username || display === username ||
                name.includes(username) || gname.includes(username) || display.includes(username)) {
              candidates.set(u.id, { id: u.id, username: u.username, global_name: u.globalName, avatar: u.avatar, bot: u.bot });
            }
          }
        }
        // DM recipients
        for (const ch of c.channels?.cache?.values?.() || []) {
          if (ch.type !== 'DM' || !ch.recipient) continue;
          const u = ch.recipient;
          const name = (u.username || '').toLowerCase();
          const gname = (u.globalName || '').toLowerCase();
          if (name === username || gname === username || name.includes(username) || gname.includes(username)) {
            candidates.set(u.id, { id: u.id, username: u.username, global_name: u.globalName, avatar: u.avatar, bot: u.bot });
          }
        }
      }
      if (!candidates.size) return fail(res, new Error(`No user matches "${username}" in your accessible caches. Try the user's ID.`));
      // If multiple, return list for disambiguation
      if (candidates.size > 1) {
        const arr = Array.from(candidates.values()).map(userToView).slice(0, 20);
        return ok(res, { multiple: true, candidates: arr });
      }
      basic = Array.from(candidates.values())[0];
      resolvedId = basic.id;
      // Re-fetch authoritative info to enrich
      for (const acct of accountsToUse) {
        const c = clients.get(acct)?.client;
        if (!c?.token) continue;
        try { basic = await fetchUserBasic(c.token, resolvedId); resolvedVia = acct; break; } catch (e) {}
      }
    }

    const view = userToView(basic);

    // Profile (mutuals) — best with any single account
    let profileMutualGuilds = [];
    let mutualFriendsCount = 0;
    let badges = [];
    for (const acct of accountsToUse) {
      const c = clients.get(acct)?.client;
      if (!c?.token) continue;
      try {
        const p = await fetchUserProfile(c.token, resolvedId);
        profileMutualGuilds = p.mutual_guilds || [];
        mutualFriendsCount = p.mutual_friends_count || 0;
        badges = p.badges || p.user?.public_flags ? (p.badges || []) : [];
        break;
      } catch (e) {}
    }

    const mutuals = gatherMutuals(resolvedId, profileMutualGuilds, accountFilter);
    const voice = findVoiceForUser(resolvedId, accountFilter);
    let lastMessage = null;
    try {
      const msgs = await findLastMessageForUser(resolvedId, accountFilter);
      if (msgs.length) lastMessage = msgs[0];
    } catch (e) {}

    ok(res, {
      user: view,
      resolvedVia,
      mutualGuilds: mutuals.mutualGuilds,
      mutualDMs: mutuals.mutualDMs,
      mutualFriendsCount,
      badges,
      voice,            // array — if non-empty, user is currently in a voice channel we can see
      lastMessage,      // single most-recent across our visible channels (DMs + guild search)
      accountsScanned: accountsToUse
    });
  } catch (e) { fail(res, e); }
});

// Quick endpoint: poll voice state only (used by SearchManager auto-refresh)
app.get('/api/search/voice/:userId', (req, res) => {
  const accountFilter = (req.query.account || '').trim() || null;
  ok(res, { voice: findVoiceForUser(req.params.userId, accountFilter) });
});

// Quick endpoint: refresh just last message
app.get('/api/search/last-message/:userId', async (req, res) => {
  try {
    const accountFilter = (req.query.account || '').trim() || null;
    const list = await findLastMessageForUser(req.params.userId, accountFilter);
    ok(res, { messages: list.slice(0, 5) });
  } catch (e) { fail(res, e); }
});

// Fast user suggest from local cache — zero Discord API calls, <10ms response
app.get('/api/search/suggest', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 1) return ok(res, { suggestions: [] });
  const accountFilter = (req.query.account || '').trim() || null;
  const accountsToUse = accountFilter ? [accountFilter] : Array.from(clients.keys());
  const seen = new Map();
  const tryAdd = (u, displayName) => {
    if (seen.size >= 25 || !u?.id) return;
    const uname  = (u.username   || '').toLowerCase();
    const gname  = (u.globalName || u.global_name || '').toLowerCase();
    const dname  = (displayName  || gname || uname).toLowerCase();
    if (!uname.includes(q) && !gname.includes(q) && !dname.includes(q)) return;
    if (!seen.has(u.id)) {
      seen.set(u.id, {
        id: u.id,
        username:   u.username || '',
        globalName: u.globalName || u.global_name || u.username || '',
        avatar: u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
          : defaultAvatarUrl(u.id)
      });
    }
  };
  for (const acct of accountsToUse) {
    const c = clients.get(acct)?.client;
    if (!c) continue;
    for (const ch of c.channels?.cache?.values?.() || []) {
      if (ch.type !== 'DM' || !ch.recipient) continue;
      tryAdd(ch.recipient, null);
    }
    for (const g of c.guilds?.cache?.values?.() || []) {
      for (const m of g.members?.cache?.values?.() || []) {
        if (seen.size >= 25) break;
        tryAdd(m.user, m.displayName);
      }
      if (seen.size >= 25) break;
    }
  }
  ok(res, { suggestions: Array.from(seen.values()).slice(0, 10) });
});

// ═══════════════════════════════════════════════
//  8. MASS FRIEND OPERATIONS
//  All bulk ops run through the task system.
//  Conservative throttling: default 1 req / 6-10s, capped at 30/hr/account.
// ═══════════════════════════════════════════════
async function relationshipPut(token, userId) {
  // Adds friend by ID
  await axios.put(`https://discord.com/api/v9/users/@me/relationships/${userId}`,
    {}, { headers: { Authorization: token, 'Content-Type': 'application/json' } });
}
async function relationshipDelete(token, userId) {
  await axios.delete(`https://discord.com/api/v9/users/@me/relationships/${userId}`,
    { headers: { Authorization: token } });
}
async function fetchGuildMembers(client, guildId, max = 1000) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Guild not found');
  try { await guild.members.fetch({ time: 30000 }); } catch (e) {}
  return Array.from(guild.members.cache.values()).slice(0, max);
}

function applyMemberFilter(members, f = {}) {
  return members.filter(m => {
    const u = m.user;
    if (!u) return false;
    if (f.excludeBots && u.bot) return false;
    if (f.botsOnly && !u.bot) return false;
    if (f.excludeIds?.length && f.excludeIds.includes(u.id)) return false;
    if (f.includeIds?.length && !f.includeIds.includes(u.id)) return false;
    if (f.usernameContains) {
      const q = f.usernameContains.toLowerCase();
      if (!(u.username || '').toLowerCase().includes(q) &&
          !(u.globalName || '').toLowerCase().includes(q) &&
          !(m.displayName || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

// POST /api/friends/bulk-add
//   body: { account, ids?:[], serverId?, filter?:{}, throttleMs?: 7000, max?: 50 }
//   Returns: { taskId }
// Per-account rolling 1-hour quota of friend-adds. Discord bans accounts
// that send too many invites — we cap at 30/h regardless of UI input.
const MASS_FRIEND_HOURLY_CAP = 30;
const _friendAddHistory = new Map(); // account -> [timestamps]
function _recordFriendAdd(account) {
  const arr = _friendAddHistory.get(account) || [];
  arr.push(Date.now());
  _friendAddHistory.set(account, arr);
}
function _friendAddsInLastHour(account) {
  const cutoff = Date.now() - 3600 * 1000;
  const arr = (_friendAddHistory.get(account) || []).filter(t => t >= cutoff);
  _friendAddHistory.set(account, arr);
  return arr.length;
}

app.post('/api/friends/bulk-add', async (req, res) => {
  try {
    const { account, ids = [], serverId, filter = {}, throttleMs = 7000, max = 50 } = req.body || {};
    if (!account) return fail(res, new Error('account is required'));
    const c = clients.get(account)?.client;
    if (!c?.token) return fail(res, new Error('Account not connected'));

    let targetUsers = [];
    if (Array.isArray(ids) && ids.length) {
      targetUsers = ids.map(id => ({ id, username: id }));
    } else if (serverId) {
      const members = await fetchGuildMembers(c, serverId, 2000);
      // Auto-exclude bots in addition to user filter — adding bots as friends
      // is impossible and just wastes quota
      const filtered = applyMemberFilter(members, { excludeBots: true, ...filter, excludeIds: [c.user.id, ...(filter.excludeIds || [])] });
      targetUsers = filtered.map(m => ({ id: m.user.id, username: m.user.username, globalName: m.user.globalName, avatar: m.user.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(m.user.id) }));
    } else {
      return fail(res, new Error('Provide ids[] or serverId'));
    }
    if (!targetUsers.length) return fail(res, new Error('No users matched'));
    targetUsers = targetUsers.slice(0, Math.max(1, Math.min(500, max)));

    // Enforce hourly cap up-front: trim the queue to whatever we can still send
    const usedThisHour = _friendAddsInLastHour(account);
    const remaining = Math.max(0, MASS_FRIEND_HOURLY_CAP - usedThisHour);
    if (remaining === 0) {
      return fail(res, new Error(`Hourly safety cap reached for "${account}" (${MASS_FRIEND_HOURLY_CAP}/hr). Try again later.`));
    }
    if (targetUsers.length > remaining) targetUsers = targetUsers.slice(0, remaining);

    const t = createTask({
      type: 'friend_add', account,
      label: serverId ? `Add ${targetUsers.length} from server ${serverId}` : `Add ${targetUsers.length} by IDs`,
      total: targetUsers.length
    });

    (async () => {
      // Floor delay raised to 5s — sub-3s adds are a major ban signal
      const delay = Math.max(5000, throttleMs);
      let consecutiveFails = 0;
      for (const u of targetUsers) {
        if (isCancelled(t)) break;
        // Re-check hourly cap inside the loop in case other tasks ran in parallel
        if (_friendAddsInLastHour(account) >= MASS_FRIEND_HOURLY_CAP) {
          t.error = `Hourly safety cap reached (${MASS_FRIEND_HOURLY_CAP}/hr) — stopping early.`;
          break;
        }
        try {
          await relationshipPut(c.token, u.id);
          _recordFriendAdd(account);
          pushTaskItem(t, { ok: true, id: u.id, username: u.username, ts: Date.now() });
          consecutiveFails = 0;
        } catch (e) {
          const msg = e?.response?.data?.message || e?.message || 'failed';
          const code = e?.response?.status;
          pushTaskItem(t, { ok: false, id: u.id, username: u.username, error: msg, code, ts: Date.now() });
          if (code === 429) {
            const retry = Number(e.response?.data?.retry_after || 5);
            await sleep((retry + 1) * 1000);
          } else if (code === 401 || code === 403) {
            // Account-wide block — stop NOW, don't drain the rest
            t.error = `Discord blocked friend requests on this account (${code}). Stopping to avoid escalation.`;
            break;
          } else {
            consecutiveFails++;
            if (consecutiveFails >= 5) {
              t.error = 'Too many consecutive failures — stopping to protect the account from a ban.';
              break;
            }
          }
        }
        await sleep(delay + jitter(0, 1500));
      }
      finishTask(t, isCancelled(t) ? 'cancelled' : 'done');
    })().catch(e => finishTask(t, 'failed', e));

    ok(res, { taskId: t.id, hourlyCap: MASS_FRIEND_HOURLY_CAP, remainingThisHour: Math.max(0, MASS_FRIEND_HOURLY_CAP - _friendAddsInLastHour(account)) });
  } catch (e) { fail(res, e); }
});

// POST /api/friends/bulk-remove
//   body: { account, mode: 'all' | 'server' | 'ids', serverId?, ids?, filter?, throttleMs? }
app.post('/api/friends/bulk-remove', async (req, res) => {
  try {
    const { account, mode, serverId, ids = [], filter = {}, throttleMs = 4000 } = req.body || {};
    if (!account) return fail(res, new Error('account is required'));
    const c = clients.get(account)?.client;
    if (!c?.token) return fail(res, new Error('Account not connected'));

    // Pull current friends list
    const r = await axios.get('https://discord.com/api/v9/users/@me/relationships', { headers: { Authorization: c.token } });
    const friends = (r.data || []).filter(x => x.type === 1).map(x => x.user);
    let targets = [];

    if (mode === 'all') {
      targets = friends;
    } else if (mode === 'ids') {
      const set = new Set(ids);
      targets = friends.filter(u => set.has(u.id));
    } else if (mode === 'server') {
      if (!serverId) return fail(res, new Error('serverId required'));
      const members = await fetchGuildMembers(c, serverId, 2000);
      const memberIds = new Set(members.map(m => m.user.id));
      targets = friends.filter(u => memberIds.has(u.id));
    } else {
      return fail(res, new Error('mode must be all|server|ids'));
    }
    if (filter && Object.keys(filter).length) {
      targets = targets.filter(u => {
        if (filter.excludeBots && u.bot) return false;
        if (filter.usernameContains) {
          const q = filter.usernameContains.toLowerCase();
          if (!(u.username || '').toLowerCase().includes(q) &&
              !(u.global_name || '').toLowerCase().includes(q)) return false;
        }
        return true;
      });
    }
    if (!targets.length) return fail(res, new Error('No friends matched the criteria'));

    const t = createTask({
      type: 'friend_remove', account,
      label: `Remove ${targets.length} friend(s) (${mode})`,
      total: targets.length
    });

    (async () => {
      const delay = Math.max(2000, throttleMs);
      for (const u of targets) {
        if (isCancelled(t)) break;
        try {
          await relationshipDelete(c.token, u.id);
          pushTaskItem(t, { ok: true, id: u.id, username: u.username, ts: Date.now() });
        } catch (e) {
          const msg = e?.response?.data?.message || e?.message || 'failed';
          const code = e?.response?.status;
          pushTaskItem(t, { ok: false, id: u.id, username: u.username, error: msg, code, ts: Date.now() });
          if (code === 429) {
            const retry = Number(e.response?.data?.retry_after || 5);
            await sleep((retry + 1) * 1000);
          }
        }
        await sleep(delay + jitter(0, 1000));
      }
      finishTask(t, isCancelled(t) ? 'cancelled' : 'done');
    })().catch(e => finishTask(t, 'failed', e));

    ok(res, { taskId: t.id });
  } catch (e) { fail(res, e); }
});

// Lightweight server-members lookup for the UI to preview before kicking off a task
app.get('/api/discord/servers/:serverId/members', async (req, res) => {
  try {
    const c = pickClient(req);
    if (!c?.user) return fail(res, new Error('Not connected'));
    const guild = c.guilds.cache.get(req.params.serverId);
    if (!guild) return fail(res, new Error('Server not found'));
    try { await guild.members.fetch({ time: 20000 }); } catch (e) {}
    const arr = Array.from(guild.members.cache.values()).slice(0, 1500).map(m => ({
      id: m.user.id,
      username: m.user.username,
      displayName: m.displayName || m.user.globalName || m.user.username,
      avatar: m.user.displayAvatarURL?.({ size: 64 }) || defaultAvatarUrl(m.user.id),
      bot: !!m.user.bot
    }));
    ok(res, { members: arr, total: guild.memberCount || arr.length });
  } catch (e) { fail(res, e); }
});

// ═══════════════════════════════════════════════
//  9. PRIVATE MESSAGE DELETE TRACKING (real-time)
// ═══════════════════════════════════════════════
function attachDMDeleteListener(name, client, ownerUid) {
  ownerUid = ownerUid || currentUserId();
  if (client.__dmDeleteListenerBound) return;
  client.__dmDeleteListenerBound = true;
  client.on('messageDelete', (msg) => withUser(ownerUid, () => {
    try {
      if (!msg.channel || msg.channel.type !== 'DM') return;
      const payload = JSON.stringify({
        type: 'dm_delete',
        account: name,
        channelId: msg.channel.id,
        messageId: msg.id,
        ts: Date.now()
      });
      for (const sc of sseClients) {
        if (!sc.account || sc.account === name) {
          try { sc.res.write(`data: ${payload}\n\n`); } catch (e) {}
        }
      }
    } catch (e) {}
  }));
}
// Listeners are bound during connectOne(); no need to re-iterate here.

// ═══════════════════════════════════════════════
//  10. VOICE MANAGER
// ═══════════════════════════════════════════════

// In-memory state
const voiceSessions   = new Map(); // "<name>_<guildId>" -> { name, guildId, channelId, selfMute, selfDeaf, selfVideo, selfStream }
const voiceRotations  = new Map(); // rotationId -> { id, name, guildId, channels, intervalMs, randomOrder, timer, currentIdx, nextAt }
const voiceStateCycles= new Map(); // cycleId    -> { id, accounts, states, intervalMs, timer, currentIdx, nextAt }

// ── Voice Persistence (auto-rejoin on restart) ──────────────────────────────
// Per-user voice persistence — voice sessions auto-rejoin on restart.
const voicePersistStore = scopedStore('voice-persist.json', []);

function persistVoice() {
  try {
    voicePersistStore.write(Array.from(voiceSessions.values()));
  } catch (e) { /* non-fatal */ }
}

function loadVoicePersist() {
  try {
    const v = voicePersistStore.read();
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

// Wrappers that persist on every mutation
function vsSet(key, val) { voiceSessions.set(key, val); persistVoice(); }
function vsDel(key)      { voiceSessions.delete(key);   persistVoice(); }

function sendVoiceOp(client, guildId, channelId, selfMute = false, selfDeaf = false, selfVideo = false, selfStream = false) {
  try {
    const shard = client.ws?.shards?.first?.() || client.ws?.shards?.get?.(0);
    if (!shard) return false;
    shard.send({
      op: 4,
      d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf, self_video: selfVideo, self_stream: selfStream }
    });
    return true;
  } catch (e) { return false; }
}

function getVoiceClient(name) {
  const entry = clients.get(name);
  if (!entry?.client?.ws) return null;
  return entry.client;
}

function voiceSessionKey(name, guildId) { return `${name}__${guildId}`; }

// GET /api/voice/guilds — list all guilds with their voice channels for an account
app.get('/api/voice/guilds', (req, res) => {
  const { account } = req.query;
  const targets = account ? [[account, clients.get(account)]] : Array.from(clients.entries());
  const results = [];
  for (const [name, entry] of targets) {
    if (!entry?.client?.guilds) continue;
    for (const [, guild] of entry.client.guilds.cache) {
      const voiceChannels = guild.channels.cache
        .filter(c => c.type === 'GUILD_VOICE' || c.type === 2)
        .map(c => ({
          id: c.id,
          name: c.name,
          userLimit: c.userLimit || 0,
          members: c.members?.size || 0,
          bitrate: Math.round((c.bitrate || 64000) / 1000)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (voiceChannels.length > 0) {
        results.push({ account: name, guildId: guild.id, guildName: guild.name, guildIcon: guild.iconURL?.({ size: 64 }) || null, voiceChannels });
      }
    }
  }
  ok(res, { guilds: results });
});

// GET /api/voice/sessions — list all active voice sessions
app.get('/api/voice/sessions', (req, res) => {
  ok(res, { sessions: Array.from(voiceSessions.values()) });
});

// GET /api/voice/rotations — list channel rotations
app.get('/api/voice/rotations', (req, res) => {
  const list = Array.from(voiceRotations.values()).map(r => ({
    id: r.id, name: r.name, guildId: r.guildId, guildName: r.guildName,
    channels: r.channels, intervalMs: r.intervalMs, randomOrder: r.randomOrder,
    currentIdx: r.currentIdx, nextAt: r.nextAt, accounts: r.accounts
  }));
  ok(res, { rotations: list });
});

// GET /api/voice/state-cycles — list state cycles
app.get('/api/voice/state-cycles', (req, res) => {
  const list = Array.from(voiceStateCycles.values()).map(c => ({
    id: c.id, accounts: c.accounts, states: c.states,
    intervalMs: c.intervalMs, currentIdx: c.currentIdx, nextAt: c.nextAt
  }));
  ok(res, { cycles: list });
});

// POST /api/voice/join — join a voice channel
app.post('/api/voice/join', (req, res) => {
  const { accounts, guildId, channelId, selfMute = false, selfDeaf = false } = req.body;
  const targets = Array.isArray(accounts) ? accounts : [accounts].filter(Boolean);
  if (!targets.length) return fail(res, new Error('No accounts specified'));
  if (!guildId || !channelId) return fail(res, new Error('guildId and channelId required'));
  const results = [];
  for (const name of targets) {
    const client = getVoiceClient(name);
    if (!client) { results.push({ name, ok: false, error: 'Not connected' }); continue; }
    const sent = sendVoiceOp(client, guildId, channelId, selfMute, selfDeaf, false, false);
    if (sent) {
      const key = voiceSessionKey(name, guildId);
      vsSet(key, { name, guildId, channelId, selfMute, selfDeaf, selfVideo: false, selfStream: false, joinedAt: Date.now() });
    }
    results.push({ name, ok: sent, error: sent ? null : 'Failed to send voice op' });
  }
  ok(res, { results });
});

// POST /api/voice/leave — leave voice channel
app.post('/api/voice/leave', (req, res) => {
  const { accounts, guildId } = req.body;
  const targets = Array.isArray(accounts) ? accounts : [accounts].filter(Boolean);
  const results = [];
  for (const name of targets) {
    const client = getVoiceClient(name);
    if (!client) { results.push({ name, ok: false }); continue; }
    const sent = sendVoiceOp(client, guildId, null, false, false, false, false);
    const key = voiceSessionKey(name, guildId);
    vsDel(key);
    results.push({ name, ok: sent });
  }
  ok(res, { results });
});

// POST /api/voice/state — update voice state (mute/deaf/video/stream)
app.post('/api/voice/state', (req, res) => {
  const { accounts, guildId, selfMute, selfDeaf, selfVideo, selfStream } = req.body;
  const targets = Array.isArray(accounts) ? accounts : [accounts].filter(Boolean);
  const results = [];
  for (const name of targets) {
    const client = getVoiceClient(name);
    if (!client) { results.push({ name, ok: false }); continue; }
    const key = voiceSessionKey(name, guildId);
    const sess = voiceSessions.get(key);
    const chId = sess?.channelId || null;
    const sm = selfMute  !== undefined ? selfMute  : (sess?.selfMute  || false);
    const sd = selfDeaf  !== undefined ? selfDeaf  : (sess?.selfDeaf  || false);
    const sv = selfVideo !== undefined ? selfVideo : (sess?.selfVideo || false);
    const ss = selfStream!== undefined ? selfStream: (sess?.selfStream|| false);
    const sent = sendVoiceOp(client, guildId, chId, sm, sd, sv, ss);
    if (sent && sess) { Object.assign(sess, { selfMute: sm, selfDeaf: sd, selfVideo: sv, selfStream: ss }); persistVoice(); }
    results.push({ name, ok: sent });
  }
  ok(res, { results });
});

// POST /api/voice/join-all — join all connected accounts to one channel
app.post('/api/voice/join-all', (req, res) => {
  const { guildId, channelId, selfMute = false, selfDeaf = false } = req.body;
  if (!guildId || !channelId) return fail(res, new Error('guildId and channelId required'));
  const results = [];
  for (const [name, entry] of clients.entries()) {
    if (!entry?.client?.ws) continue;
    const sent = sendVoiceOp(entry.client, guildId, channelId, selfMute, selfDeaf, false, false);
    if (sent) vsSet(voiceSessionKey(name, guildId), { name, guildId, channelId, selfMute, selfDeaf, selfVideo: false, selfStream: false, joinedAt: Date.now() });
    results.push({ name, ok: sent });
  }
  ok(res, { results });
});

// POST /api/voice/distribute-random — randomly distribute accounts across voice channels
app.post('/api/voice/distribute-random', (req, res) => {
  const { accounts, guildId, channelIds } = req.body;
  if (!Array.isArray(channelIds) || !channelIds.length) return fail(res, new Error('channelIds required'));
  const targets = Array.isArray(accounts) && accounts.length ? accounts : Array.from(clients.keys());
  const results = [];
  const shuffled = [...channelIds].sort(() => Math.random() - 0.5);
  targets.forEach((name, i) => {
    const client = getVoiceClient(name);
    if (!client) { results.push({ name, ok: false, channelId: null }); return; }
    const channelId = shuffled[i % shuffled.length];
    const sent = sendVoiceOp(client, guildId, channelId, false, false, false, false);
    if (sent) vsSet(voiceSessionKey(name, guildId), { name, guildId, channelId, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, joinedAt: Date.now() });
    results.push({ name, ok: sent, channelId });
  });
  ok(res, { results });
});

// POST /api/voice/rotation/start — rotate between voice channels on a timer
app.post('/api/voice/rotation/start', (req, res) => {
  const { accounts, guildId, guildName, channelIds, intervalMs = 3600000, randomOrder = false } = req.body;
  if (!Array.isArray(channelIds) || channelIds.length < 2) return fail(res, new Error('At least 2 channelIds required'));
  const targets = Array.isArray(accounts) && accounts.length ? accounts : Array.from(clients.keys());
  const id = `vr_${Date.now()}`;
  const rotation = {
    id, accounts: targets, guildId, guildName: guildName || guildId,
    channels: channelIds, intervalMs, randomOrder, currentIdx: 0,
    nextAt: Date.now() + intervalMs
  };

  function doRotate() {
    let idx;
    if (randomOrder) idx = Math.floor(Math.random() * channelIds.length);
    else { rotation.currentIdx = (rotation.currentIdx + 1) % channelIds.length; idx = rotation.currentIdx; }
    const channelId = channelIds[idx];
    rotation.nextAt = Date.now() + intervalMs;
    for (const name of targets) {
      const client = getVoiceClient(name);
      if (!client) continue;
      sendVoiceOp(client, guildId, channelId, false, false, false, false);
      const key = voiceSessionKey(name, guildId);
      const sess = voiceSessions.get(key);
      if (sess) sess.channelId = channelId;
      else vsSet(key, { name, guildId, channelId, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, joinedAt: Date.now() });
    }
  }

  // Join initial channel
  const firstChannel = channelIds[0];
  for (const name of targets) {
    const client = getVoiceClient(name);
    if (!client) continue;
    sendVoiceOp(client, guildId, firstChannel, false, false, false, false);
    vsSet(voiceSessionKey(name, guildId), { name, guildId, channelId: firstChannel, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, joinedAt: Date.now() });
  }

  rotation.timer = setInterval(doRotate, intervalMs);
  voiceRotations.set(id, rotation);
  ok(res, { id, message: 'Rotation started' });
});

// POST /api/voice/rotation/stop
app.post('/api/voice/rotation/stop', (req, res) => {
  const { id } = req.body;
  const rot = voiceRotations.get(id);
  if (!rot) return fail(res, new Error('Rotation not found'));
  clearInterval(rot.timer);
  voiceRotations.delete(id);
  ok(res, { ok: true });
});

// POST /api/voice/state-cycle/start — cycle voice states on a timer
app.post('/api/voice/state-cycle/start', (req, res) => {
  const { accounts, guildId, states, intervalMs = 3600000 } = req.body;
  // states: array of objects { selfMute, selfDeaf, selfVideo, selfStream }
  if (!Array.isArray(states) || states.length < 2) return fail(res, new Error('At least 2 states required'));
  const targets = Array.isArray(accounts) && accounts.length ? accounts : Array.from(clients.keys());
  const id = `vsc_${Date.now()}`;
  const cycle = { id, accounts: targets, guildId, states, intervalMs, currentIdx: 0, nextAt: Date.now() + intervalMs };

  function applyState(stateObj) {
    cycle.currentIdx = (cycle.currentIdx + 1) % states.length;
    const s = states[cycle.currentIdx];
    cycle.nextAt = Date.now() + intervalMs;
    for (const name of targets) {
      const client = getVoiceClient(name);
      if (!client) continue;
      const key = voiceSessionKey(name, guildId);
      const sess = voiceSessions.get(key);
      const chId = sess?.channelId || null;
      if (!chId) continue;
      sendVoiceOp(client, guildId, chId, !!s.selfMute, !!s.selfDeaf, !!s.selfVideo, !!s.selfStream);
      if (sess) Object.assign(sess, { selfMute: !!s.selfMute, selfDeaf: !!s.selfDeaf, selfVideo: !!s.selfVideo, selfStream: !!s.selfStream });
    }
  }

  // Apply first state immediately
  const s0 = states[0];
  for (const name of targets) {
    const client = getVoiceClient(name);
    if (!client) continue;
    const key = voiceSessionKey(name, guildId);
    const sess = voiceSessions.get(key);
    const chId = sess?.channelId || null;
    if (!chId) continue;
    sendVoiceOp(client, guildId, chId, !!s0.selfMute, !!s0.selfDeaf, !!s0.selfVideo, !!s0.selfStream);
    if (sess) Object.assign(sess, { selfMute: !!s0.selfMute, selfDeaf: !!s0.selfDeaf, selfVideo: !!s0.selfVideo, selfStream: !!s0.selfStream });
  }

  cycle.timer = setInterval(applyState, intervalMs);
  voiceStateCycles.set(id, cycle);
  ok(res, { id, message: 'State cycle started' });
});

// POST /api/voice/state-cycle/stop
app.post('/api/voice/state-cycle/stop', (req, res) => {
  const { id } = req.body;
  const cycle = voiceStateCycles.get(id);
  if (!cycle) return fail(res, new Error('Cycle not found'));
  clearInterval(cycle.timer);
  voiceStateCycles.delete(id);
  ok(res, { ok: true });
});

app.listen(PORT, '0.0.0.0', async () => {
  const banner = `
╔══════════════════════════════════════════════════╗
║  Discord Account Manager — by Ahmed (@4_3a)      ║
║  Local URL : http://localhost:${PORT}                ║
╚══════════════════════════════════════════════════╝
`;
  console.log(banner);

  // Auto-connect saved tokens (non-blocking)
  autoConnectSaved();

  // Open browser only when running locally (not on Replit)
  const isReplit = !!(process.env.REPL_ID || process.env.REPLIT_DEV_DOMAIN || process.env.REPL_SLUG);
  if (!isReplit && !process.env.NO_OPEN) {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
