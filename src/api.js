async function apiCall(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

const TEST_RESPONSES = {
  friends:  { success: true, friends: [
    { id: '111111111111111111', username: 'testfriend', displayName: 'Test Friend', avatar: '/discord.png' },
    { id: '222222222222222222', username: 'demo_user',  displayName: 'Demo User',    avatar: '/discord.png' }
  ]},
  servers:  { success: true, servers: [
    { id: '999000000000000001', name: 'Test Server #1', icon: '/discord.png' },
    { id: '999000000000000002', name: 'Test Server #2', icon: '/discord.png' }
  ]},
  dms:      { success: true, dms: [
    { id: '777000000000000001', username: 'testfriend', displayName: 'Test Friend', avatar: '/discord.png' }
  ]},
  groups:   { success: true, groups: [
    { id: '666000000000000001', name: 'Test Group',  icon: '/discord.png', recipients: 4 }
  ]},
  channels: { success: true, channels: [
    { id: '555000000000000001', name: 'general' },
    { id: '555000000000000002', name: 'random' }
  ]},
  messages: { success: true, messages: [], currentUserId: 'test' },
  clients:  { success: true, active: 'Ahmed (Test)', clients: [
    { name: 'Ahmed (Test)', username: 'AhmedTest#0001', id: '0', avatar: '/discord.png', status: 'online', active: true }
  ]},
  jobs:     { success: true, jobs: [] },
  listeners:{ success: true, listeners: [] },
  results:  { success: true, results: [] },
  ok:       { success: true },
};

function testOr(fallback) {
  return window._testMode ? Promise.resolve(fallback) : null;
}

window.electronAPI = {
  minimize: () => {},
  maximize: () => {},
  close: () => {},

  // ── Token storage
  getTokens:    ()           => apiCall('GET', '/api/tokens'),
  saveToken:    (name, token, autoConnect = false) => apiCall('POST', '/api/tokens', { name, token, autoConnect }),
  updateToken:  (name, patch) => apiCall('PATCH', `/api/tokens/${encodeURIComponent(name)}`, patch),
  deleteToken:  (name)        => apiCall('DELETE', `/api/tokens/${encodeURIComponent(name)}`),
  connectSaved: (name)        => apiCall('POST', `/api/tokens/${encodeURIComponent(name)}/connect`),
  disconnectSaved:(name)      => apiCall('POST', `/api/tokens/${encodeURIComponent(name)}/disconnect`),

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

  // ── Stats Dashboard
  getStats:         () => apiCall('GET', '/api/stats/summary'),

  // ── Server Lookup
  lookupServer:     (id) => apiCall('GET', `/api/lookup/server/${encodeURIComponent(id)}`),

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

  // ── Bot Tokens
  botsList:           () => apiCall('GET', '/api/bots'),
  botsAllTokensUrl:   (format = 'text') => `/api/bots/all-tokens?format=${encodeURIComponent(format)}`,
  botsDelete:         (id) => apiCall('DELETE', `/api/bots/${encodeURIComponent(id)}`),
  botsStatus:         () => apiCall('GET', '/api/bots/status'),
  botsCreate:         (cfg) => apiCall('POST', '/api/bots/create', cfg),
  botsCancel:         () => apiCall('POST', '/api/bots/cancel'),
  botsSubmitCaptcha:  (captchaKey) => apiCall('POST', '/api/bots/captcha', { captchaKey }),
  botsGetConfig:      () => apiCall('GET', '/api/bots/config'),
  botsSetConfig:      (cfg) => apiCall('POST', '/api/bots/config', cfg),
};
