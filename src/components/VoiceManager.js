import { showNotification } from '../utils/ui.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

const STATES = [
  { id: 'unmute',  key: 'vm.unmute',  ic: 'mic',        color: '#22c55e', selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false },
  { id: 'mute',   key: 'vm.mute',    ic: 'mic_off',    color: '#f59e0b', selfMute: true,  selfDeaf: false, selfVideo: false, selfStream: false },
  { id: 'deaf',   key: 'vm.deaf',    ic: 'headphones', color: '#ef4444', selfMute: true,  selfDeaf: true,  selfVideo: false, selfStream: false },
  { id: 'cam',    key: 'vm.cam',     ic: 'video',      color: '#8b5cf6', selfMute: false, selfDeaf: false, selfVideo: true,  selfStream: false },
  { id: 'stream', key: 'vm.stream',  ic: 'monitor',    color: '#06b6d4', selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true  },
];

export class VoiceManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this._view = 'home';
    this._history = [];
    this._guilds = [];
    this._deduped = [];
    this._sessions = [];
    this._rotations = [];
    this._cycles = [];
    this.selectedGuild = null;
    this.selectedChannel = null;
    this.selectedAccounts = [];
    this._rotChannels = [];
    this._activeAccount = null;
    this._pickerClients = [];
    this._timer = null;
    this._expandedAccount = null;
  }

  async init() {
    await this._render('home', false);
    this._autoRefresh();
  }

  // ── Navigation ──────────────────────────────────
  async _navigate(view) {
    this._history.push(this._view);
    await this._render(view, true);
  }

  async _back() {
    const prev = this._history.pop() || 'home';
    await this._render(prev, false, true);
  }

  async _render(view, forward = true, backward = false) {
    this._view = view;
    const wrap = this.contentArea.querySelector('#vm-wrap');
    if (wrap) {
      wrap.classList.remove('vm-slide-in', 'vm-slide-out', 'vm-slide-back-in', 'vm-slide-back-out');
      void wrap.offsetWidth;
      if (backward) wrap.classList.add('vm-slide-back-in');
      else if (forward) wrap.classList.add('vm-slide-in');
    }

    const html = await this._buildView(view);
    if (!wrap) {
      this.contentArea.innerHTML = `<div id="vm-wrap" class="vm-wrap">${html}</div>`;
    } else {
      wrap.innerHTML = html;
      if (backward) wrap.classList.add('vm-slide-back-in');
      else if (forward) wrap.classList.add('vm-slide-in');
    }
    this._bindView(view);
  }

  async _buildView(view) {
    switch (view) {
      case 'home':          return this._homeHTML();
      case 'server-picker': return this._serverPickerHTML();
      case 'join':          return this._subHTML('vm.join_title', this._joinHTML());
      case 'state':         return this._subHTML('vm.state_title', this._stateHTML());
      case 'rotation':      return this._subHTML('vm.rotation_title', this._rotationHTML());
      case 'cycle':         return this._subHTML('vm.cycle_title', this._cycleHTML());
      case 'sessions':      return this._subHTML('vm.sessions_title', this._sessionsHTML());
      default:              return this._homeHTML();
    }
  }

  // ── Home View ────────────────────────────────────
  _homeHTML() {
    const ch = this.selectedChannel;
    const g  = this.selectedGuild;
    const chLabel = (ch && g) ? `${g.guildName} › ${ch.name}` : t('vm.tap_to_select');

    const sessCount = this._sessions.length;
    const taskCount = this._rotations.length + this._cycles.length;
    const voiceByAccount = new Map();
    for (const s of this._sessions) voiceByAccount.set(s.name, (voiceByAccount.get(s.name) || 0) + 1);
    const accountRows = (this._pickerClients || []).map(c => {
      const inVoice = voiceByAccount.get(c.name) || 0;
      const status = c.status || 'offline';
      const sess = this._sessions.find(s => s.name === c.name);
      const guild = this._guilds.find(g => g.account === c.name && g.guildId === sess?.guildId);
      const ch = guild?.voiceChannels?.find(v => v.id === sess?.channelId);
      const expanded = this._expandedAccount === c.name;
      return `
        <div class="vm-acc-card ${expanded ? 'open' : ''}">
          <button class="vm-acc-row" onclick="window.voiceManager.toggleAccountCard('${this._esc(c.name)}')">
            <img class="vm-acc-avatar" src="${this._esc(c.avatar || '/discord.png')}" onerror="this.src='/discord.png'" alt="">
            <span class="vm-acc-name">${this._esc(c.displayName || c.username || c.name)}</span>
            <span class="vm-acc-expand">${icon('chevron_d')}</span>
          </button>
          <div class="vm-acc-details">
            <div class="vm-acc-meta"><span class="vm-acc-dot ${status}"></span> ${status}</div>
            <div class="vm-acc-meta">${icon('radio')} ${inVoice ? `${inVoice} ${t('vm.active')}` : t('vm.no_sessions_short')}</div>
            <div class="vm-acc-meta">${icon('shield')} ${this._esc(guild?.guildName || '—')}</div>
            <div class="vm-acc-meta">${icon('volume')} ${this._esc(ch?.name || '—')}</div>
            ${sess ? `<div class="vm-acc-state">
              ${sess.selfMute ? icon('mic_off') : icon('mic')}
              ${sess.selfDeaf ? icon('headphones') : ''}
              ${sess.selfVideo ? icon('video') : ''}
              ${sess.selfStream ? icon('monitor') : ''}
            </div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="vm-home">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon vm-accent-icon">${icon('mic')}</span>
            <div>
              <h2 class="mm-title">${t('vm.title')}</h2>
              <p class="mm-subtitle">${t('vm.subtitle')}</p>
            </div>
          </div>
          <div id="vm-acct-area" class="mm-tabs"></div>
        </div>

        <div class="vm-home-body">
          <!-- Channel Selector Card -->
          <button class="vm-nav-card" onclick="window.voiceManager._navigate('server-picker')">
            <span class="vm-nav-card-icon">${icon('shield')}</span>
            <div class="vm-nav-card-body">
              <div class="vm-nav-card-label">${t('vm.selected_channel')}</div>
              <div class="vm-nav-card-value ${ch ? '' : 'vm-muted'}">${this._esc(chLabel)}</div>
            </div>
            <span class="vm-nav-card-arrow">${icon('chevron_r')}</span>
          </button>

          <!-- Quick Actions -->
          <div class="vm-section-label">${t('vm.actions')}</div>
          <div class="vm-action-grid">
            <button class="vm-action-btn" onclick="window.voiceManager._navigate('join')">
              ${icon('log_in')}<span>${t('vm.join')}</span>
            </button>
            <button class="vm-action-btn" onclick="window.voiceManager._navigate('state')">
              ${icon('mic')}<span>${t('vm.state_title')}</span>
            </button>
            <button class="vm-action-btn" onclick="window.voiceManager._navigate('rotation')">
              ${icon('repeat')}<span>${t('vm.rotation_title')}</span>
            </button>
            <button class="vm-action-btn" onclick="window.voiceManager._navigate('cycle')">
              ${icon('rotate_cw')}<span>${t('vm.cycle_title')}</span>
            </button>
          </div>

          <!-- Sessions / Tasks summary -->
          <button class="vm-nav-card vm-nav-card-sm" onclick="window.voiceManager._navigate('sessions')">
            <span class="vm-nav-card-icon vm-green">${icon('radio')}</span>
            <div class="vm-nav-card-body">
              <div class="vm-nav-card-label">${t('vm.sessions_title')}</div>
              <div class="vm-nav-card-value">
                ${sessCount ? `${sessCount} ${t('vm.active')}` : t('vm.no_sessions_short')}
                ${taskCount ? ` · ${taskCount} ${t('vm.tasks_running')}` : ''}
              </div>
            </div>
            <span class="vm-nav-card-arrow">${icon('chevron_r')}</span>
          </button>
          <div class="vm-section-label">${t('vm.accounts')}</div>
          <div class="vm-acc-list">
            ${accountRows || `<div class="vm-empty">${t('vm.no_sessions_short')}</div>`}
          </div>
        </div>
      </div>
    `;
  }
  toggleAccountCard(name) {
    this._expandedAccount = (this._expandedAccount === name) ? null : name;
    if (this._view === 'home') this._render('home', false);
  }

  // ── Sub-view wrapper ──────────────────────────────
  _subHTML(titleKey, content) {
    return `
      <div class="vm-sub">
        <div class="vm-sub-header">
          <button class="vm-back-btn" onclick="window.voiceManager._back()">
            ${icon('arrow_left')}<span>${t('vm.back')}</span>
          </button>
          <div class="vm-sub-title">${t(titleKey)}</div>
        </div>
        <div class="vm-sub-body">${content}</div>
      </div>
    `;
  }

  // ── Server/Channel Picker ─────────────────────────
  _serverPickerHTML() {
    const filtered = this._deduped;
    return `
      <div class="vm-sub">
        <div class="vm-sub-header">
          <button class="vm-back-btn" onclick="window.voiceManager._back()">
            ${icon('arrow_left')}<span>${t('vm.back')}</span>
          </button>
          <div class="vm-sub-title">${t('vm.select_channel')}</div>
        </div>
        <div class="vm-sub-body">
          <input id="vm-gsearch" class="vm-search-input" placeholder="${t('vm.search_servers')}">
          <div id="vm-glist" class="vm-server-list">
            ${filtered.length ? filtered.map(g => this._serverItem(g)).join('') : `<div class="vm-empty">${icon('loader')} ${t('common.loading')}</div>`}
          </div>
        </div>
      </div>
    `;
  }

  _serverItem(g) {
    const open = this.selectedGuild?.guildId === g.guildId;
    return `
      <div class="vm-server-item">
        <button class="vm-server-row ${open ? 'vm-open' : ''}" onclick="window.voiceManager._toggleGuild('${g.guildId}')">
          <div class="vm-server-icon">${g.guildIcon ? `<img src="${g.guildIcon}" alt="">` : `<span>${g.guildName[0]}</span>`}</div>
          <div class="vm-server-info">
            <div class="vm-server-name">${this._esc(g.guildName)}</div>
            <div class="vm-server-meta">${g.voiceChannels.length} ${t('vm.voice_channels')}</div>
          </div>
          <span class="vm-server-arrow ${open ? 'vm-open' : ''}">${icon('chevron_d')}</span>
        </button>
        ${open ? `
          <div class="vm-channel-items">
            ${g.voiceChannels.map(ch => `
              <button class="vm-channel-row ${this.selectedChannel?.id === ch.id ? 'vm-active' : ''}"
                      onclick="window.voiceManager._selectChannel('${g.guildId}','${this._esc(g.guildName)}','${ch.id}','${this._esc(ch.name)}')">
                ${icon('volume')}<span>${this._esc(ch.name)}</span>
                <span class="vm-ch-meta">${ch.members > 0 ? `${ch.members} ${icon('users')}` : ''}</span>
                ${this.selectedChannel?.id === ch.id ? icon('check') : ''}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  // ── Join Sub-view ─────────────────────────────────
  _joinHTML() {
    const ch = this.selectedChannel;
    const g  = this.selectedGuild;
    return `
      <div class="vm-info-bar ${ch ? 'vm-info-bar-ok' : ''}">
        ${icon('volume')} ${ch ? `${this._esc(g.guildName)} › ${this._esc(ch.name)}` : t('vm.no_channel_selected')}
      </div>
      <div class="vm-btn-stack">
        <button class="vm-big-btn vm-green-btn" onclick="window.voiceManager.joinSelected()">
          ${icon('log_in')} ${t('vm.join_channel')}
        </button>
        <button class="vm-big-btn vm-blue-btn" onclick="window.voiceManager.joinAllToSelected()">
          ${icon('users')} ${t('vm.join_all')}
        </button>
        <button class="vm-big-btn vm-orange-btn" onclick="window.voiceManager.distributeRandom()">
          ${icon('repeat')} ${t('vm.distribute')}
        </button>
        <button class="vm-big-btn vm-red-btn" onclick="window.voiceManager.leaveSelected()">
          ${icon('log_out')} ${t('vm.leave')}
        </button>
      </div>
    `;
  }

  // ── State Sub-view ────────────────────────────────
  _stateHTML() {
    const ch = this.selectedChannel;
    const g  = this.selectedGuild;
    return `
      <div class="vm-info-bar ${ch ? 'vm-info-bar-ok' : ''}">
        ${icon('volume')} ${ch ? `${this._esc(g.guildName)} › ${this._esc(ch.name)}` : t('vm.no_channel_selected')}
      </div>
      <div class="vm-state-list">
        ${STATES.map(s => `
          <button class="vm-state-row" onclick="window.voiceManager.applyState('${s.id}')"
                  style="--sc:${s.color}">
            <span class="vm-state-ic" style="color:${s.color}">${icon(s.ic)}</span>
            <span class="vm-state-name">${t(s.key)}</span>
            <span class="vm-state-arrow">${icon('chevron_r')}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  // ── Rotation Sub-view ─────────────────────────────
  _rotationHTML() {
    return `
      <div class="vm-field-group">
        <label class="vm-label">${t('vm.interval')}</label>
        <div class="vm-row-inputs">
          <input type="number" id="vm-rot-val" class="vm-num" value="60" min="1" max="9999">
          <select id="vm-rot-unit" class="vm-sel">
            <option value="60000">${t('vm.minutes')}</option>
            <option value="3600000">${t('vm.hours')}</option>
          </select>
        </div>
      </div>
      <div class="vm-toggle-row">
        <span class="vm-label">${t('vm.random_order')}</span>
        <label class="vm-sw">
          <input type="checkbox" id="vm-rot-rand">
          <span class="vm-sw-track"><span class="vm-sw-thumb"></span></span>
        </label>
      </div>
      <div class="vm-label">${t('vm.channels_for_rotation')}</div>
      <div id="vm-rot-chs" class="vm-rot-list">
        ${this._rotChannels.length ? this._rotChannels.map((c,i) => `
          <div class="vm-rot-item">
            <span class="vm-rot-num">${i+1}</span>
            <span class="vm-rot-ch">${icon('volume')} ${this._esc(c.name)}</span>
            <button class="vm-rot-del" onclick="window.voiceManager.removeRotCh('${c.id}')">✕</button>
          </div>`).join('') : `<div class="vm-empty">${t('vm.no_rotation_channels')}</div>`}
      </div>
      <div class="vm-row-btns">
        <button class="vm-outline-btn" onclick="window.voiceManager.addRotCh()">
          ${icon('plus')} ${t('vm.add_channel')}
        </button>
        <button class="vm-big-btn vm-green-btn" onclick="window.voiceManager.startRotation()">
          ${icon('play')} ${t('vm.start')}
        </button>
      </div>
      ${this._rotations.length ? `
        <div class="vm-label" style="margin-top:16px">${t('vm.running_tasks')}</div>
        ${this._rotations.map(r => this._taskCard(r, 'rotation')).join('')}
      ` : ''}
    `;
  }

  // ── Cycle Sub-view ────────────────────────────────
  _cycleHTML() {
    return `
      <div class="vm-field-group">
        <label class="vm-label">${t('vm.interval')}</label>
        <div class="vm-row-inputs">
          <input type="number" id="vm-cyc-val" class="vm-num" value="60" min="1" max="9999">
          <select id="vm-cyc-unit" class="vm-sel">
            <option value="60000">${t('vm.minutes')}</option>
            <option value="3600000">${t('vm.hours')}</option>
          </select>
        </div>
      </div>
      <div class="vm-label">${t('vm.states_to_cycle')}</div>
      <div class="vm-state-checks">
        ${STATES.map(s => `
          <label class="vm-chk-row" style="--sc:${s.color}">
            <input type="checkbox" class="vm-cyc-chk" value="${s.id}">
            <span class="vm-chk-ic" style="color:${s.color}">${icon(s.ic)}</span>
            <span>${t(s.key)}</span>
          </label>
        `).join('')}
      </div>
      <button class="vm-big-btn vm-green-btn" style="margin-top:8px" onclick="window.voiceManager.startCycle()">
        ${icon('play')} ${t('vm.start')}
      </button>
      ${this._cycles.length ? `
        <div class="vm-label" style="margin-top:16px">${t('vm.running_tasks')}</div>
        ${this._cycles.map(c => this._taskCard(c, 'cycle')).join('')}
      ` : ''}
    `;
  }

  // ── Sessions Sub-view ─────────────────────────────
  _sessionsHTML() {
    const sessions = this._sessions;
    const tasks = [...this._rotations.map(r => ({...r, type:'rotation'})), ...this._cycles.map(c => ({...c, type:'cycle'}))];
    return `
      <div class="vm-label">${t('vm.active_sessions')}</div>
      <div class="vm-session-list">
        ${sessions.length ? sessions.map(s => `
          <div class="vm-sess-row">
            <div class="vm-sess-av">${(s.name[0]||'?').toUpperCase()}</div>
            <div class="vm-sess-info">
              <div class="vm-sess-name">${this._esc(s.name)}</div>
              <div class="vm-sess-state">
                ${s.selfMute ? `<span>${icon('mic_off')}</span>` : `<span>${icon('mic')}</span>`}
                ${s.selfDeaf ? `<span>${icon('headphones')}</span>` : ''}
                ${s.selfVideo ? `<span>${icon('video')}</span>` : ''}
                ${s.selfStream ? `<span>${icon('monitor')}</span>` : ''}
              </div>
            </div>
            <button class="vm-sess-leave" onclick="window.voiceManager._quickLeave('${s.name}','${s.guildId}')">
              ${icon('log_out')}
            </button>
          </div>
        `).join('') : `<div class="vm-empty">${t('vm.no_sessions')}</div>`}
      </div>
      ${tasks.length ? `
        <div class="vm-label" style="margin-top:16px">${t('vm.running_tasks')}</div>
        ${tasks.map(task => this._taskCard(task, task.type)).join('')}
      ` : ''}
    `;
  }

  _taskCard(task, type) {
    const label = type === 'rotation' ? t('vm.rotation_title') : t('vm.cycle_title');
    const accts = (task.accounts || []).length;
    const mins = Math.round((task.intervalMs || 0) / 60000);
    const nextIn = task.nextAt ? Math.max(0, Math.round((task.nextAt - Date.now()) / 1000)) : null;
    return `
      <div class="vm-task-row">
        <div class="vm-task-info">
          <div class="vm-task-name">${icon(type === 'rotation' ? 'repeat' : 'rotate_cw')} ${label}</div>
          <div class="vm-task-meta">${accts} ${t('vm.accounts')} · ${mins}${t('vm.min_abbr')} ${nextIn !== null ? `· ${t('vm.next')}: ${nextIn}s` : ''}</div>
        </div>
        <button class="vm-stop-btn" onclick="window.voiceManager.stopTask('${type}','${task.id}')">
          ${icon('stop')} ${t('vm.stop')}
        </button>
      </div>
    `;
  }

  // ── Bind event listeners after render ─────────────
  async _bindView(view) {
    if (view === 'home') {
      const acctArea = this.contentArea.querySelector('#vm-acct-area');
      if (acctArea) {
        const picker = await buildAccountPicker({ selectId: 'vm-acct' });
        this._pickerClients = picker.clients || [];
        this._activeAccount = picker.active || null;
        acctArea.innerHTML = picker.html;
        picker.bind(acctArea, async (val) => {
          this.selectedAccounts = val ? [val] : [];
          this.selectedGuild = null;
          this.selectedChannel = null;
          this._deduped = [];
          await this._loadGuilds();
          this._refreshSessions();
        });
      }
      await this._loadGuilds();
      await this._refreshSessions();
    }

    if (view === 'server-picker') {
      await this._loadGuilds();
      const gsearch = this.contentArea.querySelector('#vm-gsearch');
      if (gsearch) {
        gsearch.addEventListener('input', (e) => {
          const q = e.target.value.toLowerCase();
          this.contentArea.querySelectorAll('.vm-server-item').forEach(el => {
            const name = el.querySelector('.vm-server-name')?.textContent?.toLowerCase() || '';
            el.style.display = (!q || name.includes(q)) ? '' : 'none';
          });
        });
      }
    }
  }

  // ── Data Loading ──────────────────────────────────
  async _loadGuilds() {
    try {
      const acct = this.selectedAccounts[0] || this._activeAccount || null;
      const data = await window.electronAPI.voiceGetGuilds(acct);
      this._guilds = data.guilds || [];
      const map = new Map();
      for (const g of this._guilds) {
        if (!map.has(g.guildId)) map.set(g.guildId, { ...g, accountList: [g.account] });
        else map.get(g.guildId).accountList.push(g.account);
      }
      this._deduped = Array.from(map.values());

      if (this._view === 'server-picker') {
        const list = this.contentArea.querySelector('#vm-glist');
        if (list) list.innerHTML = this._deduped.map(g => this._serverItem(g)).join('');
      }
    } catch (e) {}
  }

  async _refreshSessions() {
    try {
      const [sd, rd, cd] = await Promise.all([
        window.electronAPI.voiceGetSessions(),
        window.electronAPI.voiceGetRotations(),
        window.electronAPI.voiceGetStateCycles(),
      ]);
      this._sessions  = sd.sessions  || [];
      this._rotations = rd.rotations || [];
      this._cycles    = cd.cycles    || [];
    } catch (e) {}
  }

  _autoRefresh() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._refreshSessions(), 10000);
  }

  // ── Interactions ──────────────────────────────────
  _toggleGuild(guildId) {
    const g = this._deduped.find(x => x.guildId === guildId);
    if (!g) return;
    this.selectedGuild = (this.selectedGuild?.guildId === guildId) ? null : g;
    this.selectedChannel = null;
    const list = this.contentArea.querySelector('#vm-glist');
    if (list) list.innerHTML = this._deduped.map(x => this._serverItem(x)).join('');
  }

  _selectChannel(guildId, guildName, channelId, channelName) {
    const g = this._deduped.find(x => x.guildId === guildId);
    this.selectedGuild = g || { guildId, guildName, voiceChannels: [] };
    this.selectedChannel = { id: channelId, name: channelName };
    showNotification(`${t('vm.selected')}: ${channelName}`, 'success');
    setTimeout(() => this._back(), 350);
  }

  _accounts() {
    if (this.selectedAccounts.length) return this.selectedAccounts;
    if (this._activeAccount) return [this._activeAccount];
    return [];
  }

  _needChannel() {
    if (!this.selectedGuild || !this.selectedChannel) {
      showNotification(t('vm.select_channel_first'), 'error');
      return false;
    }
    return true;
  }

  _needAccounts() {
    if (!this._accounts().length) {
      showNotification(t('vm.select_account_first'), 'error');
      return false;
    }
    return true;
  }

  async joinSelected() {
    if (!this._needChannel() || !this._needAccounts()) return;
    try {
      const accs = this._accounts();
      const r = await window.electronAPI.voiceJoin({ accounts: accs, guildId: this.selectedGuild.guildId, channelId: this.selectedChannel.id });
      if (r && r.success === false) { showNotification(r.error || t('vm.error'), 'error'); return; }
      const results = r.results || [];
      const ok = results.filter(x=>x.ok).length;
      await this._refreshSessions();
      if (ok === 0) {
        const firstErr = results.find(x => !x.ok)?.error || r.error || t('vm.error');
        showNotification(`${t('vm.joined')} 0/${accs.length} — ${firstErr}`, 'error');
      } else if (ok < accs.length) {
        const firstErr = results.find(x => !x.ok)?.error || '';
        showNotification(`${t('vm.joined')} ${ok}/${accs.length}${firstErr ? ' — ' + firstErr : ''}`, 'error');
      } else {
        showNotification(`${t('vm.joined')} ${ok}/${accs.length}`, 'success');
      }
    } catch(e) { showNotification(e?.message || t('vm.error'), 'error'); }
  }

  async joinAllToSelected() {
    if (!this._needChannel()) return;
    try {
      const r = await window.electronAPI.voiceJoinAll({ guildId: this.selectedGuild.guildId, channelId: this.selectedChannel.id });
      if (r && r.success === false) { showNotification(r.error || t('vm.error'), 'error'); return; }
      const results = r.results || [];
      const ok = results.filter(x=>x.ok).length;
      await this._refreshSessions();
      if (ok === 0) {
        const firstErr = results.find(x => !x.ok)?.error || t('vm.error');
        showNotification(`${t('vm.joined_all')} 0 — ${firstErr}`, 'error');
      } else {
        showNotification(`${t('vm.joined_all')} ${ok}`, 'success');
      }
    } catch(e) { showNotification(e?.message || t('vm.error'), 'error'); }
  }

  async leaveSelected() {
    if (!this.selectedGuild) { showNotification(t('vm.select_server_first'), 'error'); return; }
    if (!this._needAccounts()) return;
    try {
      await window.electronAPI.voiceLeave({ accounts: this._accounts(), guildId: this.selectedGuild.guildId });
      await this._refreshSessions();
      showNotification(t('vm.left'), 'success');
    } catch(e) { showNotification(t('vm.error'), 'error'); }
  }

  async distributeRandom() {
    if (!this.selectedGuild) { showNotification(t('vm.select_server_first'), 'error'); return; }
    if (!this._needAccounts()) return;
    const channelIds = this.selectedGuild.voiceChannels?.map(c=>c.id);
    if (!channelIds?.length) { showNotification(t('vm.no_voice_channels'), 'error'); return; }
    try {
      const r = await window.electronAPI.voiceDistributeRandom({ accounts: this._accounts(), guildId: this.selectedGuild.guildId, channelIds });
      const ok = (r.results||[]).filter(x=>x.ok).length;
      await this._refreshSessions();
      showNotification(`${t('vm.distributed')} ${ok}`, 'success');
    } catch(e) { showNotification(t('vm.error'), 'error'); }
  }

  async applyState(stateId) {
    const state = STATES.find(s=>s.id===stateId);
    if (!state) return;
    if (!this.selectedGuild) { showNotification(t('vm.select_server_first'), 'error'); return; }
    if (!this._needAccounts()) return;
    this.contentArea.querySelectorAll('.vm-state-row').forEach(b => b.classList.remove('vm-active'));
    this.contentArea.querySelector(`[onclick*="applyState('${stateId}')"]`)?.classList.add('vm-active');
    try {
      const r = await window.electronAPI.voiceSetState({ accounts: this._accounts(), guildId: this.selectedGuild.guildId, ...state });
      const ok = (r.results || []).filter(x => x.ok).length;
      await this._refreshSessions();
      showNotification(ok ? `${t(state.key)} ${t('vm.applied')}` : t('vm.error'), ok ? 'success' : 'error');
    } catch(e) { showNotification(t('vm.error'), 'error'); }
  }

  addRotCh() {
    if (!this.selectedChannel) { showNotification(t('vm.select_channel_first'), 'error'); return; }
    if (this._rotChannels.find(c=>c.id===this.selectedChannel.id)) { showNotification(t('vm.already_added'), 'error'); return; }
    this._rotChannels.push({ ...this.selectedChannel, guildId: this.selectedGuild?.guildId });
    const list = this.contentArea.querySelector('#vm-rot-chs');
    if (list) list.innerHTML = this._rotChannels.length ? this._rotChannels.map((c,i) => `
      <div class="vm-rot-item">
        <span class="vm-rot-num">${i+1}</span>
        <span class="vm-rot-ch">${icon('volume')} ${this._esc(c.name)}</span>
        <button class="vm-rot-del" onclick="window.voiceManager.removeRotCh('${c.id}')">✕</button>
      </div>`).join('') : `<div class="vm-empty">${t('vm.no_rotation_channels')}</div>`;
  }

  removeRotCh(id) {
    this._rotChannels = this._rotChannels.filter(c=>c.id!==id);
    const list = this.contentArea.querySelector('#vm-rot-chs');
    if (list) list.innerHTML = this._rotChannels.length ? this._rotChannels.map((c,i) => `
      <div class="vm-rot-item">
        <span class="vm-rot-num">${i+1}</span>
        <span class="vm-rot-ch">${icon('volume')} ${this._esc(c.name)}</span>
        <button class="vm-rot-del" onclick="window.voiceManager.removeRotCh('${c.id}')">✕</button>
      </div>`).join('') : `<div class="vm-empty">${t('vm.no_rotation_channels')}</div>`;
  }

  async startRotation() {
    if (this._rotChannels.length < 2) { showNotification(t('vm.need_2_channels'), 'error'); return; }
    if (!this._needAccounts()) return;
    const guildId = this._rotChannels[0].guildId;
    const val  = parseInt(this.contentArea.querySelector('#vm-rot-val')?.value || '60');
    const unit = parseInt(this.contentArea.querySelector('#vm-rot-unit')?.value || '60000');
    const rand = this.contentArea.querySelector('#vm-rot-rand')?.checked || false;
    try {
      await window.electronAPI.voiceStartRotation({ accounts: this._accounts(), guildId, guildName: this.selectedGuild?.guildName || guildId, channelIds: this._rotChannels.map(c=>c.id), intervalMs: val*unit, randomOrder: rand });
      showNotification(t('vm.rotation_started'), 'success');
      this._rotChannels = [];
      await this._refreshSessions();
      await this._render('rotation', false);
    } catch(e) { showNotification(t('vm.error'), 'error'); }
  }

  async startCycle() {
    if (!this.selectedGuild) { showNotification(t('vm.select_server_first'), 'error'); return; }
    if (!this._needAccounts()) return;
    const checked = Array.from(this.contentArea.querySelectorAll('.vm-cyc-chk:checked')).map(el=>el.value);
    if (checked.length < 2) { showNotification(t('vm.need_2_states'), 'error'); return; }
    const states = checked.map(id=>STATES.find(s=>s.id===id)).filter(Boolean).map(s=>({ selfMute:s.selfMute, selfDeaf:s.selfDeaf, selfVideo:s.selfVideo, selfStream:s.selfStream }));
    const val  = parseInt(this.contentArea.querySelector('#vm-cyc-val')?.value || '60');
    const unit = parseInt(this.contentArea.querySelector('#vm-cyc-unit')?.value || '60000');
    try {
      await window.electronAPI.voiceStartStateCycle({ accounts: this._accounts(), guildId: this.selectedGuild.guildId, states, intervalMs: val*unit });
      showNotification(t('vm.cycle_started'), 'success');
      await this._refreshSessions();
      await this._render('cycle', false);
    } catch(e) { showNotification(t('vm.error'), 'error'); }
  }

  async stopTask(type, id) {
    try {
      if (type === 'rotation') await window.electronAPI.voiceStopRotation({ id });
      else await window.electronAPI.voiceStopStateCycle({ id });
      showNotification(t('vm.stopped'), 'success');
      await this._refreshSessions();
      await this._render(this._view, false);
    } catch(e) { showNotification(t('vm.error'), 'error'); }
  }

  async _quickLeave(name, guildId) {
    try {
      await window.electronAPI.voiceLeave({ accounts: [name], guildId });
      await this._refreshSessions();
      await this._render('sessions', false);
    } catch(e) {}
  }

  _esc(str) { return String(str||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }

  destroy() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}
