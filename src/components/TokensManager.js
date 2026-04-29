// Tokens Manager — multi-account control center
import { showNotification } from '../utils/ui.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class TokensManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.tokens = [];
    this.clients = [];
    this.activeTab = 'accounts'; // accounts | presence | bio | avatar | rotate | activity
    this.selected = [];

    this.pStatus = 'online';
    this.pCustom = '';
    this.pEmoji  = '';
    // Activity type: 0=playing, 1=streaming, 2=listening, 3=watching, 5=competing, -1=none
    this.pActivityType = -1;
    this.pActivityName = '';
    this.pActivityUrl  = ''; // for streaming
    this.bioText = '';
    this.currentBio = '';
    this.avatarDataUrl = '';
    this.avatarFileName = '';
    this.bannerDataUrl = '';
    this.bannerFileName = '';

    this.rotInterval = 120;
    this.rotStates = [{ status: 'online', customStatus: '', emoji: '' }];

    this.actMin = 60;
    this.actMax = 600;
    this.actModes = { online: true, idle: true, invisible: true, dnd: false };
    this.actRunning = [];
  }

  async init() {
    await this.refresh();
    this.render();
  }

  async refresh() {
    try {
      const [tk, cl, ac] = await Promise.all([
        window.electronAPI.getTokens(),
        window.electronAPI.listClients(),
        window.electronAPI.listActivity ? window.electronAPI.listActivity() : Promise.resolve({ success: true, running: [] })
      ]);
      this.tokens = tk.success ? tk.tokens : [];
      this.clients = cl.success ? cl.clients : [];
      this.actRunning = ac.success ? (ac.running || []) : [];
    } catch (e) { /* ignore */ }
  }

  render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header glass">
          <div class="mm-title-row">
            <span class="mm-icon pulse">${icon('key')}</span>
            <div>
              <h2 class="mm-title">${t('tk.title')}</h2>
              <p class="mm-subtitle">${t('tk.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            ${this.tabBtn('accounts', 'key',         t('tk.tab.accounts'))}
            ${this.tabBtn('presence', 'status_dot',  t('tk.tab.presence'))}
            ${this.tabBtn('bio',      'file_text',   t('tk.tab.bio'))}
            ${this.tabBtn('avatar',   'image',       t('tk.tab.avatar'))}
            ${this.tabBtn('rotate',   'refresh',     t('tk.tab.rotate'))}
            ${this.tabBtn('activity', 'brain',       t('tk.tab.activity'))}
          </div>
        </div>
        <div class="mm-body fade-in">
          ${this.renderTab()}
        </div>
      </div>
    `;
  }

  tabBtn(id, ic, label) {
    return `<button class="mm-tab ${this.activeTab === id ? 'active' : ''}" onclick="window.tokensManager.switchTab('${id}')">${icon(ic)} ${label}</button>`;
  }
  switchTab(tab) {
    this.activeTab = tab;
    this.render();
    if (tab === 'bio') this.fetchCurrentBio();
  }

  renderTab() {
    switch (this.activeTab) {
      case 'accounts': return this.renderAccounts();
      case 'presence': return this.renderPresence();
      case 'bio':      return this.renderBio();
      case 'avatar':   return this.renderAvatar();
      case 'rotate':   return this.renderRotate();
      case 'activity': return this.renderActivity();
    }
    return '';
  }

  // ─── Accounts tab
  renderAccounts() {
    return `
      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('plus')}</span><div><div class="mm-card-title">${t('tk.add_token')}</div><div class="mm-card-desc">${t('tk.add_desc')}</div></div></div>
        <div class="mm-row-fields">
          <input id="tk-name"  placeholder="${t('tk.account_name')}">
          <input id="tk-token" placeholder="${t('tk.discord_token')}" type="password">
          <input id="tk-proxy" placeholder="Proxy (optional) — http://user:pass@host:port or socks5://…">
          <label class="mm-toggle"><input type="checkbox" id="tk-auto"> ${t('tk.auto_connect')}</label>
          <button class="mm-btn primary glow" onclick="window.tokensManager.addToken()">${t('tk.save')}</button>
        </div>
      </div>

      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head">
          <span class="mm-card-icon">${icon('archive')}</span>
          <div><div class="mm-card-title">${t('tk.saved_connected')}</div><div class="mm-card-desc">${t('tk.saved_desc')}</div></div>
        </div>
        <div class="tk-list">${this.renderTokenList()}</div>
      </div>
    `;
  }

  renderTokenList() {
    const allNames = new Set([...this.tokens.map(x => x.name), ...this.clients.map(c => c.name)]);
    if (!allNames.size) return `<div class="mm-info-row mm-muted">${t('tk.no_accounts')}</div>`;
    return Array.from(allNames).map(name => {
      const saved = this.tokens.find(x => x.name === name);
      const conn  = this.clients.find(c => c.name === name);
      const isActive = !!conn?.active;
      const display = conn?.displayName || conn?.username || name;
      const handle  = conn?.username || (saved ? t('tk.saved') : t('tk.no_token'));
      const showHandle = handle && handle !== display;
      return `
        <div class="tk-item ${isActive ? 'active' : ''} pop">
          <img src="${conn?.avatar || '/discord.png'}" onerror="this.src='/discord.png'" class="tk-av">
          <div class="tk-info">
            <div class="tk-name-row">
              <strong>${this.escHtml(display)}</strong>
              <span class="tk-alias mm-muted">(${this.escHtml(name)})</span>
              ${conn ? `<span class="tk-pill ok">${t('tk.connected')}</span>` : ''}
              ${saved?.autoConnect ? `<span class="tk-pill auto">${t('tk.auto')}</span>` : ''}
              ${isActive ? `<span class="tk-pill act">${t('tk.active')}</span>` : ''}
              ${this.actRunning.includes(name) ? `<span class="tk-pill sim">${t('tk.simulator')}</span>` : ''}
              ${saved?.hasProxy ? `<span class="tk-pill proxy" title="${this.escHtml(saved.proxy || '')}">PROXY</span>` : ''}
            </div>
            <div class="tk-tag">${showHandle ? `@${this.escHtml(handle)}` : this.escHtml(handle)}</div>
            <div class="tk-status">${this.dotFor(conn?.status)}</div>
          </div>
          <div class="tk-actions">
            ${conn ? '' : `<button class="mm-btn primary small" onclick="window.tokensManager.connectSaved('${this.esc(name)}')">${t('tk.connect')}</button>`}
            ${conn && !isActive ? `<button class="mm-btn ghost small" onclick="window.tokensManager.makeActive('${this.esc(name)}')">${t('tk.make_active')}</button>` : ''}
            ${conn ? `<button class="mm-btn warning small" onclick="window.tokensManager.disconnectSaved('${this.esc(name)}')">${t('tk.dc')}</button>` : ''}
            ${saved ? `<button class="mm-btn ghost small" onclick="window.tokensManager.editProxy('${this.esc(name)}')">${saved.hasProxy ? 'Proxy ✓' : 'Proxy'}</button>` : ''}
            ${saved ? `<button class="mm-btn ghost small" onclick="window.tokensManager.toggleAuto('${this.esc(name)}', ${!saved.autoConnect})">${saved.autoConnect ? t('tk.disable_auto') : t('tk.enable_auto')}</button>` : ''}
            ${saved ? `<button class="mm-btn danger small" onclick="window.tokensManager.deleteToken('${this.esc(name)}')">${t('tk.delete')}</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  dotFor(status) {
    const colors = { online: '#27ae60', idle: '#e0a335', dnd: '#e03535', invisible: '#777', offline: '#777' };
    if (!status) return '';
    return `<span class="tk-dot" style="background:${colors[status] || '#777'}"></span><span class="tk-status-text">${status}</span>`;
  }

  async addToken() {
    const name = document.getElementById('tk-name').value.trim();
    const token = document.getElementById('tk-token').value.trim();
    const proxy = document.getElementById('tk-proxy')?.value.trim() || null;
    const auto = document.getElementById('tk-auto').checked;
    if (!name || !token) return showNotification('Name and token required');
    const r = await window.electronAPI.saveToken(name, token, auto, proxy);
    if (!r.success) return showNotification(r.error);
    showNotification('Saved' + (proxy ? ' (with proxy)' : ''));
    document.getElementById('tk-name').value = '';
    document.getElementById('tk-token').value = '';
    if (document.getElementById('tk-proxy')) document.getElementById('tk-proxy').value = '';
    document.getElementById('tk-auto').checked = false;
    if (auto) {
      const c = await window.electronAPI.connectSaved(name);
      if (c.success) showNotification(`Connected: ${name}`);
      else showNotification(`Connect failed: ${c.error || ''}`);
    }
    await this.refresh(); this.render();
  }

  // ── Proxy edit/test modal (lightweight, no extra dependencies)
  async editProxy(name) {
    const saved = this.tokens.find(x => x.name === name);
    const current = saved?.proxy || '';
    const placeholder = 'http://user:pass@host:port  or  socks5://host:port  (leave empty to remove)';
    const input = window.prompt(
      `Proxy for "${name}"\n(http / https / socks5 supported, with optional credentials)\n\nCurrent: ${current || '(none)'}\n\nLeave empty to remove the proxy.`,
      ''
    );
    // user hit Cancel
    if (input === null) return;
    const next = input.trim();
    if (next) {
      showNotification('Testing proxy…');
      const tr = await window.electronAPI.testProxy(name, next);
      if (!tr.success) return showNotification('Proxy test failed: ' + (tr.error || 'unknown'));
      showNotification('Proxy OK — egress IP: ' + (tr.ip || 'unknown'));
    }
    const r = await window.electronAPI.setProxy(name, next);
    if (!r.success) return showNotification('Save failed: ' + (r.error || 'unknown'));
    showNotification(next ? 'Proxy saved. Reconnect to apply.' : 'Proxy removed.');
    await this.refresh(); this.render();
  }

  async connectSaved(name) {
    showNotification(`Connecting ${name}…`);
    const r = await window.electronAPI.connectSaved(name);
    if (r.success) showNotification(`${t('common.ok')}: ${name}`);
    else showNotification(`${t('mm.failed')}: ${r.error}`);
    await this.refresh(); this.render();
  }
  async disconnectSaved(name) {
    await window.electronAPI.disconnectSaved(name);
    await this.refresh(); this.render();
  }
  async makeActive(name) {
    await window.electronAPI.setActiveClient(name);
    showNotification(`${t('tk.active')}: ${name}`);
    await this.refresh(); this.render();
    window.dispatchEvent(new CustomEvent('active-client-changed'));
  }
  async toggleAuto(name, val) {
    await window.electronAPI.updateToken(name, { autoConnect: val });
    await this.refresh(); this.render();
  }
  async deleteToken(name) {
    await window.electronAPI.deleteToken(name);
    await this.refresh(); this.render();
  }

  // ─── Token chips (selection) shared
  renderTokenChips() {
    if (!this.clients.length) return `<div class="mm-info-row mm-muted">${t('tk.no_accounts')}</div>`;
    return `
      <div class="mm-token-grid">
        ${this.clients.map(c => {
          const display = c.displayName || c.username || c.name;
          const handle  = c.username || '';
          return `
          <label class="mm-token-chip ${this.selected.includes(c.name) ? 'on' : ''}">
            <input type="checkbox" ${this.selected.includes(c.name) ? 'checked' : ''} onchange="window.tokensManager.toggleSelected('${this.esc(c.name)}', this.checked)">
            <img src="${c.avatar || '/discord.png'}" onerror="this.src='/discord.png'">
            <div><strong>${this.escHtml(display)}</strong><span>${handle && handle !== display ? '@' + this.escHtml(handle) : this.escHtml(c.name)}</span></div>
          </label>`;
        }).join('')}
      </div>
      <div class="mm-token-actions">
        <button class="mm-btn ghost small" onclick="window.tokensManager.selectAll(true)">${t('tk.select_all')}</button>
        <button class="mm-btn ghost small" onclick="window.tokensManager.selectAll(false)">${t('tk.clear_sel')}</button>
      </div>
    `;
  }
  toggleSelected(n, on) { if (on && !this.selected.includes(n)) this.selected.push(n); else if (!on) this.selected = this.selected.filter(x => x !== n); }
  selectAll(all) { this.selected = all ? this.clients.map(c => c.name) : []; this.render(); }
  _allConnectedNames() { return this.clients.map(c => c.name); }
  _resolveTargets(all = false) {
    const tokens = all ? this._allConnectedNames() : this.selected;
    if (!tokens.length) {
      showNotification(t('tk.no_accounts'));
      return null;
    }
    return tokens;
  }

  // ─── Presence tab
  renderPresence() {
    return `
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('tk.apply_to')}</div><div class="mm-card-desc">${t('tk.apply_to_desc')}</div></div></div>
        ${this.renderTokenChips()}
      </div>

      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('status_dot')}</span><div><div class="mm-card-title">${t('tk.online_status')}</div><div class="mm-card-desc">${t('tk.online_desc')}</div></div></div>
        <div class="mm-radio-group">
          ${['online','idle','dnd','invisible'].map(s => `
            <label class="mm-radio ${this.pStatus === s ? 'active' : ''}">
              <input type="radio" name="tk-pstatus" value="${s}" ${this.pStatus === s ? 'checked' : ''} onchange="window.tokensManager.pStatus='${s}'">
              <div><strong>${s.toUpperCase()}</strong><span>${this.statusDesc(s)}</span></div>
            </label>`).join('')}
        </div>
      </div>

      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('message')}</span><div><div class="mm-card-title">${t('tk.custom_status')}</div><div class="mm-card-desc">${t('tk.custom_desc')}</div></div></div>
        <div class="mm-row-fields">
          <input placeholder="${t('tk.emoji')}" value="${this.escHtml(this.pEmoji)}" oninput="window.tokensManager.pEmoji=this.value">
          <input placeholder="${t('tk.status_text')}" value="${this.escHtml(this.pCustom)}" oninput="window.tokensManager.pCustom=this.value">
        </div>
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.applyPresence()">${t('tk.apply')}</button>
          <button class="mm-btn ghost"   onclick="window.tokensManager.clearCustom()">${t('tk.clear_custom')}</button>
          <button class="mm-btn success"  onclick="window.tokensManager.applyPresence(true)">${t('tk.apply_all')}</button>
        </div>
      </div>

      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('rocket')}</span><div><div class="mm-card-title">${t('tk.activity_type_title')}</div><div class="mm-card-desc">${t('tk.activity_type_desc')}</div></div></div>
        <div class="mm-row-fields">
          <select id="tk-act-type" onchange="window.tokensManager.onActivityTypeChange(this.value)">
            <option value="-1" ${this.pActivityType === -1 ? 'selected' : ''}>${t('tk.act_none')}</option>
            <option value="0"  ${this.pActivityType === 0  ? 'selected' : ''}>${t('tk.act_playing')}</option>
            <option value="1"  ${this.pActivityType === 1  ? 'selected' : ''}>${t('tk.act_streaming')}</option>
            <option value="2"  ${this.pActivityType === 2  ? 'selected' : ''}>${t('tk.act_listening')}</option>
            <option value="3"  ${this.pActivityType === 3  ? 'selected' : ''}>${t('tk.act_watching')}</option>
            <option value="5"  ${this.pActivityType === 5  ? 'selected' : ''}>${t('tk.act_competing')}</option>
          </select>
          <input id="tk-act-name" placeholder="${t('tk.act_name_ph')}" value="${this.escHtml(this.pActivityName)}" oninput="window.tokensManager.pActivityName=this.value">
          ${this.pActivityType === 1
            ? `<input id="tk-act-url" placeholder="https://twitch.tv/..." value="${this.escHtml(this.pActivityUrl)}" oninput="window.tokensManager.pActivityUrl=this.value">`
            : ''}
        </div>
        ${this.activityRiskHtml()}
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.applyActivity()">${t('tk.apply_activity')}</button>
          <button class="mm-btn ghost" onclick="window.tokensManager.clearActivity()">${t('tk.clear_activity')}</button>
          <button class="mm-btn success" onclick="window.tokensManager.applyActivity(true)">${t('tk.apply_all')}</button>
        </div>
      </div>
    `;
  }

  onActivityTypeChange(v) {
    this.pActivityType = parseInt(v);
    if (this.pActivityType !== 1) this.pActivityUrl = '';
    this.render();
  }

  activityRiskHtml() {
    // Risk levels per type
    const riskByType = {
      '-1': { lvl: 'safe', key: 'tk.risk.none' },
       '0': { lvl: 'low',  key: 'tk.risk.playing' },
       '1': { lvl: 'high', key: 'tk.risk.streaming' },
       '2': { lvl: 'low',  key: 'tk.risk.listening' },
       '3': { lvl: 'low',  key: 'tk.risk.watching' },
       '5': { lvl: 'med',  key: 'tk.risk.competing' }
    };
    const r = riskByType[String(this.pActivityType)];
    if (!r) return '';
    return `<div class="tk-risk tk-risk-${r.lvl}">
      <span class="tk-risk-dot"></span>
      <strong>${t('tk.risk.label.' + r.lvl)}</strong>
      <span>${t(r.key)}</span>
    </div>`;
  }

  async applyActivity(all = false) {
    if (this.pActivityType === -1) {
      // Clear by setting empty activity
      const tokens = all ? this._allConnectedNames() : this.selected;
      const r = await window.electronAPI.setPresence({ tokens, status: this.pStatus, customStatus: this.pCustom, emoji: this.pEmoji || undefined });
      const ok = (r.results || []).filter(x => x.ok).length;
      const fail = (r.results || []).length - ok;
      showNotification(`${t('tk.apply')} ${t('common.ok')} ${ok}  ${t('common.fail')} ${fail}`);
      return;
    }
    const name = String(this.pActivityName || '').trim();
    if (!name) return showNotification(t('tk.act_need_name'));
    const tokens = all ? this._allConnectedNames() : this.selected;
    const activity = { name, type: this.pActivityType };
    if (this.pActivityType === 1 && this.pActivityUrl) activity.url = this.pActivityUrl;
    const r = await window.electronAPI.setPresence({ tokens, status: this.pStatus, activity });
    const ok = (r.results || []).filter(x => x.ok).length;
    const fail = (r.results || []).length - ok;
    showNotification(`${t('tk.apply_activity')} ${t('common.ok')} ${ok}  ${t('common.fail')} ${fail}`);
  }

  async clearActivity() {
    this.pActivityType = -1;
    this.pActivityName = '';
    this.pActivityUrl  = '';
    const tokens = this.selected.length ? this.selected : this._allConnectedNames();
    await window.electronAPI.setPresence({ tokens, status: this.pStatus, customStatus: this.pCustom || '', emoji: this.pEmoji || undefined });
    this.render();
  }

  statusDesc(s) {
    return t('tk.status.' + s) || '';
  }

  async applyPresence(all = false) {
    try {
      const tokens = all ? this._allConnectedNames() : this.selected;
      if (!tokens.length) return showNotification(t('tk.no_accounts'));
      const r = await window.electronAPI.setPresence({
        tokens,
        status: this.pStatus,
        customStatus: this.pCustom,
        emoji: this.pEmoji || undefined
      });
      const s = r.summary || {};
      const ok = s.ok ?? (r.results || []).filter(x => x.ok).length;
      const fail = s.failed ?? ((r.results || []).length - ok);
      showNotification(`${t('tk.apply')} ${t('common.ok')} ${ok}  ${t('common.fail')} ${fail}${fail ? ' ⚠' : ''}`);
    } catch (e) { showNotification(`${t('mm.failed')}: ${e.message}`); }
  }
  async clearCustom() { this.pCustom = ''; this.pEmoji = ''; await this.applyPresence(); }

  // ─── Bio tab
  renderBio() {
    return `
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('tk.apply_to')}</div><div class="mm-card-desc">${t('tk.apply_to_desc')}</div></div></div>
        ${this.renderTokenChips()}
      </div>
      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('file_text')}</span><div><div class="mm-card-title">${t('tk.profile_bio')}</div><div class="mm-card-desc">${t('tk.profile_bio_desc')}</div></div></div>
        <div class="mm-field">
          <textarea rows="6" placeholder="${t('tk.your_bio')}" oninput="window.tokensManager.bioText=this.value">${this.escHtml(this.bioText)}</textarea>
        </div>
        <div class="mm-info-row"><strong>Current bio:</strong> <span>${this.escHtml(this.currentBio || '—')}</span></div>
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.applyBio()">${t('tk.apply_bio')}</button>
          <button class="mm-btn success" onclick="window.tokensManager.applyBio(true)">${t('tk.apply_all')}</button>
          <button class="mm-btn ghost" onclick="window.tokensManager.fetchCurrentBio()">${icon('refresh')} Refresh current</button>
        </div>
      </div>
    `;
  }
  async applyBio(all = false) {
    const tokens = this._resolveTargets(all); if (!tokens) return;
    const r = await window.electronAPI.setBio({ tokens, bio: this.bioText });
    const ok = (r.results || []).filter(x => x.ok).length;
    const fail = (r.results || []).length - ok;
    showNotification(`${t('tk.profile_bio')} ${t('common.ok')} ${ok}  ${t('common.fail')} ${fail}`);
    if (ok > 0) await this.fetchCurrentBio(tokens[0]);
  }
  async fetchCurrentBio(tokenName = null) {
    try {
      const tok = tokenName || this.selected[0] || this._allConnectedNames()[0];
      if (!tok) return;
      const r = await window.electronAPI.getProfile({ token: tok });
      if (r?.success && r.profile) {
        this.currentBio = r.profile.bio || '';
        this.render();
      }
    } catch (_) {}
  }

  // ─── Avatar tab (avatar + banner)
  renderAvatar() {
    return `
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('tk.apply_to')}</div><div class="mm-card-desc">${t('tk.apply_to_desc')}</div></div></div>
        ${this.renderTokenChips()}
      </div>
      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('image')}</span><div><div class="mm-card-title">${t('tk.profile_avatar')}</div><div class="mm-card-desc">${t('tk.profile_avatar_desc')}</div></div></div>
        <div class="tk-avatar-pick">
          <div class="tk-avatar-preview">
            <img id="tk-av-img" src="${this.avatarDataUrl || '/discord.png'}" onerror="this.src='/discord.png'">
          </div>
          <div class="tk-avatar-controls">
            <input type="file" id="tk-av-file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onchange="window.tokensManager.onPickAvatar(event)">
            <button class="mm-btn ghost" onclick="document.getElementById('tk-av-file').click()">${icon('folder')} ${t('tk.choose_image')}</button>
            <span class="tk-av-name">${this.escHtml(this.avatarFileName || '—')}</span>
          </div>
        </div>
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.applyAvatar()">${t('tk.apply_avatar')}</button>
          <button class="mm-btn success" onclick="window.tokensManager.applyAvatar(true)">${t('tk.apply_all')}</button>
        </div>
      </div>

      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('image')}</span><div><div class="mm-card-title">${t('tk.profile_banner')}</div><div class="mm-card-desc">${t('tk.profile_banner_desc')}</div></div></div>
        <div class="tk-banner-pick">
          <div class="tk-banner-preview">
            ${this.bannerDataUrl
              ? `<img id="tk-bn-img" src="${this.bannerDataUrl}">`
              : `<div class="tk-banner-empty">${t('tk.banner_empty')}</div>`}
          </div>
          <div class="tk-avatar-controls">
            <input type="file" id="tk-bn-file" accept="image/png,image/jpeg,image/gif" hidden onchange="window.tokensManager.onPickBanner(event)">
            <button class="mm-btn ghost" onclick="document.getElementById('tk-bn-file').click()">${icon('folder')} ${t('tk.choose_image')}</button>
            <span class="tk-av-name">${this.escHtml(this.bannerFileName || '—')}</span>
          </div>
        </div>
        <div class="tk-banner-hint mm-info-row">
          ${icon('shield')} <span>${t('tk.banner_warn')}</span>
        </div>
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.applyBanner()">${t('tk.apply_banner')}</button>
          <button class="mm-btn ghost"   onclick="window.tokensManager.removeBanner()">${t('tk.remove_banner')}</button>
          <button class="mm-btn success"  onclick="window.tokensManager.applyBanner(true)">${t('tk.apply_all')}</button>
        </div>
      </div>
    `;
  }
  onPickAvatar(ev) {
    const file = ev.target.files?.[0]; if (!file) return;
    if (file.size > 8 * 1024 * 1024) return showNotification(t('tk.image_too_large'));
    const r = new FileReader();
    r.onload = () => {
      this.avatarDataUrl = r.result;
      this.avatarFileName = file.name;
      const img = document.getElementById('tk-av-img');
      if (img) img.src = r.result;
      const span = document.querySelector('.tk-av-name');
      if (span) span.textContent = file.name;
    };
    r.readAsDataURL(file);
  }
  onPickBanner(ev) {
    const file = ev.target.files?.[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) return showNotification(t('tk.image_too_large'));
    const r = new FileReader();
    r.onload = () => {
      this.bannerDataUrl = r.result;
      this.bannerFileName = file.name;
      this.render();
    };
    r.readAsDataURL(file);
  }
  async applyAvatar(all = false) {
    if (!this.avatarDataUrl) return showNotification(t('tk.choose_first'));
    const tokens = this._resolveTargets(all); if (!tokens) return;
    const r = await window.electronAPI.setAvatar({ tokens, avatar: this.avatarDataUrl });
    const ok = (r.results || []).filter(x => x.ok).length;
    const fail = (r.results || []).length - ok;
    showNotification(`${t('tk.profile_avatar')} ${t('common.ok')} ${ok}  ${t('common.fail')} ${fail}`);
  }
  async applyBanner(all = false) {
    if (!this.bannerDataUrl) return showNotification(t('tk.choose_first'));
    const tokens = this._resolveTargets(all); if (!tokens) return;
    const r = await window.electronAPI.setBanner({ tokens, banner: this.bannerDataUrl });
    const ok = (r.results || []).filter(x => x.ok).length;
    const failed = (r.results || []).filter(x => !x.ok);
    if (failed.length) {
      const sample = failed[0].error || '';
      showNotification(`${t('tk.profile_banner')}: ${ok} ${t('common.ok')} · ${failed.length} ${t('common.fail')}${sample ? ' — ' + sample : ''}`);
    } else {
      showNotification(`${t('tk.profile_banner')} ${t('common.ok')} ${ok}`);
    }
  }
  async removeBanner() {
    const tokens = this.selected.length ? this.selected : this._allConnectedNames();
    const r = await window.electronAPI.setBanner({ tokens, banner: null });
    const ok = (r.results || []).filter(x => x.ok).length;
    showNotification(`${t('tk.remove_banner')} ${t('common.ok')} ${ok}`);
    this.bannerDataUrl = '';
    this.bannerFileName = '';
    this.render();
  }

  // ─── Rotate tab
  renderRotate() {
    return `
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('tk.apply_to')}</div><div class="mm-card-desc">${t('tk.apply_to_desc')}</div></div></div>
        ${this.renderTokenChips()}
      </div>
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('clock')}</span><div><div class="mm-card-title">${t('tk.interval')}</div><div class="mm-card-desc">${t('tk.interval_desc')}</div></div></div>
        <div class="mm-field"><input type="number" min="15" value="${this.rotInterval}" oninput="window.tokensManager.rotInterval=parseInt(this.value||'15')"></div>
      </div>
      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('clap')}</span><div><div class="mm-card-title">${t('tk.status_seq')}</div><div class="mm-card-desc">${t('tk.status_seq_desc')}</div></div></div>
        <div id="tk-rot-states">${this.renderRotStates()}</div>
        <button class="mm-btn ghost mm-add-msg" onclick="window.tokensManager.addRotState()">${icon('plus')} ${t('tk.add_status')}</button>
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.startRotate()">${icon('play')} ${t('tk.start_rotation')}</button>
          <button class="mm-btn danger"  onclick="window.tokensManager.stopRotate()">${icon('stop')} ${t('tk.stop_rotation')}</button>
          <button class="mm-btn success" onclick="window.tokensManager.startRotate(true)">${t('tk.apply_all')}</button>
        </div>
      </div>
    `;
  }
  renderRotStates() {
    return this.rotStates.map((s, i) => `
      <div class="mm-msg-panel">
        <div class="mm-msg-head">
          <span>${t('tk.state')} #${i + 1}</span>
          ${this.rotStates.length > 1 ? `<button class="mm-x" onclick="window.tokensManager.removeRotState(${i})">${icon('x')}</button>` : ''}
        </div>
        <div class="mm-row-fields">
          <select onchange="window.tokensManager.rotStates[${i}].status=this.value">
            ${['online','idle','dnd','invisible'].map(x => `<option value="${x}" ${s.status === x ? 'selected' : ''}>${x}</option>`).join('')}
          </select>
          <input placeholder="${t('tk.emoji')}" value="${this.escHtml(s.emoji)}" oninput="window.tokensManager.rotStates[${i}].emoji=this.value">
          <input placeholder="${t('tk.status_text')}" value="${this.escHtml(s.customStatus)}" oninput="window.tokensManager.rotStates[${i}].customStatus=this.value">
        </div>
      </div>
    `).join('');
  }
  addRotState() { this.rotStates.push({ status: 'online', customStatus: '', emoji: '' }); document.getElementById('tk-rot-states').innerHTML = this.renderRotStates(); }
  removeRotState(i) { this.rotStates.splice(i, 1); document.getElementById('tk-rot-states').innerHTML = this.renderRotStates(); }

  async startRotate(all = false) {
    const states = this.rotStates.filter(s => s.status || s.customStatus || s.emoji);
    if (!states.length) return showNotification('Add at least one state');
    const tokens = this._resolveTargets(all); if (!tokens) return;
    const r = await window.electronAPI.startRotation({ tokens, states, intervalMs: this.rotInterval * 1000 });
    if (r.success) showNotification(`${t('tk.start_rotation')}: ${(r.rotating || []).length} • ${r.states || states.length} states • ${Math.round((r.intervalMs || this.rotInterval * 1000) / 1000)}s`);
    else showNotification(`${t('mm.failed')}: ${r.error}`);
  }
  async stopRotate() {
    const r = await window.electronAPI.stopRotation({ tokens: this.selected });
    showNotification(`${t('tk.stop_rotation')}: ${r.count || (r.stopped || []).length}`);
  }

  // ─── Activity Simulator tab
  renderActivity() {
    return `
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('tk.apply_to')}</div><div class="mm-card-desc">${t('tk.apply_to_desc')}</div></div></div>
        ${this.renderTokenChips()}
      </div>
      <div class="mm-card lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('clock')}</span><div><div class="mm-card-title">${t('tk.activity_min')} / ${t('tk.activity_max')}</div><div class="mm-card-desc">${t('tk.activity_desc')}</div></div></div>
        <div class="mm-row-fields">
          <input type="number" min="15" value="${this.actMin}" oninput="window.tokensManager.actMin=parseInt(this.value||'60')" placeholder="${t('tk.activity_min')}">
          <input type="number" min="30" value="${this.actMax}" oninput="window.tokensManager.actMax=parseInt(this.value||'600')" placeholder="${t('tk.activity_max')}">
        </div>
      </div>
      <div class="mm-card mm-span-2 lift">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('brain')}</span><div><div class="mm-card-title">${t('tk.activity_title')}</div><div class="mm-card-desc">${t('tk.activity_modes')}</div></div></div>
        <div class="mm-radio-group" style="margin-top:8px">
          ${['online','idle','invisible','dnd'].map(m => `
            <label class="mm-radio ${this.actModes[m] ? 'active' : ''}">
              <input type="checkbox" ${this.actModes[m] ? 'checked' : ''} onchange="window.tokensManager.actModes['${m}']=this.checked; this.parentElement.classList.toggle('active', this.checked)">
              <div><strong>${m.toUpperCase()}</strong><span>${this.statusDesc(m)}</span></div>
            </label>`).join('')}
        </div>
        <div class="mm-actions-row">
          <button class="mm-btn primary glow" onclick="window.tokensManager.startActivity()">${icon('play')} ${t('tk.start_activity')}</button>
          <button class="mm-btn danger" onclick="window.tokensManager.stopActivity()">${icon('stop')} ${t('tk.stop_activity')}</button>
          <button class="mm-btn success" onclick="window.tokensManager.startActivity(true)">${t('tk.apply_all')}</button>
        </div>
        ${this.actRunning.length ? `<div class="mm-info-row" style="margin-top:14px"><strong>${t('tk.simulating')}:</strong> ${this.actRunning.map(n => `<span class="tk-pill sim">${this.escHtml(n)}</span>`).join(' ')}</div>` : ''}
      </div>
    `;
  }
  async startActivity(all = false) {
    const tokens = this._resolveTargets(all); if (!tokens) return;
    const modes = Object.keys(this.actModes).filter(k => this.actModes[k]);
    if (!modes.length) return showNotification('Pick at least one mode');
    const r = await window.electronAPI.startActivity({ tokens, modes, minSec: this.actMin, maxSec: this.actMax });
    if (r.success) {
      showNotification(`${t('tk.start_activity')}: ${(r.simulating || []).length}`);
      this.actRunning = r.simulating || [];
      this.render();
    } else showNotification(`${t('mm.failed')}: ${r.error}`);
  }
  async stopActivity() {
    await window.electronAPI.stopActivity({ tokens: this.selected });
    showNotification(t('tk.stop_activity'));
    await this.refresh(); this.render();
  }

  esc(s) { return String(s).replace(/'/g, "\\'"); }
  escHtml(t) { if (t == null) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
}
