# Discord Account Manager

A web-based Discord account manager built originally as an Electron desktop app, converted to run as a full-stack web application. Developed by **Ahmed Dev** (`@4_3a`).

## Architecture

- **Backend**: Express.js server (`server.js`) on port 5000 serving both the REST API and static frontend files.
- **Frontend**: Vanilla JS + HTML/CSS with ES modules (`index.html`, `src/`).
- **Discord integration**: `discord.js-selfbot-v13` — maintains a live multi-client pool in server memory (one client per connected token).
- **Security layer** (Apr 2026):
  - Master password (bcrypt-hashed in `data/auth.json`) gates the entire app.
  - First boot redirects to `/login` for setup; subsequent runs redirect to `/login` for sign-in.
  - Session cookies via `express-session` (7-day rolling, HttpOnly, SameSite=Lax, signed with `data/.session_secret`).
  - All `/api/*` (except `/api/auth/*`) require an authenticated session — unauthenticated requests get HTTP 401.
  - Saved Discord tokens are encrypted at rest with **AES-256-GCM** (`lib/crypto.js`); the master key lives in `data/.master_key` (mode 600) or `MASTER_KEY` env. Tokens stored as `v1:iv:tag:ciphertext`.
  - `helmet` sets standard security headers (HSTS, X-Frame-Options, nosniff, etc).
  - `express-rate-limit`: 300 req/min per IP for `/api/*`, 30 req/5min for `/api/auth/*` (brute-force defence).
  - Per-IP login backoff (exponential, max 4 s) on top of the rate limiter.
- **Storage layer** (`lib/jsonStore.js`): atomic JSON writes (tmp+rename), per-file mutex queue, debounced 250 ms coalescing, in-memory cache, 3 rolling backups (`.bak.0/1/2`), automatic restore from backup on read failure, sync flush on SIGINT/SIGTERM.
- **Per-account proxy** (`lib/proxy.js`, Apr 2026): Each saved account can route ALL its traffic (REST + WebSocket) through its own proxy. Supports `http://`, `https://`, `socks://`, `socks4://`, `socks5://` (with optional `user:pass@`). Proxy URLs are encrypted at rest alongside the token (AES-256-GCM) and **always masked** when sent to the UI (`http://***:***@host:port`). New endpoints: `PUT /api/tokens/:name/proxy` (set/clear) and `POST /api/tokens/:name/proxy/test` (live egress-IP check via `api.ipify.org` with 8 s timeout). The Tokens UI gained a Proxy button per saved account that prompts, tests, and saves in one flow, plus a purple `PROXY` pill on connected accounts.

### Key Files

- `server.js` — Express server: multi-client pool, anti-detection helpers, all REST endpoints (presence, bio, avatar, status rotation, activity simulator, messages, reactions).
- `src/api.js` — Browser-side shim that replaces `window.electronAPI` with fetch calls.
- `src/main.js` — Frontend entry point, theme + language toggle, mobile drawer.
- `src/utils/i18n.js` — Bilingual (English / Arabic) translation system with full RTL support. Re-renders all dynamic managers (Tokens / Messages / Reactions / Old) when language is switched.
- `src/utils/icons.js` — Inline Lucide-style SVG icon set (`icon(name, cls)`); zero network requests, themed via `currentColor`. Replaces all decorative emojis throughout the UI.
- `src/styles/icons.css` — Icon sizing rules + the lightweight CSS-only **snowfall background** (20 GPU-accelerated particles, respects `prefers-reduced-motion`).
- `src/components/` — UI managers:
  - Friends, Servers, DMs, Groups (legacy)
  - **TokensManager** — multi-account hub. Tabs: Accounts · Presence · Bio · **Avatar** · Rotate Status · **Activity Simulator**. Every tab supports both per-selection and **Apply to ALL connected** actions.
  - **MessagesManager** — send to server channels / all DMs / all groups, multi-message panels, repeat (fast/natural), schedule. In test mode every action shows a Discord-style preview toast.
  - **ReactionManager** — auto-react with mirror or specific emojis, auto-click buttons by name. Test mode shows preview toast.
  - **OldManager** (DM/Group) — message cards include a **Copy Link** button.
  - **PrivateManager** — real-time chat-style DM viewer. Pick any account, see all DMs with unread red-dot badges, switch accounts on the fly, open chat to type/reply, live-updated via SSE (`/api/private/stream`), bots-only filter and search included.
  - **StatsManager** — quick analytics dashboard (saved/connected accounts, servers, owned servers, total members, DMs split by humans/bots, groups, recent DM activity).
  - **LookupManager** — look up any server by ID. Returns full guild details if joined (text/voice channels, owner, your roles + join date, boosts, features, banner) or public preview (members, online, description) if not.
