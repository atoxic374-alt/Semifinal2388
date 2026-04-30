async function apiCall(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    return { success: false, error: 'Network error: ' + (e?.message || 'fetch failed') };
  }
  // If the server says we lost the session, bounce back to the login page so
  // the user gets a clean re-auth instead of a confusing "401" string.
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    return { success: false, error: 'unauthorized' };
  }
  // Robust JSON parsing — some proxy / edge errors return HTML, which would
  // otherwise crash with "Unexpected token '<' in JSON at position 0" and
  // bubble up as a confusing notification.
  const ctype = (res.headers?.get?.('content-type') || '').toLowerCase();
  const text  = await res.text();
  if (ctype.includes('application/json') || /^[\s\uFEFF]*[{[]/.test(text)) {
    try { return JSON.parse(text); }
    catch (_) { /* fall through to graceful error */ }
  }
  // Non-JSON payload — surface a short, useful error instead of HTML noise.
  const snippet = (text || '').replace(/\s+/g, ' ').slice(0, 120).trim();
  return {
    success: false,
    error: `Server returned ${res.status} ${res.statusText || ''}`.trim()
         + (snippet ? ` — ${snippet}` : ''),
    httpStatus: res.status
  };
}

// Build a small library of test images to make test mode look real.
// SVG data-URIs guarantee they render with no network calls or 404s.
function _testAvatar(letter, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#1f2233"/></linearGradient></defs>`
    + `<rect width="80" height="80" rx="40" fill="url(#g)"/>`
    + `<text x="50%" y="55%" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="34" font-weight="700" fill="#fff">${letter}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function _testServerIcon(letter, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">`
    + `<rect width="96" height="96" rx="22" fill="${color}"/>`
    + `<text x="50%" y="56%" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="38" font-weight="800" fill="#fff">${letter}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
const _TEST_PALETTE = ['#5865f2','#eb459e','#3ba55d','#faa61a','#ed4245','#9b59b6','#1abc9c','#e91e63','#00b0ff','#ff7043'];
const _testFriends = [
  { id: '111111111111111111', username: 'ahmed_dev',  displayName: 'Ahmed (Dev)',   avatar: _testAvatar('A', _TEST_PALETTE[0]), bot:false },
  { id: '111111111111111112', username: 'sara_design',displayName: 'Sara Design',   avatar: _testAvatar('S', _TEST_PALETTE[1]), bot:false },
  { id: '111111111111111113', username: 'omar.codes', displayName: 'Omar',          avatar: _testAvatar('O', _TEST_PALETTE[2]), bot:false },
  { id: '111111111111111114', username: 'layla',      displayName: 'Layla',         avatar: _testAvatar('L', _TEST_PALETTE[3]), bot:false },
  { id: '111111111111111115', username: 'khaled_x',   displayName: 'Khaled',        avatar: _testAvatar('K', _TEST_PALETTE[4]), bot:false },
  { id: '111111111111111116', username: 'zeina',      displayName: 'Zeina ✨',      avatar: _testAvatar('Z', _TEST_PALETTE[5]), bot:false },
  { id: '111111111111111117', username: 'ai_helper_bot', displayName: 'AI Helper',  avatar: _testAvatar('B', _TEST_PALETTE[6]), bot:true  },
  { id: '111111111111111118', username: 'mods_wand',  displayName: 'ModWand',       avatar: _testAvatar('M', _TEST_PALETTE[7]), bot:true  },
];
const _testServers = [
  { id: '999000000000000001', name: 'Replit Builders',  icon: _testServerIcon('R', _TEST_PALETTE[0]), members: 1843, owner: true,  channels: 14 },
  { id: '999000000000000002', name: 'Arabic Devs',      icon: _testServerIcon('ع', _TEST_PALETTE[2]), members: 4521, owner: false, channels: 22 },
  { id: '999000000000000003', name: 'Game Night',       icon: _testServerIcon('G', _TEST_PALETTE[3]), members:  217, owner: false, channels:  8 },
  { id: '999000000000000004', name: 'Design Critique',  icon: _testServerIcon('D', _TEST_PALETTE[1]), members:  812, owner: true,  channels: 11 },
];
const _testChannels = [
  { id: '555000000000000001', name: 'general',           type: 'text',  category: 'TEXT CHANNELS' },
  { id: '555000000000000002', name: 'announcements',     type: 'text',  category: 'TEXT CHANNELS' },
  { id: '555000000000000003', name: 'random',            type: 'text',  category: 'TEXT CHANNELS' },
  { id: '555000000000000004', name: 'help',              type: 'text',  category: 'SUPPORT' },
  { id: '555000000000000005', name: 'bug-reports',       type: 'text',  category: 'SUPPORT' },
  { id: '555000000000000006', name: 'General Voice',     type: 'voice', category: 'VOICE' },
  { id: '555000000000000007', name: 'Music',             type: 'voice', category: 'VOICE' },
];
const _testDms = [
  { id: '777000000000000001', username: 'sara_design',  displayName: 'Sara Design', avatar: _testAvatar('S', _TEST_PALETTE[1]), bot:false, unread: 2, preview: 'sounds great, ship it 🚀' },
  { id: '777000000000000002', username: 'omar.codes',   displayName: 'Omar',        avatar: _testAvatar('O', _TEST_PALETTE[2]), bot:false, unread: 0, preview: 'pushed the fix' },
  { id: '777000000000000003', username: 'ai_helper_bot',displayName: 'AI Helper',   avatar: _testAvatar('B', _TEST_PALETTE[6]), bot:true,  unread: 1, preview: 'Your reminder is set.' },
  { id: '777000000000000004', username: 'layla',        displayName: 'Layla',       avatar: _testAvatar('L', _TEST_PALETTE[3]), bot:false, unread: 0, preview: 'see you tomorrow!' },
  { id: '777000000000000005', username: 'khaled_x',     displayName: 'Khaled',      avatar: _testAvatar('K', _TEST_PALETTE[4]), bot:false, unread: 5, preview: 'check this out: https://example.com' },
];
const _testGroups = [
  { id: '666000000000000001', name: 'Design Squad',  icon: _testAvatar('D', _TEST_PALETTE[1]), recipients: 4, unread: 3, preview: 'Layla: meeting moved' },
  { id: '666000000000000002', name: 'Friday Crew',   icon: _testAvatar('F', _TEST_PALETTE[3]), recipients: 6, unread: 0, preview: 'who is in tonight?' },
];
const _now = Date.now();
const _testMessages = [
  { id: 'm1', author: { id: '111111111111111112', username: 'sara_design', displayName: 'Sara Design', avatar: _testAvatar('S', _TEST_PALETTE[1]) }, content: 'Hey! Did you see the new mockup I shared?', createdTimestamp: _now - 1000*60*55 },
  { id: 'm2', author: { id: '0', username: 'AhmedTest', displayName: 'Ahmed', avatar: _testAvatar('A', _TEST_PALETTE[0]) }, content: 'Yes — I love the gradient on the hero. Can we ship it tonight? <@111111111111111112>', createdTimestamp: _now - 1000*60*52 },
  { id: 'm3', author: { id: '111111111111111112', username: 'sara_design', displayName: 'Sara Design', avatar: _testAvatar('S', _TEST_PALETTE[1]) }, content: 'sounds great, ship it 🚀', createdTimestamp: _now - 1000*60*50 },
  { id: 'm4', author: { id: '0', username: 'AhmedTest', displayName: 'Ahmed', avatar: _testAvatar('A', _TEST_PALETTE[0]) }, content: 'Working on the dropdown clipping bug right now.', createdTimestamp: _now - 1000*60*30 },
  { id: 'm5', author: { id: '111111111111111112', username: 'sara_design', displayName: 'Sara Design', avatar: _testAvatar('S', _TEST_PALETTE[1]) }, content: 'nice. did you also fix the search?', createdTimestamp: _now - 1000*60*12 },
  { id: 'm6', author: { id: '0', username: 'AhmedTest', displayName: 'Ahmed', avatar: _testAvatar('A', _TEST_PALETTE[0]) }, content: 'global search now scans messages too — like Discord 🎯', createdTimestamp: _now - 1000*60*8 },
];
const _testMembers = Array.from({ length: 28 }, (_, i) => {
  const names = ['Ahmed','Sara','Omar','Layla','Khaled','Zeina','Yusuf','Mira','Hassan','Nour','Ziad','Rana','Tamer','Lina','Karim','Dina','Adel','Mona','Bilal','Hala','Samir','Reem','Faris','Nadia','Wael','Salma','Nizar','Hind'];
  const u = (names[i] || ('User' + i)).toLowerCase();
  return {
    id: '4400000000000000' + String(10 + i),
    username: u + (i % 3 === 0 ? '_dev' : ''),
    displayName: names[i] || ('User ' + i),
    avatar: _testAvatar((names[i] || 'U')[0], _TEST_PALETTE[i % _TEST_PALETTE.length]),
    bot: i % 9 === 0,
    roles: i % 4 === 0 ? ['Member','Booster'] : ['Member'],
    joinedAt: _now - (1000 * 60 * 60 * 24 * (i + 5)),
  };
});

const TEST_RESPONSES = {
  friends:  { success: true, friends: _testFriends },
  servers:  { success: true, servers: _testServers },
  dms:      { success: true, dms: _testDms },
  groups:   { success: true, groups: _testGroups },
  channels: { success: true, channels: _testChannels },
  messages: { success: true, messages: _testMessages, currentUserId: '0' },
  members:  { success: true, members: _testMembers, total: _testMembers.length },
  clients:  { success: true, active: 'Ahmed (Test)', clients: [
    { name: 'Ahmed (Test)', username: 'AhmedTest#0001', id: '0', avatar: _testAvatar('A', _TEST_PALETTE[0]), status: 'online', active: true },
    { name: 'Test Bot',     username: 'TestBot#9999',   id: '1', avatar: _testAvatar('B', _TEST_PALETTE[6]), status: 'idle',   active: false },
  ]},
  jobs:     { success: true, jobs: [] },
  listeners:{ success: true, listeners: [] },
  results:  { success: true, results: [] },
  ok:       { success: true },
  serverInfo: { success: true, joined: true, server: {
    id: '999000000000000001', name: 'Replit Builders',
    icon: _testServerIcon('R', _TEST_PALETTE[0]),
    banner: 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5865f2"/><stop offset="1" stop-color="#eb459e"/></linearGradient></defs><rect width="600" height="200" fill="url(#b)"/></svg>`),
    splash: null, discoverySplash: null,
    createdAt: _now - (1000*60*60*24*365*2), description: 'A community of builders shipping faster on Replit. Bots, full-stack apps, and good vibes.',
    members: 1843, online: 412, maximum: 500000,
    visibleText: 12, totalText: 14, totalVoice: 4, totalCats: 5, totalAnn: 1, totalStage: 1, totalForum: 2, totalChannels: 27,
    totalRoles: 18,
    topRoles: [
      { id: 'r1', name: 'Owner',  color: '#eb459e', members: 1   },
      { id: 'r2', name: 'Admin',  color: '#5865f2', members: 4   },
      { id: 'r3', name: 'Mod',    color: '#3ba55d', members: 12  },
      { id: 'r4', name: 'Booster',color: '#f47fff', members: 23  },
      { id: 'r5', name: 'Member', color: null,      members: 1803 },
    ],
    ownerId: '111111111111111111', ownerName: 'ahmed_dev',
    ownerAvatar: _testAvatar('A', _TEST_PALETTE[0]),
    myRoles: 3, myRolesList: [
      { id: 'r2', name: 'Admin',   color: '#5865f2', position: 18 },
      { id: 'r4', name: 'Booster', color: '#f47fff', position: 12 },
      { id: 'r5', name: 'Member',  color: null,      position: 1  },
    ],
    myHighestRole: { id: 'r2', name: 'Admin', color: '#5865f2', position: 18 },
    myNickname: 'Ahmed (Test)',
    myJoinedAt: _now - (1000*60*60*24*180),
    myPermissions: ['ADMINISTRATOR','MANAGE_GUILD','MANAGE_CHANNELS','BAN_MEMBERS','KICK_MEMBERS'],
    isOwner: false,
    boosts: 9, tier: 1, nextTierAt: 14, boostProgress: 9/14, boostBarEnabled: true,
    verificationLevel: 'MEDIUM', explicitFilter: 'MEMBERS_WITHOUT_ROLES',
    nsfwLevel: 'DEFAULT', mfaLevel: 'NONE',
    preferredLocale: 'en-US', region: null,
    afkChannelId: 'a1', afkChannelName: 'AFK Lounge', afkTimeout: 300,
    systemChannelId: 'sc1', systemChannelName: 'general',
    rulesChannelId: 'rc1', rulesChannelName: 'rules',
    publicUpdatesChannelId: 'pu1', publicUpdatesChannelName: 'mod-log',
    widgetEnabled: true, widgetChannelId: null,
    emojiCount: 47, animatedEmojis: 12, stickerCount: 5,
    vanityCode: 'replit-builders', vanityUses: 1280,
    features: ['COMMUNITY','NEWS','VANITY_URL','BANNER','ANIMATED_ICON','INVITE_SPLASH','WELCOME_SCREEN_ENABLED','DISCOVERABLE'],
    partnered: false, verified: false, community: true,
  }},
  privateSearch: { success: true, total: 3, matches: [
    { channelId: '777000000000000001', channelName: 'Sara Design', channelAvatar: _testAvatar('S', _TEST_PALETTE[1]), messageId: 'm3',  content: 'sounds great, ship it 🚀',                          author: { id: '111111111111111112', username: 'sara_design', avatar: _testAvatar('S', _TEST_PALETTE[1]) }, ts: _now - 1000*60*50 },
    { channelId: '777000000000000002', channelName: 'Omar',        channelAvatar: _testAvatar('O', _TEST_PALETTE[2]), messageId: 'm10', content: 'pushed the fix for the dropdown clipping bug',     author: { id: '111111111111111113', username: 'omar.codes',  avatar: _testAvatar('O', _TEST_PALETTE[2]) }, ts: _now - 1000*60*22 },
    { channelId: '777000000000000005', channelName: 'Khaled',      channelAvatar: _testAvatar('K', _TEST_PALETTE[4]), messageId: 'm11', content: 'check this out: https://example.com — global search demo', author: { id: '111111111111111115', username: 'khaled_x',    avatar: _testAvatar('K', _TEST_PALETTE[4]) }, ts: _now - 1000*60*5 },
  ]},
};

