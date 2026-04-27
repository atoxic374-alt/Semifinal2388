import { showNotification } from '../utils/ui.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

const VOICE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;

const STATE_PRESETS = [
  { id: 'unmute',  label: 'Unmuted',     icon: '🎙️',  selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false },
  { id: 'mute',   label: 'Muted',        icon: '🔇',  selfMute: true,  selfDeaf: false, selfVideo: false, selfStream: false },
  { id: 'deaf',   label: 'Deafened',     icon: '🔕',  selfMute: true,  selfDeaf: true,  selfVideo: false, selfStream: false },
  { id: 'cam',    label: 'Camera On',    icon: '📹',  selfMute: false, selfDeaf: false, selfVideo: true,  selfStream: false },
  { id: 'stream', label: 'Screen Share', icon: '🖥️',  selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true  },
];

export class VoiceManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.guilds = [];
    this.sessions = [];
    this.rotations = [];
    this.cycles = [];
    this.selectedGuild = null;
    this.selectedAccounts = [];
    this.rotationChannels = [];
    this.cycleStates = [];
    this.guildFilter = '';
    this.channelFilter = '';
    this._refreshTimer = null;
  }

  async init() { await this.render(); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="vm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon vm-header-icon">${VOICE_ICON}</span>
            <div>
              <h2 class="mm-title">Voice Manager</h2>
              <p class="mm-subtitle">Control accounts in voice channels</p>
            </div>
          </div>
          <div class="mm-tabs" id="vm-acct-picker"></div>
        </div>

        <div class="vm-body">
          <!-- LEFT: Guild + Channel Picker -->
          <div class="vm-panel vm-panel-left">
            <div class="vm-panel-header">
              <span class="vm-panel-icon">${icon('shield')}</span>
              <span>Servers & Channels</span>
            </div>
            <input id="vm-guild-filter" class="vm-search" placeholder="🔍  Search servers…" value="">
            <div id="vm-guild-list" class="vm-guild-list">
              <div class="vm-loading">${icon('loader')} Loading…</div>
            </div>
          </div>

          <!-- CENTER: Actions Panel -->
          <div class="vm-panel vm-panel-center">
            <!-- Join Controls -->
            <div class="vm-section">
              <div class="vm-section-title">
                <span>🎙️</span> Join Voice Channel
              </div>
              <div id="vm-selected-info" class="vm-selected-info">
                <span class="vm-no-sel">← Select a channel from the list</span>
              </div>
              <div class="vm-join-grid">
                <button class="vm-btn vm-btn-primary" onclick="window.voiceManager.joinSelected()">
                  ${icon('log_in')} Join
                </button>
                <button class="vm-btn vm-btn-warning" onclick="window.voiceManager.joinAllToSelected()">
                  ${icon('users')} Join All
                </button>
                <button class="vm-btn vm-btn-danger" onclick="window.voiceManager.leaveSelected()">
                  ${icon('log_out')} Leave
                </button>
                <button class="vm-btn vm-btn-ghost" onclick="window.voiceManager.distributeRandom()">
                  🎲 Distribute
                </button>
              </div>
            </div>

            <!-- Voice States -->
            <div class="vm-section">
              <div class="vm-section-title">
                <span>🎛️</span> Voice State
              </div>
              <div class="vm-state-grid">
                ${STATE_PRESETS.map(s => `
                  <button class="vm-state-btn" data-state="${s.id}" onclick="window.voiceManager.applyState('${s.id}')" title="${s.label}">
                    <span class="vm-state-icon">${s.icon}</span>
                    <span class="vm-state-label">${s.label}</span>
                  </button>
                `).join('')}
              </div>
            </div>

            <!-- State Cycle -->
            <div class="vm-section">
              <div class="vm-section-title">
                <span>🔄</span> Auto State Cycle
              </div>
              <div class="vm-cycle-builder">
                <div class="vm-field-row">
                  <label>Interval</label>
                  <div class="vm-interval-group">
                    <input type="number" id="vm-cycle-val" class="vm-num-input" value="60" min="1" max="9999">
                    <select id="vm-cycle-unit" class="vm-select">
                      <option value="60000">Minutes</option>
                      <option value="3600000">Hours</option>
                    </select>
                  </div>
                </div>
                <div class="vm-field-row">
                  <label>States to cycle</label>
                </div>
                <div class="vm-cycle-states">
                  ${STATE_PRESETS.map(s => `
                    <label class="vm-chk-label">
                      <input type="checkbox" class="vm-cycle-check" value="${s.id}"> ${s.icon} ${s.label}
                    </label>
                  `).join('')}
                </div>
                <button class="vm-btn vm-btn-primary vm-btn-full" onclick="window.voiceManager.startStateCycle()">
                  ▶ Start Cycle
                </button>
              </div>
            </div>
          </div>

          <!-- RIGHT: Room Rotation + Active Sessions -->
          <div class="vm-panel vm-panel-right">
            <!-- Room Rotation -->
            <div class="vm-section">
              <div class="vm-section-title">
                <span>🔀</span> Room Rotation
              </div>
              <div class="vm-field-row">
                <label>Interval</label>
                <div class="vm-interval-group">
                  <input type="number" id="vm-rot-val" class="vm-num-input" value="60" min="1" max="9999">
                  <select id="vm-rot-unit" class="vm-select">
                    <option value="60000">Minutes</option>
                    <option value="3600000">Hours</option>
                  </select>
                </div>
              </div>
              <div class="vm-field-row vm-toggle-row">
                <label>Random order</label>
                <label class="vm-toggle">
                  <input type="checkbox" id="vm-rot-random">
                  <span class="vm-toggle-track"><span class="vm-toggle-thumb"></span></span>
                </label>
              </div>
              <div class="vm-rotation-channels" id="vm-rot-channels">
                <div class="vm-no-sel" style="font-size:12px;padding:8px 0">Select channels from the left panel then click Add</div>
              </div>
              <div class="vm-rot-btns">
                <button class="vm-btn vm-btn-ghost" onclick="window.voiceManager.addRotationChannel()">
                  + Add Selected
                </button>
                <button class="vm-btn vm-btn-primary" onclick="window.voiceManager.startRotation()">
                  ▶ Start
                </button>
              </div>
            </div>

            <!-- Active Sessions -->
            <div class="vm-section vm-section-sessions">
              <div class="vm-section-title">
                <span>📡</span> Active Sessions
                <button class="vm-refresh-btn" onclick="window.voiceManager.refreshSessions()" title="Refresh">↺</button>
              </div>
              <div id="vm-sessions-list" class="vm-sessions-list">
                <div class="vm-no-sel">No active sessions</div>
              </div>
            </div>

            <!-- Active Rotations & Cycles -->
            <div class="vm-section">
              <div class="vm-section-title">
                <span>⚙️</span> Running Tasks
              </div>
              <div id="vm-tasks-list" class="vm-tasks-list">
                <div class="vm-no-sel">No running tasks</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Account picker
    const pickerEl = this.contentArea.querySelector('#vm-acct-picker');
    const picker = await buildAccountPicker({ selectId: 'vm-acct' });
    this._pickerClients = picker.clients || [];
    this._activeAccount = picker.active || null;
    pickerEl.innerHTML = picker.html;
    picker.bind(pickerEl, (val) => {
      this.selectedAccounts = val ? [val] : [];
      this.loadGuilds();
    });

    // Guild filter
    this.contentArea.querySelector('#vm-guild-filter').addEventListener('input', (e) => {
      this.guildFilter = e.target.value.toLowerCase();
      this._renderGuildList();
    });

    await this.loadGuilds();
    await this.refreshSessions();
    this._startAutoRefresh();
  }

  _startAutoRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this.refreshSessions(), 10000);
  }

  async loadGuilds() {
    const listEl = this.contentArea.querySelector('#vm-guild-list');
    if (!listEl) return;
    listEl.innerHTML = `<div class="vm-loading">${icon('loader')} Loading…</div>`;
    try {
      const acct = this.selectedAccounts[0] || null;
      const data = await window.electronAPI.voiceGetGuilds(acct);
      this.guilds = data.guilds || [];

      // Deduplicate guilds by guildId (show once per guild, listing all accounts)
      const guildMap = new Map();
      for (const g of this.guilds) {
        if (!guildMap.has(g.guildId)) guildMap.set(g.guildId, { ...g, accountList: [g.account] });
        else guildMap.get(g.guildId).accountList.push(g.account);
      }
      this._deduped = Array.from(guildMap.values());
      this._renderGuildList();
    } catch (e) {
      if (listEl) listEl.innerHTML = `<div class="vm-error">Failed to load servers</div>`;
    }
  }

  _renderGuildList() {
    const listEl = this.contentArea.querySelector('#vm-guild-list');
    if (!listEl) return;
    const filtered = (this._deduped || []).filter(g =>
      !this.guildFilter || g.guildName.toLowerCase().includes(this.guildFilter)
    );
    if (!filtered.length) {
      listEl.innerHTML = `<div class="vm-no-sel">No servers with voice channels found</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(g => `
      <div class="vm-guild-item ${this.selectedGuild?.guildId === g.guildId ? 'active' : ''}"
           data-guildid="${g.guildId}" onclick="window.voiceManager.selectGuild('${g.guildId}')">
        <div class="vm-guild-icon">
          ${g.guildIcon
            ? `<img src="${g.guildIcon}" alt="" onerror="this.style.display='none';this.nextSibling.style.display=''">
               <span style="display:none">${g.guildName[0]}</span>`
            : `<span>${g.guildName[0]}</span>`}
        </div>
        <div class="vm-guild-info">
          <div class="vm-guild-name">${this._esc(g.guildName)}</div>
          <div class="vm-guild-sub">${g.voiceChannels.length} voice channels</div>
        </div>
        <span class="vm-guild-arrow">›</span>
      </div>
      ${this.selectedGuild?.guildId === g.guildId ? `
        <div class="vm-channel-list" id="vm-ch-${g.guildId}">
          <input class="vm-search vm-ch-search" placeholder="🔍 Search channels…"
                 oninput="window.voiceManager.filterChannels(this.value, '${g.guildId}')">
          ${g.voiceChannels.map(ch => `
            <div class="vm-channel-item ${this.selectedChannel?.id === ch.id ? 'active' : ''}"
                 data-chid="${ch.id}" data-chname="${this._esc(ch.name)}"
                 onclick="window.voiceManager.selectChannel('${g.guildId}','${this._esc(g.guildName)}','${ch.id}','${this._esc(ch.name)}')">
              <span class="vm-ch-icon">🔊</span>
              <span class="vm-ch-name">${this._esc(ch.name)}</span>
              <span class="vm-ch-meta">${ch.members > 0 ? `👥 ${ch.members}` : ''} ${ch.bitrate}kbps</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `).join('');
  }

  selectGuild(guildId) {
    const g = (this._deduped || []).find(x => x.guildId === guildId);
    if (!g) return;
    this.selectedGuild = g;
    this.selectedChannel = null;
    this._updateSelectedInfo();
    this._renderGuildList();
  }

  selectChannel(guildId, guildName, channelId, channelName) {
    this.selectedGuild = (this._deduped || []).find(x => x.guildId === guildId) || { guildId, guildName };
    this.selectedChannel = { id: channelId, name: channelName };
    this._updateSelectedInfo();
    this._renderGuildList();
  }

  filterChannels(q, guildId) {
    const container = this.contentArea.querySelector(`#vm-ch-${guildId}`);
    if (!container) return;
    container.querySelectorAll('.vm-channel-item').forEach(el => {
      el.style.display = (!q || el.dataset.chname.toLowerCase().includes(q.toLowerCase())) ? '' : 'none';
    });
  }

  _updateSelectedInfo() {
    const el = this.contentArea.querySelector('#vm-selected-info');
    if (!el) return;
    if (this.selectedGuild && this.selectedChannel) {
      el.innerHTML = `
        <div class="vm-sel-detail">
          <div class="vm-sel-server">🛡️ <strong>${this._esc(this.selectedGuild.guildName)}</strong></div>
          <div class="vm-sel-channel">🔊 ${this._esc(this.selectedChannel.name)}</div>
        </div>`;
    } else if (this.selectedGuild) {
      el.innerHTML = `<span class="vm-no-sel">← Select a channel in <strong>${this._esc(this.selectedGuild.guildName)}</strong></span>`;
    } else {
      el.innerHTML = `<span class="vm-no-sel">← Select a channel from the list</span>`;
    }
  }

  _getAccounts() {
    if (this.selectedAccounts.length) return this.selectedAccounts;
    if (this._activeAccount) return [this._activeAccount];
    return [];
  }

  async joinSelected() {
    if (!this._checkChannelSelected()) return;
    const accounts = this._getAccounts();
    if (!accounts.length) { showNotification('Select at least one account', 'error'); return; }
    try {
      const r = await window.electronAPI.voiceJoin({ accounts, guildId: this.selectedGuild.guildId, channelId: this.selectedChannel.id });
      const ok = (r.results || []).filter(x => x.ok).length;
      showNotification(`Joined ${ok}/${accounts.length} accounts to ${this.selectedChannel.name}`, ok > 0 ? 'success' : 'error');
      setTimeout(() => this.refreshSessions(), 1000);
    } catch (e) { showNotification('Failed to join', 'error'); }
  }

  async joinAllToSelected() {
    if (!this._checkChannelSelected()) return;
    try {
      const r = await window.electronAPI.voiceJoinAll({ guildId: this.selectedGuild.guildId, channelId: this.selectedChannel.id });
      const ok = (r.results || []).filter(x => x.ok).length;
      showNotification(`Joined all ${ok} accounts to ${this.selectedChannel.name}`, 'success');
      setTimeout(() => this.refreshSessions(), 1000);
    } catch (e) { showNotification('Failed', 'error'); }
  }

  async leaveSelected() {
    if (!this.selectedGuild) { showNotification('Select a server first', 'error'); return; }
    const accounts = this._getAccounts();
    if (!accounts.length) { showNotification('Select at least one account', 'error'); return; }
    try {
      await window.electronAPI.voiceLeave({ accounts, guildId: this.selectedGuild.guildId });
      showNotification('Left voice channel', 'success');
      setTimeout(() => this.refreshSessions(), 1000);
    } catch (e) { showNotification('Failed', 'error'); }
  }

  async distributeRandom() {
    if (!this.selectedGuild) { showNotification('Select a server first', 'error'); return; }
    const channelIds = this.selectedGuild.voiceChannels?.map(c => c.id);
    if (!channelIds?.length) { showNotification('No voice channels available', 'error'); return; }
    const accounts = this._getAccounts();
    if (!accounts.length) { showNotification('Select at least one account', 'error'); return; }
    try {
      const r = await window.electronAPI.voiceDistributeRandom({ accounts, guildId: this.selectedGuild.guildId, channelIds });
      const ok = (r.results || []).filter(x => x.ok).length;
      showNotification(`Distributed ${ok} accounts randomly`, 'success');
      setTimeout(() => this.refreshSessions(), 1000);
    } catch (e) { showNotification('Failed', 'error'); }
  }

  async applyState(stateId) {
    const state = STATE_PRESETS.find(s => s.id === stateId);
    if (!state) return;
    if (!this.selectedGuild) { showNotification('Select a server first', 'error'); return; }
    const accounts = this._getAccounts();
    if (!accounts.length) { showNotification('Select at least one account', 'error'); return; }

    // Animate active state button
    this.contentArea.querySelectorAll('.vm-state-btn').forEach(b => b.classList.remove('active'));
    this.contentArea.querySelector(`[data-state="${stateId}"]`)?.classList.add('active');

    try {
      await window.electronAPI.voiceSetState({
        accounts, guildId: this.selectedGuild.guildId,
        selfMute: state.selfMute, selfDeaf: state.selfDeaf,
        selfVideo: state.selfVideo, selfStream: state.selfStream
      });
      showNotification(`Applied "${state.label}" to ${accounts.length} account(s)`, 'success');
      setTimeout(() => this.refreshSessions(), 1000);
    } catch (e) { showNotification('Failed to set state', 'error'); }
  }

  addRotationChannel() {
    if (!this.selectedChannel) { showNotification('Select a channel first', 'error'); return; }
    const exists = this.rotationChannels.find(c => c.id === this.selectedChannel.id);
    if (exists) { showNotification('Channel already added', 'error'); return; }
    this.rotationChannels.push({ ...this.selectedChannel, guildId: this.selectedGuild.guildId });
    this._renderRotationChannels();
  }

  removeRotationChannel(id) {
    this.rotationChannels = this.rotationChannels.filter(c => c.id !== id);
    this._renderRotationChannels();
  }

  _renderRotationChannels() {
    const el = this.contentArea.querySelector('#vm-rot-channels');
    if (!el) return;
    if (!this.rotationChannels.length) {
      el.innerHTML = `<div class="vm-no-sel" style="font-size:12px;padding:8px 0">Select channels and click Add</div>`;
      return;
    }
    el.innerHTML = this.rotationChannels.map((c, i) => `
      <div class="vm-rot-ch-item">
        <span class="vm-rot-ch-num">${i + 1}</span>
        <span class="vm-rot-ch-name">🔊 ${this._esc(c.name)}</span>
        <button class="vm-rot-ch-del" onclick="window.voiceManager.removeRotationChannel('${c.id}')">✕</button>
      </div>
    `).join('');
  }

  async startRotation() {
    if (this.rotationChannels.length < 2) { showNotification('Add at least 2 channels for rotation', 'error'); return; }
    const accounts = this._getAccounts();
    if (!accounts.length) { showNotification('Select at least one account', 'error'); return; }
    const guildId = this.rotationChannels[0].guildId;
    const guildName = this.selectedGuild?.guildName || guildId;
    const val = parseInt(this.contentArea.querySelector('#vm-rot-val')?.value || '60');
    const unit = parseInt(this.contentArea.querySelector('#vm-rot-unit')?.value || '60000');
    const randomOrder = this.contentArea.querySelector('#vm-rot-random')?.checked || false;
    const intervalMs = val * unit;
    try {
      await window.electronAPI.voiceStartRotation({
        accounts, guildId, guildName,
        channelIds: this.rotationChannels.map(c => c.id),
        intervalMs, randomOrder
      });
      showNotification('Room rotation started!', 'success');
      this.rotationChannels = [];
      this._renderRotationChannels();
      setTimeout(() => this.refreshTasks(), 1000);
    } catch (e) { showNotification('Failed to start rotation', 'error'); }
  }

  async startStateCycle() {
    if (!this.selectedGuild) { showNotification('Select a server first', 'error'); return; }
    const accounts = this._getAccounts();
    if (!accounts.length) { showNotification('Select at least one account', 'error'); return; }
    const checked = Array.from(this.contentArea.querySelectorAll('.vm-cycle-check:checked')).map(el => el.value);
    if (checked.length < 2) { showNotification('Select at least 2 states to cycle', 'error'); return; }
    const states = checked.map(id => STATE_PRESETS.find(s => s.id === id)).filter(Boolean).map(s => ({
      selfMute: s.selfMute, selfDeaf: s.selfDeaf, selfVideo: s.selfVideo, selfStream: s.selfStream
    }));
    const val = parseInt(this.contentArea.querySelector('#vm-cycle-val')?.value || '60');
    const unit = parseInt(this.contentArea.querySelector('#vm-cycle-unit')?.value || '60000');
    const intervalMs = val * unit;
    try {
      await window.electronAPI.voiceStartStateCycle({ accounts, guildId: this.selectedGuild.guildId, states, intervalMs });
      showNotification('State cycle started!', 'success');
      this.contentArea.querySelectorAll('.vm-cycle-check').forEach(el => el.checked = false);
      setTimeout(() => this.refreshTasks(), 1000);
    } catch (e) { showNotification('Failed to start cycle', 'error'); }
  }

  async refreshSessions() {
    try {
      const data = await window.electronAPI.voiceGetSessions();
      this.sessions = data.sessions || [];
      this._renderSessions();
    } catch (e) {}
    await this.refreshTasks();
  }

  async refreshTasks() {
    try {
      const [rData, cData] = await Promise.all([
        window.electronAPI.voiceGetRotations(),
        window.electronAPI.voiceGetStateCycles()
      ]);
      this.rotations = rData.rotations || [];
      this.cycles = cData.cycles || [];
      this._renderTasks();
    } catch (e) {}
  }

  _renderSessions() {
    const el = this.contentArea.querySelector('#vm-sessions-list');
    if (!el) return;
    if (!this.sessions.length) { el.innerHTML = `<div class="vm-no-sel">No active sessions</div>`; return; }
    el.innerHTML = this.sessions.map(s => {
      const stateIcons = [
        s.selfMute ? '🔇' : '🎙️',
        s.selfDeaf ? '🔕' : '',
        s.selfVideo ? '📹' : '',
        s.selfStream ? '🖥️' : ''
      ].filter(Boolean).join('');
      return `
        <div class="vm-session-item">
          <div class="vm-session-avatar">${s.name[0]?.toUpperCase()}</div>
          <div class="vm-session-info">
            <div class="vm-session-name">${this._esc(s.name)}</div>
            <div class="vm-session-ch">🔊 ch:${s.channelId?.slice(-4)} ${stateIcons}</div>
          </div>
          <button class="vm-session-leave" title="Leave"
                  onclick="window.voiceManager._quickLeave('${s.name}','${s.guildId}')">✕</button>
        </div>
      `;
    }).join('');
  }

  async _quickLeave(name, guildId) {
    try {
      await window.electronAPI.voiceLeave({ accounts: [name], guildId });
      setTimeout(() => this.refreshSessions(), 800);
    } catch (e) {}
  }

  _renderTasks() {
    const el = this.contentArea.querySelector('#vm-tasks-list');
    if (!el) return;
    const items = [
      ...this.rotations.map(r => ({
        type: 'rotation',
        id: r.id,
        label: `🔀 Room Rotation`,
        sub: `${r.accounts?.length || 0} account(s) • ${Math.round(r.intervalMs / 60000)}m interval`,
        nextIn: r.nextAt ? Math.max(0, Math.round((r.nextAt - Date.now()) / 1000)) : null
      })),
      ...this.cycles.map(c => ({
        type: 'cycle',
        id: c.id,
        label: `🔄 State Cycle`,
        sub: `${c.accounts?.length || 0} account(s) • ${Math.round(c.intervalMs / 60000)}m interval`,
        nextIn: c.nextAt ? Math.max(0, Math.round((c.nextAt - Date.now()) / 1000)) : null
      }))
    ];
    if (!items.length) { el.innerHTML = `<div class="vm-no-sel">No running tasks</div>`; return; }
    el.innerHTML = items.map(item => `
      <div class="vm-task-item">
        <div class="vm-task-info">
          <div class="vm-task-label">${item.label}</div>
          <div class="vm-task-sub">${item.sub}</div>
          ${item.nextIn !== null ? `<div class="vm-task-next">Next: ${item.nextIn}s</div>` : ''}
        </div>
        <button class="vm-task-stop" onclick="window.voiceManager.stopTask('${item.type}','${item.id}')">■ Stop</button>
      </div>
    `).join('');
  }

  async stopTask(type, id) {
    try {
      if (type === 'rotation') await window.electronAPI.voiceStopRotation({ id });
      else await window.electronAPI.voiceStopStateCycle({ id });
      showNotification('Task stopped', 'success');
      await this.refreshTasks();
    } catch (e) { showNotification('Failed to stop task', 'error'); }
  }

  _checkChannelSelected() {
    if (!this.selectedGuild || !this.selectedChannel) {
      showNotification('Select a server and voice channel first', 'error');
      return false;
    }
    return true;
  }

  _esc(str) { return String(str || '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c])); }

  destroy() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
  }
}