- All Friends / Servers / DMs / Groups managers now ship with an account-picker dropdown for true multi-account viewing; DMs add a **bots-only** toggle, Groups gracefully fall back to gradient initials when the icon is missing.
- `src/utils/` — Helpers: `tokenManager`, `messageDeleter` (parallel + adaptive throttle), `ui` (notifications, modals, **showTestPreview**), `i18n`, `taskBar` (global background-task progress bar).
- `src/components/SearchManager.js` — Find any user by ID/username (even non-friends), shows mutual servers, last message, live voice state with all occupants, "screenshot voice" export.
  - **VoiceManager** (`src/components/VoiceManager.js`) — Full voice channel control panel. Features: join/leave specific voice channels per account, join all accounts to one channel, random distribution across channels, per-account voice state presets (Unmuted / Muted / Deafened / Camera / Screen Share), auto state cycling on a configurable timer, room rotation that moves accounts between voice channels at set intervals (sequential or random), live session monitoring with quick-leave buttons, and running task management. Backend routes at `/api/voice/*` use Gateway opcode 4 (voice state update) via `guild.shard.send()`.
- `src/components/MassFriendManager.js` — Bulk add/remove friends from a server with filters and rate-limited background tasks (anti-ban defaults: 7s/req, max 50/run, stops on 5 consecutive failures).
- Background task system (`server.js`): single task per account, live SSE updates on `/api/features/stream`, ring-buffer of 60 most recent tasks, cancel + clear endpoints.
- PrivateManager: deleted DM messages now stay visible in red strike-through with `(محذوف)` mark via real-time `messageDelete` SSE event; image attachments are sent with proper extension/mime so Discord renders them as inline previews.
- Login: luxurious animated screen with Discord logo, floating orbs, animated arrow indicators, support (`discord.gg/ens`) and Instagram (`@a_13qn`) cards. Bottom-right floating hamburger always-on shortcut to support server.
- `src/styles/managers.css` — Styles for new managers + animations + RTL + responsive + test preview toast.
- `src/utils/ui.js` — Now exports `showToast`, `pulseButton`, `showConfirm`, and `shakeFail` for unified UX feedback (bottom-right toasts, save-button pulse states, confirmation dialogs, fail-shake animation on invalid clicks).
- `src/utils/sounds.js` — Refined to elegant, low-volume sine-only tones with low-pass filtering.

## Recent UX/design improvements (Apr 2026)

- Burger features menu (top-right) is hidden until login; duplicate items (Search, Mass Friend, History Log) removed since they're already in the nav sidebar.
- Save buttons across the app (token save, anti-prune save, pic-capture save) now: confirm before saving, show "Saving…" → "Saved" pulse state, and emit a bottom-right toast (green=success, red=error).
- "Save Token" renamed to "Save"; saving prompts a confirmation dialog before opening the name input.
- Scope radios in PicManager and AntiPruneManager use custom-styled circles. Selecting "Specific servers" with no servers loaded shakes the radio and reverts to "All".
- After picking servers in the chip selector, the list collapses to a one-line summary chip (`N · names · edit`) — clicking expands it back.
- `setLang()` now re-renders the full set of dynamic managers (was missing Clone / HistoryLog / TokenHealth / Mentions / Pic / AntiPrune / Search / MassFriend).
- Dark theme palette softened (`#0d1018` / `#141826` / `#1c2030` / accent `#6b78ff`); button hovers, transitions and shadows tuned for a more elegant feel.
- Sound effects redesigned: chic, quiet, sine-wave only with a low-pass filter — no more harsh square/sawtooth tones.
- `saved_tokens.json` — Persisted Discord tokens (local file).

## Multi-account / anti-detection

- Multiple tokens can be connected at once. The server keeps a `Map<name, client>` and one `activeName`.
- Legacy endpoints use the active client; new endpoints accept an optional `tokens[]` array to fan out actions.
- All sends go through a humanized helper (`sendTyping` + jittered delay) to mimic real users.
- Message deleter uses a small worker pool with global cooldown on 429s.

## Running

```
node server.js
```

The app runs on port 5000. When started outside Replit, it auto-opens the local URL in the default browser.

## Test mode

Type `test` in the login screen to enter offline test mode — credits show "Ahmed (Test)" with a Discord-style avatar so the UI can be explored without a real token.

## Deployment

Uses **VM deployment** (not autoscale) because the Discord clients maintain persistent in-memory state between requests.

## Credits

Developed and maintained by **Ahmed Dev** (`@4_3a`).

## UX update — Apr 2026