// Single source of truth for "are we in preview/test mode?". Components MUST
// gate every side-effect through this rather than reading window._testMode
// directly — that way a future test harness can override one place and any
// accidental real-API call from preview mode is short-circuited centrally.
function isTestMode() {
  return !!window._testMode;
}
window.isTestMode = isTestMode;
function testOr(fallback) {
  return isTestMode() ? Promise.resolve(fallback) : null;
}

window.electronAPI = {
  minimize: () => {},
  maximize: () => {},
  close: () => {},

  // ── Token storage
  getTokens:    ()           => apiCall('GET', '/api/tokens'),
  saveToken:    (name, token, autoConnect = false, proxy = null) => apiCall('POST', '/api/tokens', { name, token, autoConnect, proxy }),
  updateToken:  (name, patch) => apiCall('PATCH', `/api/tokens/${encodeURIComponent(name)}`, patch),
  deleteToken:  (name)        => apiCall('DELETE', `/api/tokens/${encodeURIComponent(name)}`),
  connectSaved: (name)        => apiCall('POST', `/api/tokens/${encodeURIComponent(name)}/connect`),
  disconnectSaved:(name)      => apiCall('POST', `/api/tokens/${encodeURIComponent(name)}/disconnect`),
  setProxy:     (name, proxy) => apiCall('PUT',  `/api/tokens/${encodeURIComponent(name)}/proxy`, { proxy }),
  testProxy:    (name, proxy) => apiCall('POST', `/api/tokens/${encodeURIComponent(name)}/proxy/test`, { proxy }),

  checkUpdates:    () => apiCall('GET', '/api/updates'),
  downloadUpdate:  (url) => { window.open(url, '_blank'); },
  openExternal:    (url) => { window.open(url, '_blank'); },

  // ── Discord auth / clients
  connectDiscord:   (token, name) => apiCall('POST', '/api/discord/connect', { token, name }),
  disconnect:       () => apiCall('POST', '/api/discord/disconnect'),
  disconnectAll:    () => apiCall('POST', '/api/discord/disconnect-all'),
  listClients:      () => testOr(TEST_RESPONSES.clients) || apiCall('GET',  '/api/discord/clients'),
  setActiveClient:  (name) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/discord/active', { name }),

  // ── Friends / Servers / DMs / Groups
  getFriends:       (opts = {}) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.friends);
    const q = opts.account ? `?account=${encodeURIComponent(opts.account)}` : '';
    return apiCall('GET', '/api/discord/friends' + q);
  },
  deleteFriend:     (id) => testOr(TEST_RESPONSES.ok) || apiCall('DELETE', `/api/discord/friends/${id}`),

  getServers:       (opts = {}) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.servers);
    const q = opts.account ? `?account=${encodeURIComponent(opts.account)}` : '';
    return apiCall('GET', '/api/discord/servers' + q);
  },
  _getServersOriginal: () => testOr(TEST_RESPONSES.servers) || apiCall('GET', '/api/discord/servers'),
  getServerChannels:(id) => testOr(TEST_RESPONSES.channels) || apiCall('GET', `/api/discord/servers/${id}/channels`),
  getServerMembers: (id, account) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.members);
    const q = account ? `?account=${encodeURIComponent(account)}` : '';
    return apiCall('GET', `/api/discord/servers/${id}/members${q}`);
  },
  leaveServer:      (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/discord/servers/${id}/leave`),
  muteServer:       (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/discord/servers/${id}/mute`),
  unmuteServer:     (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/discord/servers/${id}/unmute`),
  readAll:          () => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/discord/read-all'),

  getDMs:           (opts = {}) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.dms);
    const q = new URLSearchParams();
    if (opts.account)  q.set('account', opts.account);
    if (opts.botsOnly) q.set('botsOnly', '1');
    return apiCall('GET', '/api/discord/dms' + (q.toString() ? `?${q}` : ''));
  },
  getDMMessages:    (id, before) => {
    const q = before ? `?before=${before}` : '';
    return testOr(TEST_RESPONSES.messages) || apiCall('GET', `/api/discord/dms/${id}/messages${q}`);
  },
  deleteDMMessage:  (id, mid) => testOr(TEST_RESPONSES.ok) || apiCall('DELETE', `/api/discord/dms/${id}/messages/${mid}`),
  closeDM:          (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/discord/dms/${id}/close`),

  getGroups:        (opts = {}) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.groups);
    const q = opts.account ? `?account=${encodeURIComponent(opts.account)}` : '';
    return apiCall('GET', '/api/discord/groups' + q);
  },
  leaveGroup:       (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/discord/groups/${id}/leave`),
  getGroupMessages: (id, before) => {
    const q = before ? `?before=${before}` : '';
    return testOr(TEST_RESPONSES.messages) || apiCall('GET', `/api/discord/groups/${id}/messages${q}`);
  },
  deleteGroupMessage:(id, mid) => testOr(TEST_RESPONSES.ok) || apiCall('DELETE', `/api/discord/groups/${id}/messages/${mid}`),

  // ── Presence / Status / Bio
  setPresence:    (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/set', payload),
  setBio:         (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/bio', payload),
  getProfile:     (payload) => testOr({ profile: { bio: 'Test bio', status: 'online', avatar: null, banner: null } }) || apiCall('POST', '/api/presence/profile', payload),
  setAvatar:      (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/avatar', payload),
  setBanner:      (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/banner', payload),
  startRotation:  (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/rotate/start', payload),
  stopRotation:   (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/rotate/stop', payload),
  startActivity:  (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/activity/start', payload),
  stopActivity:   (payload) => testOr(TEST_RESPONSES.ok) || apiCall('POST', '/api/presence/activity/stop', payload),
  listActivity:   () => testOr({ success: true, running: [] }) || apiCall('GET', '/api/presence/activity/list'),

  // ── Messages Manager
  sendMessages:    (payload) => testOr(TEST_RESPONSES.results) || apiCall('POST', '/api/messages/send', payload),
  startRepeat:     (payload) => testOr({ success: true, jobId: 'test-1' }) || apiCall('POST', '/api/messages/repeat/start', payload),
  scheduleMessage: (payload) => testOr({ success: true, jobId: 'test-2', runIn: 5000 }) || apiCall('POST', '/api/messages/schedule', payload),
  listMessageJobs: () => testOr(TEST_RESPONSES.jobs) || apiCall('GET', '/api/messages/jobs'),
  stopMessageJob:  (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/messages/jobs/${id}/stop`),

  // ── Reaction Manager
  startReactions:   (payload) => testOr({ success: true, listenerId: 'test-r1' }) || apiCall('POST', '/api/reactions/start', payload),
  listReactions:    () => testOr(TEST_RESPONSES.listeners) || apiCall('GET', '/api/reactions/list'),
  stopReactions:    (id) => testOr(TEST_RESPONSES.ok) || apiCall('POST', `/api/reactions/${id}/stop`),

  // ── Private Manager (multi-account real-time DM view)
  privateDMs:       (account, botsOnly) => {
    const q = new URLSearchParams();
    if (account)  q.set('account', account);
    if (botsOnly) q.set('botsOnly', '1');
    return apiCall('GET', '/api/private/dms' + (q.toString() ? `?${q}` : ''));
  },
  privateMessages:  (account, channelId, before) => {
    const q = new URLSearchParams();
    if (account) q.set('account', account);
    if (before)  q.set('before', before);
    return apiCall('GET', `/api/private/messages/${channelId}` + (q.toString() ? `?${q}` : ''));
  },
  privateSend:      (account, channelId, content, opts = {}) =>
    apiCall('POST', '/api/private/send', { account, channelId, content, replyTo: opts.replyTo || null, files: opts.files || [] }),
  privateMarkRead:  (account, channelId) =>
    apiCall('POST', `/api/private/read/${channelId}`, { account }),
  privateReact:     (account, channelId, messageId, emoji, remove = false) =>
    apiCall('POST', '/api/private/react', { account, channelId, messageId, emoji, remove }),
  privateSearch:    (account, q, opts = {}) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.privateSearch || { success: true, matches: [], total: 0 });
    const p = new URLSearchParams();
    p.set('q', q);
    if (account) p.set('account', account);
    if (opts.groups) p.set('groups', '1');
    if (opts.limit)  p.set('limit', String(opts.limit));
    return apiCall('GET', '/api/private/search?' + p.toString());
  },

  // ── Stats Dashboard
  getStats:         () => apiCall('GET', '/api/stats/summary'),

  // ── Server Lookup
  lookupServer:     (id, account) => {
    if (window._testMode) return Promise.resolve(TEST_RESPONSES.serverInfo);
    const q = account ? `?account=${encodeURIComponent(account)}` : '';
    return apiCall('GET', `/api/lookup/server/${encodeURIComponent(id)}${q}`);
  },

  // ── History Log
  getHistoryLog:    () => apiCall('GET', '/api/history-log'),
  clearHistoryLog:  () => apiCall('DELETE', '/api/history-log'),

  // ── Token Health
  getTokenHealth:   () => apiCall('GET', '/api/token-health'),
  checkTokenHealth: (name) => apiCall('POST', '/api/token-health/check', name ? { name } : {}),

  // ── Mentions
  getMentions:      (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.account) q.set('account', opts.account);
    if (opts.all) q.set('all', '1');
    return apiCall('GET', '/api/mentions' + (q.toString() ? `?${q}` : ''));
  },
  clearMentions:    (account) => apiCall('DELETE', '/api/mentions', { account: account || null }),

  // ── Pic Capture
  getPicConfig:     () => apiCall('GET', '/api/pic/config'),
  setPicConfig:     (cfg) => apiCall('POST', '/api/pic/config', cfg),
  getPicBuffer:     () => apiCall('GET', '/api/pic/buffer'),
  clearPicBuffer:   () => apiCall('DELETE', '/api/pic/buffer'),

  // ── Anti-Prune
  getAntiPruneConfig: () => apiCall('GET', '/api/antiprune/config'),
  setAntiPruneConfig: (cfg) => apiCall('POST', '/api/antiprune/config', cfg),
  getAntiPruneLog:    () => apiCall('GET', '/api/antiprune/log'),
  clearAntiPruneLog:  () => apiCall('DELETE', '/api/antiprune/log'),

  // ── Clone Manager
  getCloneSources:    (account) => apiCall('GET', '/api/clone/sources' + (account ? `?account=${encodeURIComponent(account)}` : '')),
  cloneSnapshotServer:(id, account) => apiCall('GET', `/api/clone/snapshot/server/${id}` + (account ? `?account=${encodeURIComponent(account)}` : '')),
  cloneSnapshotGroup: (id, account, limit) => apiCall('GET', `/api/clone/snapshot/group/${id}?limit=${limit||200}` + (account ? `&account=${encodeURIComponent(account)}` : '')),
  cloneSnapshotDM:    (id, account, limit) => apiCall('GET', `/api/clone/snapshot/dm/${id}?limit=${limit||200}` + (account ? `&account=${encodeURIComponent(account)}` : '')),
  cloneListSaved:     () => apiCall('GET', '/api/clone/saved'),
  cloneSaveSnapshot:  (snapshot, name) => apiCall('POST', '/api/clone/saved', { snapshot, name }),
  cloneGetSaved:      (id) => apiCall('GET', `/api/clone/saved/${id}`),
  cloneDeleteSaved:   (id) => apiCall('DELETE', `/api/clone/saved/${id}`),
  clonePasteWebhook:  (webhookUrl, messages, includeAuthor) => apiCall('POST', '/api/clone/paste/webhook', { webhookUrl, messages, includeAuthor }),
  cloneBuildServer:   (account, snapshot, targetGuildId) => apiCall('POST', '/api/clone/paste/server-build', { account, snapshot, targetGuildId }),

  // ── Clone Presets
  cloneListPresets:   () => apiCall('GET', '/api/clone/presets'),
  cloneGetPreset:     (id) => apiCall('GET', `/api/clone/presets/${id}`),
  cloneSavePreset:    (preset) => apiCall('POST', '/api/clone/presets', preset),
  cloneDeletePreset:  (id) => apiCall('DELETE', `/api/clone/presets/${id}`),

  // ── Ban / health alerts
  getBanAlerts:       () => apiCall('GET', '/api/ban-alerts'),
  clearBanAlerts:     () => apiCall('DELETE', '/api/ban-alerts'),

  // ── Voice Manager
  voiceGetGuilds:        (account) => {
    if (window._testMode) return Promise.resolve({ guilds: [
      { account: 'Ahmed (Test)', guildId: '999000000000000001', guildName: 'Replit Builders', guildIcon: null, voiceChannels: [
        { id: 'vc1', name: 'General Voice', userLimit: 0, members: 3, bitrate: 64 },
        { id: 'vc2', name: 'Music',         userLimit: 10, members: 1, bitrate: 96 },
        { id: 'vc3', name: 'AFK',           userLimit: 0, members: 0, bitrate: 64 },
      ]},
      { account: 'Ahmed (Test)', guildId: '999000000000000002', guildName: 'Arabic Devs', guildIcon: null, voiceChannels: [
        { id: 'vc4', name: 'Dev Chat',      userLimit: 0, members: 2, bitrate: 64 },
        { id: 'vc5', name: 'Chill Zone',    userLimit: 0, members: 0, bitrate: 64 },
      ]},
    ]});
    const q = account ? `?account=${encodeURIComponent(account)}` : '';
    return apiCall('GET', `/api/voice/guilds${q}`);
  },
  voiceGetSessions:      () => {
    if (window._testMode) return Promise.resolve({ sessions: [] });
    return apiCall('GET', '/api/voice/sessions');
  },
  voiceGetRotations:     () => {
    if (window._testMode) return Promise.resolve({ rotations: [] });
    return apiCall('GET', '/api/voice/rotations');
  },
  voiceGetStateCycles:   () => {
    if (window._testMode) return Promise.resolve({ cycles: [] });
    return apiCall('GET', '/api/voice/state-cycles');
  },
  voiceJoin:             (payload) => testOr({ results: [] }) || apiCall('POST', '/api/voice/join', payload),
  voiceLeave:            (payload) => testOr({ results: [] }) || apiCall('POST', '/api/voice/leave', payload),
  voiceSetState:         (payload) => testOr({ results: [] }) || apiCall('POST', '/api/voice/state', payload),
  voiceJoinAll:          (payload) => testOr({ results: [] }) || apiCall('POST', '/api/voice/join-all', payload),
  voiceDistributeRandom: (payload) => testOr({ results: [] }) || apiCall('POST', '/api/voice/distribute-random', payload),
  voiceStartRotation:    (payload) => testOr({ id: 'test-rot', message: 'ok' }) || apiCall('POST', '/api/voice/rotation/start', payload),
  voiceStopRotation:     (payload) => testOr({ ok: true }) || apiCall('POST', '/api/voice/rotation/stop', payload),
  voiceStartStateCycle:  (payload) => testOr({ id: 'test-cyc', message: 'ok' }) || apiCall('POST', '/api/voice/state-cycle/start', payload),
  voiceStopStateCycle:   (payload) => testOr({ ok: true }) || apiCall('POST', '/api/voice/state-cycle/stop', payload),

  // ── Bot Tokens
  botsList:           () => apiCall('GET', '/api/bots'),
  botsTeams:          () => apiCall('GET', '/api/bots/teams'),
  botsCapacity:       () => apiCall('GET', '/api/bots/capacity'),
  botsAllTokensUrl:   (format = 'text') => `/api/bots/all-tokens?format=${encodeURIComponent(format)}`,
  botsDelete:         (id) => apiCall('DELETE', `/api/bots/${encodeURIComponent(id)}`),
  botsDeleteFromDiscord: (id, accountPassword = '') => apiCall('DELETE', `/api/bots/${encodeURIComponent(id)}?fromDiscord=true`, { accountPassword }),
  botsResetToken:     (id, accountPassword = '') => apiCall('POST', `/api/bots/${encodeURIComponent(id)}/reset-token`, { accountPassword }),
  botsStatus:         () => apiCall('GET', '/api/bots/status'),
  botsPreflight:      (account) => apiCall('GET', `/api/bots/preflight?account=${encodeURIComponent(account || '')}`),
  botsCreate:         (cfg) => apiCall('POST', '/api/bots/create', cfg),
  botsVerifyPending:  () => apiCall('POST', '/api/bots/verify-pending'),
  botsCancel:         () => apiCall('POST', '/api/bots/cancel'),
  botsSubmitCaptcha:  (captchaKey, nonce = '') => apiCall('POST', '/api/bots/captcha', { captchaKey, nonce }),
  botsCaptchaHealth:  () => apiCall('GET', '/api/bots/captcha/health'),
  botsGetConfig:      () => apiCall('GET', '/api/bots/config'),
  botsSetConfig:      (cfg) => apiCall('POST', '/api/bots/config', cfg),
  // Per-account stored Discord password (encrypted server-side, never read back)
  setAccountPassword: (name, password) => apiCall('PUT', `/api/tokens/${encodeURIComponent(name)}/password`, { password }),
};
