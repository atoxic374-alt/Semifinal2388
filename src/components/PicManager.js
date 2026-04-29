// Pic Capture — grabs every image posted in selected accounts/servers.
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';
import { showToast, pulseButton, shakeFail, showConfirm } from '../utils/ui.js';

export class PicManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.config = { enabled: false, accounts: [], scope: 'all', servers: [], webhook: '', inApp: true };
    this.buffer = [];
    this.accounts = {};
    this.tokens = [];
    this.servers = [];
    this.es = null;
    this.tab = 'feed';
  }

  async init() {
    await this.render();
    this.connectStream();
  }
  disconnect() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } }

  connectStream() {
    this.disconnect();
    try {
      this.es = new EventSource('/api/features/stream?types=pic');
      this.es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'pic' && d.capture) {
            this.buffer.unshift(d.capture);
            if (this.buffer.length > 200) this.buffer.length = 200;
            sfx.notify();
            if (this.tab === 'feed') this.renderFeed();
          }
        } catch (e) {}
      };
    } catch (e) {}
  }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('image')}</span>
            <div>
              <h2 class="mm-title">${t('pc.title')}</h2>
              <p class="mm-subtitle">${t('pc.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            <button class="mm-btn small ${this.tab === 'feed' ? '' : 'ghost'}" id="pc-tab-feed">${icon('image')} ${t('pc.feed')}</button>
            <button class="mm-btn small ${this.tab === 'config' ? '' : 'ghost'}" id="pc-tab-config">${icon('settings')} ${t('pc.config')}</button>
          </div>
        </div>
        <div class="mm-body" id="pc-body"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
      </div>
    `;
    this.contentArea.querySelector('#pc-tab-feed').addEventListener('click', () => { sfx.click(); this.tab = 'feed'; this.render(); });
    this.contentArea.querySelector('#pc-tab-config').addEventListener('click', () => { sfx.click(); this.tab = 'config'; this.render(); });

    const [cfg, buf, tk, srv] = await Promise.all([
      fetch('/api/pic/config').then(r => r.json()),
      fetch('/api/pic/buffer').then(r => r.json()),
      fetch('/api/tokens').then(r => r.json()),
      fetch('/api/discord/servers').then(r => r.json()).catch(() => ({ servers: [] })),
    ]);
    if (cfg.success) this.config = { ...this.config, ...cfg.config };
    if (buf.success) { this.buffer = buf.buffer || []; this.accounts = buf.accounts || {}; }
    if (tk.success) this.tokens = tk.tokens || [];
    if (srv.success) this.servers = srv.servers || [];

    if (this.tab === 'feed') this.renderFeed();
    else this.renderConfig();
  }

  renderFeed() {
    const body = this.contentArea.querySelector('#pc-body');
    if (!body) return;
    if (!this.buffer.length) {
      body.innerHTML = `
        <div class="mm-info-row mm-muted">${this.config.enabled ? t('pc.empty_on') : t('pc.empty_off')}</div>
        ${!this.config.enabled ? `<div class="mm-info-row"><button class="mm-btn small" onclick="window.picManager.tab='config';window.picManager.render()">${icon('settings')} ${t('pc.go_config')}</button></div>` : ''}
      `;
      return;
    }
    body.innerHTML = `
      <div class="pc-toolbar">
        <span class="pc-status ${this.config.enabled ? 'on' : 'off'}">${icon(this.config.enabled ? 'play' : 'stop')} ${this.config.enabled ? t('pc.on') : t('pc.off')}</span>
        <span class="pc-count">${this.buffer.length} ${t('pc.captures')}</span>
        <button class="mm-btn ghost small" onclick="window.picManager.refreshBuffer()">${icon('refresh')} ${t('common.refresh')}</button>
        <button class="mm-btn danger small" onclick="window.picManager.clearBuffer()">${icon('trash')} ${t('pc.clear_feed')}</button>
      </div>
      <div class="pc-grid">
        ${this.buffer.map(c => this.card(c)).join('')}
      </div>
    `;
  }

  card(c) {
    const acct = this.accounts[c.account] || {};
    const media = Array.isArray(c.media) ? c.media : (c.images || []);
    const prox = (u) => this.mediaUrl(u, c.account);
    return `
      <div class="pc-card">
        <div class="pc-card-imgs">
          ${media.map(i => {
            if (i.kind === 'image') return `<a href="${prox(i.url)}" target="_blank" rel="noopener"><img src="${prox(i.url)}" alt="${this.escAttr(i.name)}" loading="lazy"></a>`;
            if (i.kind === 'video') return `<a href="${prox(i.url)}" target="_blank" rel="noopener"><video src="${prox(i.url)}" controls preload="metadata"></video></a>`;
            if (i.kind === 'audio') return `<div class="pc-media-file"><audio src="${prox(i.url)}" controls preload="none"></audio></div>`;
            return `<div class="pc-media-file"><a href="${prox(i.url)}" target="_blank" rel="noopener">${icon('file')} ${this.escHtml(i.name || 'file')}</a></div>`;
          }).join('')}
        </div>
        <div class="pc-card-meta">
          <div class="pc-card-line">
            <img class="pc-card-acct" src="${acct.avatar || '/discord.png'}" title="${this.escAttr(c.account)}" onerror="this.src='/discord.png'">
            <img class="pc-card-author" src="${c.author.avatar}" onerror="this.src='/discord.png'">
            <strong>${this.escHtml(c.author.displayName)}</strong>
            ${c.author.bot ? `<span class="pm-bot-tag">${icon('bot')}</span>` : ''}
          </div>
          <div class="pc-card-where">
            ${c.guild ? `${c.guild.icon ? `<img src="${c.guild.icon}" class="pc-where-ic">` : icon('shield')} ${this.escHtml(c.guild.name)} · #${this.escHtml(c.channel.name)}` : `#${this.escHtml(c.channel.name)}`}
          </div>
          ${c.content ? `<div class="pc-card-text">${this.escHtml(c.content.slice(0, 200))}</div>` : ''}
          <div class="pc-card-foot">
            <span>${this.fmtTime(c.ts)}</span>
            <button class="mm-btn ghost small" data-url="${this.escAttr(media[0]?.url || '')}" onclick="if(this.dataset.url){navigator.clipboard.writeText(this.dataset.url);window.sfx?.click()}">${icon('copy')} URL</button>
          </div>
        </div>
      </div>
    `;
  }

  renderConfig() {
    const body = this.contentArea.querySelector('#pc-body');
    if (!body) return;
    body.innerHTML = `
      <div class="mm-card">
        <div class="mm-card-head">
          <div class="mm-card-icon">${icon('settings')}</div>
          <div><div class="mm-card-title">${t('pc.cfg_title')}</div><div class="mm-card-sub">${t('pc.cfg_sub')}</div></div>
        </div>
        <div class="mm-card-body">
          <label class="toggle-pill ${this.config.enabled ? 'on' : ''}" id="pc-en">
            ${icon(this.config.enabled ? 'play' : 'stop')} <span>${t('pc.enable')}</span>
          </label>
          <label class="toggle-pill ${this.config.inApp ? 'on' : ''}" id="pc-inapp">
            ${icon('image')} <span>${t('pc.inapp')}</span>
          </label>

          <div class="mm-section-title">${t('pc.accounts_label')}</div>
          <div class="pc-chips">
            ${this.tokens.map(tk => `
              <label class="pc-chip ${this.config.accounts.includes(tk.name) ? 'on' : ''}" data-acct="${this.escAttr(tk.name)}">
                ${icon('user')} ${this.escHtml(tk.name)}
              </label>
            `).join('') || `<em class="mm-muted">${t('pc.no_accounts')}</em>`}
          </div>

          <div class="mm-section-title">${t('pc.scope_label')}</div>
          <div class="pc-radio" id="pc-scope-radio">
            <label><input type="radio" name="pc-scope" value="all" ${this.config.scope === 'all' ? 'checked' : ''}> ${t('pc.scope_all')}</label>
            <label><input type="radio" name="pc-scope" value="servers" ${this.config.scope === 'servers' ? 'checked' : ''}> ${t('pc.scope_some')}</label>
          </div>
          <div id="pc-srv-wrap" style="${this.config.scope === 'servers' ? '' : 'display:none'}">
            ${this._serverChipsHtml()}
          </div>

          <div class="mm-section-title">${t('pc.webhook_label')}</div>
          <input type="text" class="mm-input" id="pc-wh" placeholder="https://discord.com/api/webhooks/..." value="${this.escAttr(this.config.webhook || '')}">
          <p class="mm-muted">${t('pc.webhook_help')}</p>

          <div class="mm-card-actions">
            <button class="mm-btn" id="pc-save">${icon('check')} ${t('common.save')}</button>
          </div>
        </div>
      </div>
    `;
    body.querySelector('#pc-en').addEventListener('click', (e) => { e.preventDefault(); this.config.enabled = !this.config.enabled; sfx.toggle(); this.renderConfig(); });
    body.querySelector('#pc-inapp').addEventListener('click', (e) => { e.preventDefault(); this.config.inApp = !this.config.inApp; sfx.toggle(); this.renderConfig(); });
    body.querySelectorAll('[data-acct]').forEach(el => el.addEventListener('click', (e) => {
      e.preventDefault();
      const n = el.dataset.acct;
      const i = this.config.accounts.indexOf(n);
      if (i >= 0) this.config.accounts.splice(i, 1); else this.config.accounts.push(n);
      sfx.click(); el.classList.toggle('on');
    }));
    body.querySelectorAll('input[name="pc-scope"]').forEach(el => el.addEventListener('change', () => {
      const wrap = body.querySelector('#pc-srv-wrap');
      if (el.value === 'servers' && !this.servers.length) {
        // Invalid: no servers loaded — shake the radio label and revert.
        const lbl = el.closest('label');
        shakeFail(lbl);
        showToast(t('common.invalid_choice'), 'error');
        el.checked = false;
        body.querySelector('input[name="pc-scope"][value="all"]').checked = true;
        this.config.scope = 'all';
        wrap.style.display = 'none';
        return;
      }
      this.config.scope = el.value;
      wrap.style.display = (this.config.scope === 'servers' ? '' : 'none');
      this._bindServerChips(body);
    }));
    this._bindServerChips(body);
    body.querySelector('#pc-save').addEventListener('click', async (ev) => {
      sfx.click();
      this.config.webhook = body.querySelector('#pc-wh').value.trim();
      try {
        await pulseButton(ev.currentTarget, async () => {
          const r = await fetch('/api/pic/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.config) }).then(x => x.json());
          if (!r.success) throw new Error(r.error || 'Failed');
          this.config = r.config;
          return r;
        });
        showToast(t('common.save_ok'), 'success');
        this.renderConfig();
      } catch (e) {
        showToast(e.message || t('common.save_fail'), 'error');
      }
    });
  }

  _serverChipsHtml() {
    if (!this.servers.length) return `<em class="mm-muted">${t('common.invalid_choice')}</em>`;
    const sel = (this.config.servers || []);
    if (sel.length && !this._showAllServers) {
      const names = this.servers.filter(s => sel.includes(s.id)).map(s => this.escHtml(s.name)).join(', ');
      return `
        <div class="pc-chips-collapsed" id="pc-srv-collapsed">
          ${icon('shield')}
          <span><strong>${sel.length}</strong> · ${names || '—'}</span>
          <span class="pc-chips-collapsed-edit">${t('common.refresh') || 'edit'}</span>
        </div>
      `;
    }
    return `
      <div class="pc-chips" id="pc-srv-chips">
        ${this.servers.map(s => `
          <label class="pc-chip ${sel.includes(s.id) ? 'on' : ''}" data-srv="${s.id}">
            ${s.icon ? `<img src="${s.icon}" class="pc-srv-ic">` : icon('shield')} ${this.escHtml(s.name)}
          </label>
        `).join('')}
        ${sel.length ? `<button class="mm-btn ghost small" id="pc-srv-done" type="button">${icon('check')} ${t('common.ok') || 'done'}</button>` : ''}
      </div>
    `;
  }

  _bindServerChips(body) {
    const wrap = body.querySelector('#pc-srv-wrap');
    if (!wrap) return;
    const collapsed = wrap.querySelector('#pc-srv-collapsed');
    if (collapsed) {
      collapsed.addEventListener('click', () => {
        sfx.click();
        this._showAllServers = true;
        wrap.innerHTML = this._serverChipsHtml();
        this._bindServerChips(body);
      });
      return;
    }
    wrap.querySelectorAll('[data-srv]').forEach(el => el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.dataset.srv;
      this.config.servers = this.config.servers || [];
      const i = this.config.servers.indexOf(id);
      if (i >= 0) this.config.servers.splice(i, 1); else this.config.servers.push(id);
      sfx.click(); el.classList.toggle('on');
    }));
    const done = wrap.querySelector('#pc-srv-done');
    if (done) done.addEventListener('click', () => {
      sfx.click();
      this._showAllServers = false;
      wrap.innerHTML = this._serverChipsHtml();
      this._bindServerChips(body);
    });
  }

  async refreshBuffer() {
    sfx.click();
    const r = await fetch('/api/pic/buffer').then(x => x.json());
    if (r.success) { this.buffer = r.buffer || []; this.accounts = r.accounts || {}; this.renderFeed(); }
  }

  async clearBuffer() {
    if (!await showConfirm(t('pc.confirm_clear'), { confirmText: t('common.delete'), cancelText: t('common.cancel') })) return;
    sfx.click();
    await fetch('/api/pic/buffer', { method: 'DELETE' });
    this.buffer = []; this.renderFeed();
  }

  fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
  mediaUrl(url, account) {
    return `/api/pic/media-proxy?u=${encodeURIComponent(url || '')}&account=${encodeURIComponent(account || '')}`;
  }
}
