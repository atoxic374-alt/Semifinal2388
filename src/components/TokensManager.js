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
    this.pActivityUrl  = ''; // for streaming — must be twitch.tv or youtube.com
    // Rich Presence extended fields
    this.pDetails    = '';   // line 1 under activity name
    this.pState      = '';   // line 2 under details
    this.pLargeImage = '';   // twitch:channel | youtube:videoId | mp:external/hash
    this.pLargeText  = '';   // hover text for large image
    this.pSmallImage = '';   // same formats as large
    this.pSmallText  = '';   // hover text for small image
    this.pBtn1Name   = '';
    this.pBtn1Url    = '';
    this.pBtn2Name   = '';
    this.pBtn2Url    = '';
    this.pUseTimestamp = false;
    // Party / group presence
    this.pPartySize = '';
    this.pPartyMax  = '';
    this.pPartyId   = '';
    // Live preview timer
    this._previewTimer = null;
    this._previewTimerStart = null;
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
    if (this._previewTimer) { clearInterval(this._previewTimer); this._previewTimer = null; }
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
    if (this.activeTab === 'presence' && this.pUseTimestamp) this.startPreviewTimer();
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
    const isStreaming = this.pActivityType === 1;
    const hasActivity = this.pActivityType !== -1;
    return `
      <div class="tk-presence-layout">

        <!-- ── Controls column ── -->
        <div class="tk-presence-form">

          <div class="mm-card lift">
            <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('tk.apply_to')}</div><div class="mm-card-desc">${t('tk.apply_to_desc')}</div></div></div>
            ${this.renderTokenChips()}
          </div>

          <div class="mm-card lift">
            <div class="mm-card-head"><span class="mm-card-icon">${icon('status_dot')}</span><div><div class="mm-card-title">${t('tk.online_status')}</div><div class="mm-card-desc">${t('tk.online_desc')}</div></div></div>
            <div class="mm-radio-group">
              ${['online','idle','dnd','invisible'].map(s => `
                <label class="mm-radio ${this.pStatus === s ? 'active' : ''}">
                  <input type="radio" name="tk-pstatus" value="${s}" ${this.pStatus === s ? 'checked' : ''} onchange="window.tokensManager.pStatus='${s}';document.getElementById('tk-invisible-warn').style.display='${s==='invisible'?'flex':'none'}';window.tokensManager.upp()">
                  <div><strong>${s.toUpperCase()}</strong><span>${this.statusDesc(s)}</span></div>
                </label>`).join('')}
            </div>
            <div id="tk-invisible-warn" class="tk-warn-row" style="display:${this.pStatus==='invisible'?'flex':'none'}">
              ${icon('shield')} <span>${t('tk.rp.invisible_warn')}</span>
            </div>
          </div>

          <div class="mm-card lift">
            <div class="mm-card-head"><span class="mm-card-icon">${icon('message')}</span><div><div class="mm-card-title">${t('tk.custom_status')}</div><div class="mm-card-desc">${t('tk.custom_desc')}</div></div></div>
            <div class="mm-row-fields">
              <input placeholder="${t('tk.emoji')}" value="${this.escHtml(this.pEmoji)}" oninput="window.tokensManager.pEmoji=this.value;window.tokensManager.upp()">
              <input placeholder="${t('tk.status_text')}" value="${this.escHtml(this.pCustom)}" oninput="window.tokensManager.pCustom=this.value;window.tokensManager.upp()">
            </div>
            <div class="mm-actions-row">
              <button class="mm-btn primary glow" onclick="window.tokensManager.applyPresence()">${t('tk.apply')}</button>
              <button class="mm-btn ghost" onclick="window.tokensManager.clearCustom()">${t('tk.clear_custom')}</button>
              <button class="mm-btn success" onclick="window.tokensManager.applyPresence(true)">${t('tk.apply_all')}</button>
            </div>
          </div>

          <div class="mm-card lift">
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
              <input id="tk-act-name" placeholder="${t('tk.act_name_ph')}" value="${this.escHtml(this.pActivityName)}" oninput="window.tokensManager.pActivityName=this.value;window.tokensManager.upp()">
            </div>

            ${isStreaming ? `
            <div class="tk-rp-section">
              <div class="tk-rp-label">${icon('video')} ${t('tk.rp.stream_url')}</div>
              <input id="tk-stream-url" placeholder="${t('tk.rp.stream_url_ph')}" value="${this.escHtml(this.pActivityUrl)}" oninput="window.tokensManager.pActivityUrl=this.value;window.tokensManager.upp()">
              <div class="tk-rp-hint">${t('tk.rp.stream_warn')}</div>
              <div class="tk-rp-quick-urls">
                <button class="mm-btn ghost small" onclick="window.tokensManager.pActivityUrl='https://twitch.tv/discord';document.getElementById('tk-stream-url').value='https://twitch.tv/discord';window.tokensManager.upp()">Twitch</button>
                <button class="mm-btn ghost small" onclick="window.tokensManager.pActivityUrl='https://www.youtube.com/watch?v=dQw4w9WgXcQ';document.getElementById('tk-stream-url').value='https://www.youtube.com/watch?v=dQw4w9WgXcQ';window.tokensManager.upp()">YouTube</button>
              </div>
            </div>` : ''}

            ${hasActivity ? `
            <div class="tk-rp-section">
              <div class="tk-rp-label">${icon('file_text')} ${t('tk.rp.details_section')}</div>
              <div class="mm-row-fields">
                <input placeholder="${t('tk.rp.details_ph')}" value="${this.escHtml(this.pDetails)}" oninput="window.tokensManager.pDetails=this.value;window.tokensManager.upp()" maxlength="128">
                <input placeholder="${t('tk.rp.state_ph')}" value="${this.escHtml(this.pState)}" oninput="window.tokensManager.pState=this.value;window.tokensManager.upp()" maxlength="128">
              </div>
              <div class="tk-rp-hint">${t('tk.rp.details_hint')}</div>
            </div>

            <div class="tk-rp-section">
              <div class="tk-rp-label">${icon('users')} ${t('tk.rp.party')}</div>
              <div class="mm-row-fields">
                <input type="number" min="1" max="99" placeholder="${t('tk.rp.party_current')}" value="${this.escHtml(this.pPartySize)}" oninput="window.tokensManager.pPartySize=this.value;window.tokensManager.upp()">
                <input type="number" min="1" max="99" placeholder="${t('tk.rp.party_max')}" value="${this.escHtml(this.pPartyMax)}" oninput="window.tokensManager.pPartyMax=this.value;window.tokensManager.upp()">
                <input placeholder="${t('tk.rp.party_id_ph')}" value="${this.escHtml(this.pPartyId)}" oninput="window.tokensManager.pPartyId=this.value">
              </div>
              <div class="tk-rp-hint">${t('tk.rp.party_hint')}</div>
            </div>

            <div class="tk-rp-section">
              <div class="tk-rp-label">${icon('image')} ${t('tk.rp.images')}</div>
              <div class="tk-rp-hint" style="margin-bottom:6px">${t('tk.rp.img_hint')}</div>
              <div class="mm-row-fields">
                <input id="tk-large-img" placeholder="${t('tk.rp.large_img_ph')}" value="${this.escHtml(this.pLargeImage)}" oninput="window.tokensManager.pLargeImage=this.value;window.tokensManager.upp()">
                <input placeholder="${t('tk.rp.large_text_ph')}" value="${this.escHtml(this.pLargeText)}" oninput="window.tokensManager.pLargeText=this.value;window.tokensManager.upp()" maxlength="128">
              </div>
              <div class="mm-row-fields" style="margin-top:4px">
                <input placeholder="${t('tk.rp.small_img_ph')}" value="${this.escHtml(this.pSmallImage)}" oninput="window.tokensManager.pSmallImage=this.value;window.tokensManager.upp()">
                <input placeholder="${t('tk.rp.small_text_ph')}" value="${this.escHtml(this.pSmallText)}" oninput="window.tokensManager.pSmallText=this.value;window.tokensManager.upp()" maxlength="128">
              </div>
              ${isStreaming ? `
              <div class="tk-rp-quick-urls" style="margin-top:6px">
                <span class="tk-rp-hint" style="margin-bottom:0">${t('tk.rp.img_quick')}:</span>
                <button class="mm-btn ghost small" onclick="const ch=(window.tokensManager.pActivityUrl.replace(/.*twitch\\.tv\\//, '')||'discord').split('?')[0].split('/')[0];window.tokensManager.pLargeImage='twitch:'+ch;document.getElementById('tk-large-img').value='twitch:'+ch;window.tokensManager.upp()">${t('tk.rp.img_from_twitch')}</button>
                <button class="mm-btn ghost small" onclick="const id=(window.tokensManager.pActivityUrl.match(/[?&]v=([^&]+)/)||['',''])[1];window.tokensManager.pLargeImage='youtube:'+id;document.getElementById('tk-large-img').value='youtube:'+id;window.tokensManager.upp()">${t('tk.rp.img_from_youtube')}</button>
              </div>` : ''}
            </div>

            <div class="tk-rp-section">
              <div class="tk-rp-label">${icon('external')} ${t('tk.rp.buttons')} <span class="tk-rp-hint" style="font-weight:normal;margin:0;text-transform:none;letter-spacing:0">${t('tk.rp.buttons_hint')}</span></div>
              <div class="mm-row-fields" style="margin-bottom:4px">
                <input placeholder="${t('tk.rp.btn_name')}" value="${this.escHtml(this.pBtn1Name)}" oninput="window.tokensManager.pBtn1Name=this.value;window.tokensManager.upp()" maxlength="32">
                <input placeholder="${t('tk.rp.btn_url')}" value="${this.escHtml(this.pBtn1Url)}" oninput="window.tokensManager.pBtn1Url=this.value">
              </div>
              <div class="mm-row-fields">
                <input placeholder="${t('tk.rp.btn2_name')}" value="${this.escHtml(this.pBtn2Name)}" oninput="window.tokensManager.pBtn2Name=this.value;window.tokensManager.upp()" maxlength="32">
                <input placeholder="${t('tk.rp.btn2_url')}" value="${this.escHtml(this.pBtn2Url)}" oninput="window.tokensManager.pBtn2Url=this.value">
              </div>
            </div>

            <div class="tk-rp-section">
              <label class="mm-toggle tk-rp-ts-toggle">
                <input type="checkbox" ${this.pUseTimestamp ? 'checked' : ''} onchange="window.tokensManager.pUseTimestamp=this.checked;window.tokensManager.startPreviewTimer();window.tokensManager.upp()">
                ${t('tk.rp.timestamp')}
              </label>
            </div>` : ''}

            ${this.activityRiskHtml()}
            <div class="mm-actions-row">
              <button class="mm-btn primary glow" onclick="window.tokensManager.applyActivity()">${t('tk.apply_activity')}</button>
              <button class="mm-btn ghost" onclick="window.tokensManager.clearActivity()">${t('tk.clear_activity')}</button>
              <button class="mm-btn success" onclick="window.tokensManager.applyActivity(true)">${t('tk.apply_all')}</button>
            </div>
          </div>

        </div><!-- /tk-presence-form -->

        <!-- ── Live Preview column ── -->
        <div class="tk-presence-preview-col">
          <div class="tk-preview-label">
            ${icon('monitor')} ${t('tk.rp.live_preview')}
            <span class="tk-preview-badge">${t('tk.rp.updates_live')}</span>
          </div>
          <div id="tk-preview-wrap">${this.renderDiscordCard()}</div>
          <div class="tk-preview-tips">
            <div class="tk-tip-item">${icon('image')}<div><strong>Image formats:</strong> twitch:channel · youtube:videoId · https://... (direct URL)</div></div>
            <div class="tk-tip-item">${icon('video')}<div><strong>Streaming badge:</strong> URL must be twitch.tv or youtube.com</div></div>
            <div class="tk-tip-item">${icon('external')}<div><strong>Buttons:</strong> max 32-char label + any https:// URL</div></div>
            <div class="tk-tip-item">${icon('users')}<div><strong>Party:</strong> "X of Y" appears after State text in Discord</div></div>
            <div class="tk-tip-item">${icon('clock')}<div><strong>Timestamp:</strong> sent at apply time, shows elapsed in Discord</div></div>
            <div class="tk-tip-item">${icon('shield')}<div><strong>Invisible:</strong> activity applied but hidden from others</div></div>
          </div>
        </div>

      </div><!-- /tk-presence-layout -->
    `;
  }

  onActivityTypeChange(v) {
    this.pActivityType = parseInt(v);
    if (this.pActivityType !== 1) {
      this.pActivityUrl = '';
    } else if (!this.pActivityUrl) {
      this.pActivityUrl = 'https://twitch.tv/discord';
    }
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

    // Streaming URL (auto-fallback to twitch.tv/discord if empty)
    if (this.pActivityType === 1) {
      activity.url = this.pActivityUrl.trim() || 'https://twitch.tv/discord';
    }

    // Rich Presence extended fields
    if (this.pDetails.trim())    activity.details    = this.pDetails.trim();
    if (this.pState.trim())      activity.state      = this.pState.trim();
    if (this.pLargeImage.trim()) activity.largeImage = this.pLargeImage.trim();
    if (this.pLargeText.trim())  activity.largeText  = this.pLargeText.trim();
    if (this.pSmallImage.trim()) activity.smallImage = this.pSmallImage.trim();
    if (this.pSmallText.trim())  activity.smallText  = this.pSmallText.trim();
    if (this.pUseTimestamp)      activity.startTimestamp = Date.now();

    // Buttons (max 2, both name and url required)
    const buttons = [];
    if (this.pBtn1Name.trim() && this.pBtn1Url.trim())
      buttons.push({ name: this.pBtn1Name.trim(), url: this.pBtn1Url.trim() });
    if (this.pBtn2Name.trim() && this.pBtn2Url.trim())
      buttons.push({ name: this.pBtn2Name.trim(), url: this.pBtn2Url.trim() });
    if (buttons.length) activity.buttons = buttons;

    // Party / group
    if (this.pPartySize && this.pPartyMax) {
      activity.partySize = parseInt(this.pPartySize);
      activity.partyMax  = parseInt(this.pPartyMax);
      if (this.pPartyId.trim()) activity.partyId = this.pPartyId.trim();
    }

    try {
      const r = await window.electronAPI.setPresence({ tokens, status: this.pStatus, activity });
      const ok = (r.results || []).filter(x => x.ok).length;
      const fail = (r.results || []).length - ok;
      showNotification(`${t('tk.apply_activity')} ${t('common.ok')} ${ok}  ${t('common.fail')} ${fail}${fail ? ' ⚠' : ''}`);
    } catch (e) { showNotification(`${t('mm.failed')}: ${e.message}`); }
  }

  async clearActivity() {
    this.pActivityType   = -1;
    this.pActivityName   = '';
    this.pActivityUrl    = '';
    this.pDetails        = '';
    this.pState          = '';
    this.pLargeImage     = '';
    this.pLargeText      = '';
    this.pSmallImage     = '';
    this.pSmallText      = '';
    this.pBtn1Name       = '';
    this.pBtn1Url        = '';
    this.pBtn2Name       = '';
    this.pBtn2Url        = '';
    this.pUseTimestamp   = false;
    this.pPartySize      = '';
    this.pPartyMax       = '';
    this.pPartyId        = '';
    const tokens = this.selected.length ? this.selected : this._allConnectedNames();
    await window.electronAPI.setPresence({ tokens, status: this.pStatus, customStatus: this.pCustom || '', emoji: this.pEmoji || undefined });
    this.render();
  }

  statusDesc(s) {
    return t('tk.status.' + s) || '';
  }

  statusColor(s) {
    return { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', invisible: '#80848e' }[s] || '#80848e';
  }

  getImagePreviewUrl(img) {
    if (!img || typeof img !== 'string') return null;
    const s = img.trim();
    if (!s) return null;
    if (s.startsWith('twitch:')) {
      const ch = s.slice(7).split('?')[0].split('/')[0];
      return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${ch}-440x248.jpg`;
    }
    if (s.startsWith('youtube:')) {
      const id = s.slice(8).split('?')[0];
      return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
    }
    if (s.startsWith('mp:external/')) {
      const parts = s.replace('mp:external/', '').split('/');
      if (parts.length >= 3) return `${parts[1]}://${parts.slice(2).join('/')}`;
      return null;
    }
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    return null;
  }

  activityTypeLabel() {
    const isYt = this.pActivityUrl && this.pActivityUrl.includes('youtube');
    const labels = {
      '-1': '', '0': 'PLAYING A GAME',
       '1': isYt ? 'LIVE ON YOUTUBE' : 'LIVE ON TWITCH',
       '2': 'LISTENING TO', '3': 'WATCHING', '5': 'COMPETING IN'
    };
    return labels[String(this.pActivityType)] || 'PLAYING A GAME';
  }

  renderDiscordCard() {
    const clientName = this.selected[0] || this.clients[0]?.name;
    const client = this.clients.find(c => c.name === clientName) || this.clients[0];
    const avatarUrl = client?.avatar || '/discord.png';
    const displayName = client?.displayName || client?.username || clientName || 'Preview';
    const username = client?.username || '';
    const statusCol = this.statusColor(this.pStatus);
    const isInvisible = this.pStatus === 'invisible';
    const isStreaming = this.pActivityType === 1;
    const isYt = isStreaming && this.pActivityUrl && this.pActivityUrl.includes('youtube');
    const hasCustom = !!(this.pCustom.trim() || this.pEmoji.trim());
    const hasActivity = this.pActivityType !== -1 && this.pActivityName.trim();
    const largeImgUrl = this.getImagePreviewUrl(this.pLargeImage);
    const smallImgUrl = this.getImagePreviewUrl(this.pSmallImage);
    const btns = [];
    if (this.pBtn1Name.trim()) btns.push(this.pBtn1Name.trim());
    if (this.pBtn2Name.trim()) btns.push(this.pBtn2Name.trim());
    const hasParty = this.pPartySize && this.pPartyMax;
    const stateText = (this.pState.trim() + (hasParty ? ` (${this.pPartySize} of ${this.pPartyMax})` : '')).trim();
    const bannerBg = isStreaming
      ? (isYt ? 'linear-gradient(135deg,#c4302b,#861f1b)' : 'linear-gradient(135deg,#6441a5,#3d1f6e)')
      : 'linear-gradient(135deg,#5865f2 0%,#3444b8 100%)';
    return `
      <div class="dk-card">
        <div class="dk-banner" style="background:${bannerBg}">
          ${isStreaming ? `<div class="dk-live-badge">${isYt ? '▶ LIVE' : '🔴 LIVE'}</div>` : ''}
          ${isInvisible ? '<div class="dk-invis-badge">INVISIBLE</div>' : ''}
        </div>
        <div class="dk-avatar-area">
          <div class="dk-av-wrap">
            <img class="dk-av" src="${avatarUrl}" onerror="this.src='/discord.png'">
            <span class="dk-status-ring" style="background:${isInvisible ? '#72767d' : statusCol}"></span>
          </div>
        </div>
        <div class="dk-name-section">
          <div class="dk-display-name">${this.escHtml(displayName)}</div>
          ${username && username !== displayName ? `<div class="dk-username-sub">@${this.escHtml(username)}</div>` : ''}
        </div>
        ${hasCustom || hasActivity ? '<div class="dk-divider"></div>' : ''}
        ${hasCustom ? `
        <div class="dk-section">
          <div class="dk-section-title">CUSTOM STATUS</div>
          <div class="dk-custom-status">
            ${this.pEmoji ? `<span class="dk-cs-emoji">${this.escHtml(this.pEmoji)}</span>` : ''}
            ${this.pCustom.trim() ? `<span class="dk-cs-text">${this.escHtml(this.pCustom.trim())}</span>` : ''}
          </div>
        </div>` : ''}
        ${hasActivity ? `
        ${hasCustom ? '<div class="dk-divider"></div>' : ''}
        <div class="dk-section">
          <div class="dk-section-title ${isStreaming ? (isYt ? 'dk-yt' : 'dk-twitch') : ''}">${this.activityTypeLabel()}</div>
          <div class="dk-activity-row">
            ${largeImgUrl ? `
            <div class="dk-act-imgs">
              <div class="dk-act-large" style="background-image:url('${largeImgUrl}')" title="${this.escHtml(this.pLargeText || '')}">
                ${smallImgUrl ? `<img class="dk-act-small" src="${smallImgUrl}" title="${this.escHtml(this.pSmallText || '')}" onerror="this.style.display='none'">` : ''}
              </div>
            </div>` : ''}
            <div class="dk-act-info">
              <div class="dk-act-name">${this.escHtml(this.pActivityName.trim())}</div>
              ${this.pDetails.trim() ? `<div class="dk-act-detail">${this.escHtml(this.pDetails.trim())}</div>` : ''}
              ${stateText ? `<div class="dk-act-detail">${this.escHtml(stateText)}</div>` : ''}
              ${this.pUseTimestamp ? '<div class="dk-act-detail dk-elapsed" id="tk-preview-elapsed">00:00 elapsed</div>' : ''}
            </div>
          </div>
          ${btns.length ? `
          <div class="dk-btns">
            ${btns.map(b => `<button class="dk-btn">${this.escHtml(b)}</button>`).join('')}
          </div>` : ''}
        </div>` : (!hasCustom ? `
        <div class="dk-section dk-empty-state">
          <div class="dk-empty-icon">👤</div>
          <div class="dk-empty-text">No activity set</div>
          <div class="dk-empty-sub">Pick a type above to preview</div>
        </div>` : '')}
      </div>
    `;
  }

  upp() {
    const el = document.getElementById('tk-preview-wrap');
    if (el) el.innerHTML = this.renderDiscordCard();
  }

  startPreviewTimer() {
    if (this._previewTimer) { clearInterval(this._previewTimer); this._previewTimer = null; }
    if (!this.pUseTimestamp) return;
    this._previewTimerStart = Date.now();
    this._previewTimer = setInterval(() => {
      const el = document.getElementById('tk-preview-elapsed');
      if (!el) { clearInterval(this._previewTimer); this._previewTimer = null; return; }
      const s = Math.floor((Date.now() - this._previewTimerStart) / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      el.textContent = h
        ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')} elapsed`
        : `${m}:${String(sec).padStart(2,'0')} elapsed`;
    }, 1000);
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
