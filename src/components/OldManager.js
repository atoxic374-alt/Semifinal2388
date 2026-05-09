import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class OldManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.activeTab = 'people';
    this.serverList = [];
  }

  async init() {
    try {
      const r = await window.electronAPI.getServers();
      this.serverList = r.success ? r.servers : [];
    } catch (e) {
      this.serverList = [];
    }
    this.render();
  }

  render() {
    this.contentArea.innerHTML = `
      <div class="om-page">
        <div class="om-header">
          <div class="om-title-row">
            <span class="om-icon">${icon('clock_hist')}</span>
            <div>
              <h2 class="om-title">${t('om.title')}</h2>
              <p class="om-subtitle">${t('om.subtitle')}</p>
            </div>
          </div>
          <div class="om-tabs">
            <button class="om-tab ${this.activeTab === 'people' ? 'active' : ''}"
                    onclick="window.oldManager.switchTab('people')">
              ${icon('user')} ${t('om.tab.people')}
            </button>
            <button class="om-tab ${this.activeTab === 'servers' ? 'active' : ''}"
                    onclick="window.oldManager.switchTab('servers')">
              ${icon('home')} ${t('om.tab.servers')}
            </button>
          </div>
        </div>

        <div class="om-body">
          ${this.activeTab === 'people' ? this.renderPeopleTab() : this.renderServersTab()}
        </div>
      </div>
    `;
  }

  renderPeopleTab() {
    return `
      <div class="om-col">

        <div class="om-card">
          <div class="om-card-head">
            <span class="om-card-icon">${icon('search')}</span>
            <div>
              <div class="om-card-title">${t('om.find_user')}</div>
              <div class="om-card-desc">${t('om.find_user_desc')}</div>
            </div>
          </div>
          <div class="om-search-row">
            <input id="omUserInput" class="om-input" type="text"
                   placeholder="${t('om.user_placeholder')}"
                   onkeydown="if(event.key==='Enter') window.oldManager.searchUser()">
            <button class="om-btn" onclick="window.oldManager.searchUser()">${t('om.search')}</button>
          </div>
          <div id="omUserResult"></div>
        </div>

        <div class="om-divider"><span>${t('om.or')}</span></div>

        <div class="om-card">
          <div class="om-card-head">
            <span class="om-card-icon">${icon('clock')}</span>
            <div>
              <div class="om-card-title">${t('om.first_dm')}</div>
              <div class="om-card-desc">${t('om.first_dm_desc')}</div>
            </div>
          </div>
          <button class="om-btn success-btn" onclick="window.oldManager.findOldestDM()">
            ${t('om.find_first_dm')}
          </button>
          <div id="omOldestResult"></div>
        </div>

      </div>
    `;
  }

  renderServersTab() {
    const opts = this.serverList.map(s =>
      `<option value="${s.id}">${this.escHtml(s.name)}</option>`
    ).join('');

    return `
      <div class="om-col">

        <div class="om-card">
          <div class="om-card-head">
            <span class="om-card-icon">${icon('home')}</span>
            <div>
              <div class="om-card-title">${t('om.server_history')}</div>
              <div class="om-card-desc">${t('om.server_history_desc')}</div>
            </div>
          </div>

          <select class="om-select" id="omServerSelect">
            <option value="">${t('om.select_server')}</option>
            ${opts}
          </select>

          <div class="om-row">
            <button class="om-btn" onclick="window.oldManager.findMyFirstServerMsg()">
              ${icon('star')} ${t('om.my_first_msg')}
            </button>
            <button class="om-btn secondary-btn" onclick="window.oldManager.findServerFirstMsg()">
              ${icon('scroll')} ${t('om.server_first_msg')}
            </button>
          </div>

          <div id="omServerResult"></div>
        </div>

      </div>
    `;
  }

  switchTab(tab) {
    this.activeTab = tab;
    this.render();
  }

  // ── Search user ──────────────────────────────────
  async searchUser() {
    const input = document.getElementById('omUserInput');
    const q = input?.value?.trim();
    if (!q) return;
    const res = document.getElementById('omUserResult');
    res.innerHTML = this.loadingHTML(t('om.looking_user'));
    try {
      let data;
      if (/^\d{15,20}$/.test(q)) {
        data = await this.call(`/api/history/user/${q}`, 'user-id');
      } else {
        data = await this.call(`/api/history/user-search?q=${encodeURIComponent(q.replace('@', ''))}`, 'user-search');
      }
      if (!data.success) { res.innerHTML = this.errHTML(data.error); return; }
      res.innerHTML = this.userCardHTML(data.user);
    } catch (e) { res.innerHTML = this.errHTML(e.message); }
  }

  userCardHTML(u) {
    return `
      <div class="om-user-card">
        <img src="${u.avatar}" alt="" class="om-user-av" onerror="this.src='/discord.png'">
        <div class="om-user-info">
          <div class="om-user-name">${this.escHtml(u.displayName)}</div>
          <div class="om-user-tag">@${this.escHtml(u.username)}</div>
          <div class="om-user-id">ID: ${u.id}</div>
        </div>
        <button class="om-btn warning-btn"
                onclick="window.oldManager.findFirstMsgWith('${u.id}')">
          ${icon('message')} ${t('om.first_msg_with')}
        </button>
      </div>
      <div id="omUserMsgResult"></div>
    `;
  }

  // ── First message with specific user ─────────────
  async findFirstMsgWith(userId) {
    const res = document.getElementById('omUserMsgResult');
    if (!res) return;
    res.innerHTML = this.loadingHTML(t('om.scanning_dm'));
    try {
      const data = await this.call(`/api/history/dm-first-with/${userId}`, 'dm-first');
      res.innerHTML = data.success ? this.msgCardHTML(data.message) : this.errHTML(data.error);
    } catch (e) { res.innerHTML = this.errHTML(e.message); }
  }

  // ── Oldest DM ever ────────────────────────────────
  async findOldestDM() {
    const res = document.getElementById('omOldestResult');
    res.innerHTML = this.loadingHTML(t('om.scanning_all_dms'));
    try {
      const data = await this.call('/api/history/oldest-dm', 'oldest-dm');
      res.innerHTML = data.success ? this.msgCardHTML(data.message) : this.errHTML(data.error);
    } catch (e) { res.innerHTML = this.errHTML(e.message); }
  }

  // ── Server: my first message ──────────────────────
  async findMyFirstServerMsg() {
    const sid = document.getElementById('omServerSelect')?.value;
    if (!sid) { document.getElementById('omServerResult').innerHTML = this.errHTML(t('om.select_server_first')); return; }
    const res = document.getElementById('omServerResult');
    res.innerHTML = this.loadingHTML(t('om.scanning_server_my'));
    try {
      const data = await this.call(`/api/history/server-my-first/${sid}`, 'server-my-first');
      res.innerHTML = data.success ? this.msgCardHTML(data.message) : this.errHTML(data.error);
    } catch (e) { res.innerHTML = this.errHTML(e.message); }
  }

  // ── Server: first message ever ────────────────────
  async findServerFirstMsg() {
    const sid = document.getElementById('omServerSelect')?.value;
    if (!sid) { document.getElementById('omServerResult').innerHTML = this.errHTML(t('om.select_server_first')); return; }
    const res = document.getElementById('omServerResult');
    res.innerHTML = this.loadingHTML(t('om.scanning_server_first'));
    try {
      const data = await this.call(`/api/history/server-first/${sid}`, 'server-first');
      res.innerHTML = data.success ? this.msgCardHTML(data.message) : this.errHTML(data.error);
    } catch (e) { res.innerHTML = this.errHTML(e.message); }
  }

  // ── Render helpers ────────────────────────────────
  msgCardHTML(msg) {
    const d = new Date(msg.timestamp);
    const dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const where = msg.guild
      ? `${icon('pin')} <strong>#${this.escHtml(msg.channel?.name || t('om.unknown_channel'))}</strong> in ${this.escHtml(msg.guild.name)}`
      : `${icon('pin')} ${this.escHtml(msg.channel?.name || t('om.dm'))}`;

    const guildPart = msg.guild?.id ? msg.guild.id : '@me';
    const link = msg.channel?.id && msg.id
      ? `https://discord.com/channels/${guildPart}/${msg.channel.id}/${msg.id}`
      : '';

    return `
      <div class="om-msg-card">
        <div class="om-msg-top">
          <img src="${msg.author.avatar}" alt="" class="om-msg-av" onerror="this.src='/discord.png'">
          <div class="om-msg-author">
            <span class="om-msg-display">${this.escHtml(msg.author.displayName)}</span>
            <span class="om-msg-tag">@${this.escHtml(msg.author.username)}</span>
          </div>
          <span class="om-msg-time">${icon('calendar')} ${dateStr} · ${timeStr}</span>
        </div>
        <div class="om-msg-bubble">${this.escHtml(msg.content)}</div>
        <div class="om-msg-footer">
          <span>${where}</span>
          ${link ? `<button class="om-copy-link-btn" onclick="window.copyMessageLink(this, '${link}')" title="${t('common.copy_link')}">
            ${icon('copy')}
            <span class="om-copy-link-text">${t('common.copy_link')}</span>
          </button>` : ''}
        </div>
      </div>
    `;
  }

  loadingHTML(text) {
    return `<div class="om-loading"><div class="om-spinner"></div><span>${text}</span></div>`;
  }

  errHTML(msg) {
    return `<div class="om-error">${icon('x_circle')} ${this.escHtml(msg)}</div>`;
  }

  // ── API call with test mode ───────────────────────
  async call(url, mockKey) {
    if (window._testMode) return this.mockData(mockKey);
    const r = await fetch(url);
    return r.json();
  }

  mockData(key) {
    const mockMsg = (content, channelName, guildName) => ({
      success: true,
      message: {
        id: '987654321098765432',
        content,
        timestamp: new Date('2020-03-15T14:32:00Z').getTime(),
        author: { id: '1', username: 'testuser', displayName: 'Test User', avatar: '/discord.png' },
        channel: { id: '1', name: channelName },
        guild: guildName ? { id: '2', name: guildName } : null
      }
    });
    const mockUser = { success: true, user: { id: '123456789012345678', username: 'testfriend', displayName: 'Test Friend', avatar: '/discord.png' } };

    if (key === 'user-id' || key === 'user-search') return Promise.resolve(mockUser);
    if (key === 'dm-first') return Promise.resolve(mockMsg('Hey! This is our very first message', 'DM with @testfriend', null));
    if (key === 'oldest-dm') return Promise.resolve(mockMsg("Yo what's up, first ever DM!", 'DM with @oldfriend', null));
    if (key === 'server-my-first') return Promise.resolve(mockMsg('Hello everyone! Great to be here.', 'general', 'Test Server'));
    if (key === 'server-first') return Promise.resolve(mockMsg('Welcome to the server!', 'welcome', 'Test Server'));
    return Promise.resolve({ success: false, error: 'Not available in test mode' });
  }

  escHtml(t) {
    if (!t) return '';
    return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}