- **Burger menu (top-right)** is now the only place to open: History Log, Token Health, Mentions, Pic Capture, Anti-Prune, Sound, Search, Mass Friend. Sidebar focuses on core flows only (login, tokens, friends, servers, dms, private, groups, messages, reactions, history, stats, lookup, clone).
- **Activity log** — `connect`, `disconnect`, `save_token`, `delete_token`, and `clone_messages` are now persisted via `recordHistory` and shown in the History Log panel with their own icons/colors.
- **Global custom radios & checkboxes** — `.mm-page input[type=radio|checkbox]:not(.raw)` get the AntiPrune-style circular/square look across all panels. Add `.raw` to opt out.
- **All native `confirm()` dialogs** in components have been replaced by the styled `showConfirm()` helper.

### Clone — overhaul

- `GET /api/clone/snapshot/server/:guildId?messages=1&perChannel=N` — captures structure + per-text-channel messages (parallel batches of 4 channels). Per-channel cap clamped to 1–200.
- Channel snapshots now include `permission_overwrites` so role-based channel perms can be cloned.
- `POST /api/clone/paste/server-build` is fully option-driven:
  - `accounts: string[]` — pick one or more saved/connected accounts. The first account that owns/admins the target builds the structure; other accounts join in to post messages in parallel via temporary webhooks (each account creates its own webhook per channel; webhooks are deleted after).
  - `options`: `{ categories, textChannels, voiceChannels, roles, rolePerms, channelPerms, emojis, messages, messageChannelIds, messageGapMs }`.
  - Messages are restored via webhook (`username` + `avatar_url` preserved) for speed and authenticity.
- New paste UI in CloneManager: option grid with custom checkboxes, multi-account chip selector, per-channel chooser modal with search and select-all, and a paste-finished report.

## Apr 27, 2026 — Search, speed, dropdown clipping & test data

- **Themed select** (`src/utils/themedSelect.js`) now portals its popover to `<body>` with `position:fixed` so dropdowns (e.g. presence/activity type → "Watching") are never clipped by ancestors with `overflow:auto` (the page-container). Reposition on scroll/resize while open.
- **PrivateManager search is now Discord-style global**: matches by username, displayName, ID, AND message content. Adds `GET /api/private/search?q=&account=&groups=&limit=` which scans cached + recent messages across DM channels and returns highlighted snippets in a dedicated "Messages" results section.
- **Mass Friend filter** matches username, displayName **and** member ID (multi-token AND).
- **Test mode (`TEST_RESPONSES` in `src/api.js`)** now ships rich data: 8 friends, 4 servers (with member counts), 7 channels (text+voice+categories), 5 DMs (with previews & unread), 2 groups, 6 sample messages with mentions & emoji, 28 server members for the bulk-friend preview, multiple connected clients, and 3 sample message-search hits — all using inline SVG data-URI avatars/icons so nothing 404s.
- **Speed**: Send-loop fast gap stays at 500 ms; the new `/api/private/search` endpoint avoids artificial sleeps and only fetches a small slice (50 msgs) per channel for snappy results.

## Apr 27, 2026 (later) — Stronger search + richer server lookup

- **PrivateManager search overhaul** — server endpoint now does TWO passes:
  1. **Fast pass** scans local message cache instantly (<50 ms response).
  2. **Deep pass** hits Discord's NATIVE per-channel search API
     (`GET /channels/:id/messages/search?content=`) for every DM in PARALLEL
     (concurrency=8, hard 8 s timeout). This covers FULL message history,
     not just cached messages.
  3. Per-(account|query) result cache (60 s TTL) for instant repeats.
  Results are de-duplicated by message id and sorted by recency. Channel
  hits-by-name are also surfaced so DMs appear even without message matches.
- **Server lookup overhaul** — `/api/lookup/server/:id` now returns:
  description, splash/discoverySplash, online presence count (via parallel
  preview API), maximum members, full channel breakdown (text/voice/cats/
  announcement/stage/forum), top 8 roles with member counts, my role list +
  my highest role + my key permissions + my nickname, owner avatar, vanity
  URL + uses, boost progress to next tier, verification level, content
  filter, NSFW level, MFA, locale, AFK/system/rules/updates channels,
  emoji+animated+sticker counts, partnered/verified/community badges.
  All extra fetches (preview + vanity URL info) run in parallel.
- **LookupManager UI** rebuilt with: section titles, owner avatar pill,
  vanity chip, partner/verified/community flags, boost-progress bar,
  membership card with role chips (colored), permission chips, special
  channels grid, channel-type tile grid, emoji/sticker stats.
- **Test mode** for server lookup now returns a fully populated 27-channel
  community server so the UI variants show real data.
