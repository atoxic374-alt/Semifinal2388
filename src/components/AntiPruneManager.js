// Anti-Prune — when a user is removed by audit-log MEMBER_PRUNE, DM them an invite.
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';
import { showToast, pulseButton, shakeFail, showConfirm } from '../utils/ui.js';

export class AntiPruneManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.config = { enabled: false, accounts: [], scope: 'all', servers: [], message: '', distribute: true };
    this.log = [];
    this.tokens = [];
    this.servers = [];
    this.es = null;
    this.tab = 'config';
  }

  async init() {
    await this.render();
    this.connectStream();
  }
  disconnect() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } }

  connectStream() {
    this.disconnect();
    try {
      this.es = new EventSource('/api/features/stream?types=antiprune');
      this.es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'antiprune' && d.event) {
            this.log.unshift(d.event);
            (d.event.ok ? sfx.success : sfx.fail)();
            if (this.tab === 'log') this.renderLog();
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
            <span class="mm-icon">${icon('shield')}</span>
            <div>
              <h2 class="mm-title">${t('ap.title')}</h2>
              <p class="mm-subtitle">${t('ap.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            <button class="mm-btn small ${this.tab === 'config' ? '' : 'ghost'}" id="ap-tab-config">${icon('settings')} ${t('ap.config')}</button>
            <button class="mm-btn small ${this.tab === 'log' ? '' : 'ghost'}" id="ap-tab-log">${icon('scroll')} ${t('ap.log')}</button>
          </div>
        </div>
        <div class="mm-body" id="ap-body"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
      </div>
    `;
    this.contentArea.querySelector('#ap-tab-config').addEventListener('click', () => { sfx.click(); this.tab = 'config'; this.render(); });
    this.contentArea.querySelector('#ap-tab-log').addEventListener('click', () => { sfx.click(); this.tab = 'log'; this.render(); });

    const [cfg, lg, tk, srv] = await Promise.all([
      fetch('/api/antiprune/config').then(r => r.json()),
      fetch('/api/antiprune/log').then(r => r.json()),
      fetch('/api/tokens').then(r => r.json()),
      fetch('/api/discord/servers').then(r => r.json()).catch(() => ({ servers: [] })),
    ]);
    if (cfg.success) this.config = { ...this.config, ...cfg.config };
    if (lg.success) this.log = lg.log || [];
    if (tk.success) this.tokens = tk.tokens || [];
    if (srv.success) this.servers = srv.servers || [];
    if (this.tab === 'config') this.renderConfig(); else this.renderLog();
  }

  renderConfig() {
    const body = this.contentArea.querySelector('#ap-body');
    if (!body) return;
    body.innerHTML = `
      <div class="mm-card">
        <div class="mm-card-head">
          <div class="mm-card-icon">${icon('shield')}</div>
          <div><div class="mm-card-title">${t('ap.cfg_title')}</div><div class="mm-card-sub">${t('ap.cfg_sub')}</div></div>
        </div>
        <div class="mm-card-body">
          <label class="toggle-pill ${this.config.enabled ? 'on' : ''}" id="ap-en">
            ${icon(this.config.enabled ? 'play' : 'stop')} <span>${t('ap.enable')}</span>
          </label>
          <label class="toggle-pill ${this.config.distribute !== false ? 'on' : ''}" id="ap-dist">
            ${icon('users')} <span>${t('ap.distribute')}</span>
          </label>

          <div class="mm-section-title">${t('ap.accounts_label')}</div>
          <div class="pc-chips">
            ${this.tokens.length ? this.tokens.map(tk => `
              <label class="pc-chip ${this.config.accounts.includes(tk.name) ? 'on' : ''}" data-acct="${this.escAttr(tk.name)}">
                ${icon('user')} ${this.escHtml(tk.name)}
              </label>
            `).join('') : `<em class="mm-muted">${t('pc.no_accounts')}</em>`}
          </div>

          <div class="mm-section-title">${t('ap.scope_label')}</div>
          <div class="pc-radio" id="ap-scope-radio">
            <label><input type="radio" name="ap-scope" value="all" ${this.config.scope === 'all' ? 'checked' : ''}> ${t('ap.scope_all')}</label>
            <label><input type="radio" name="ap-scope" value="servers" ${this.config.scope === 'servers' ? 'checked' : ''}> ${t('ap.scope_some')}</label>
          </div>
          <div id="ap-srv-wrap" style="${this.config.scope === 'servers' ? '' : 'display:none'}">
            ${this._serverChipsHtml()}
          </div>

          <div class="mm-section-title">${t('ap.message_label')}</div>
          <textarea class="mm-input" id="ap-msg" rows="4" placeholder="${this.escAttr(t('ap.message_ph'))}">${this.escHtml(this.config.message || '')}</textarea>
          <p class="mm-muted">${t('ap.message_help')}</p>

          <div class="mm-card-actions">
            <button class="mm-btn" id="ap-save">${icon('check')} ${t('common.save')}</button>
          </div>
        </div>
      </div>
    `;
    body.querySelector('#ap-en').addEventListener('click', (e) => { e.preventDefault(); this.config.enabled = !this.config.enabled; sfx.toggle(); this.renderConfig(); });
    body.querySelector('#ap-dist').addEventListener('click', (e) => { e.preventDefault(); this.config.distribute = this.config.distribute === false; sfx.toggle(); this.renderConfig(); });
    body.querySelectorAll('[data-acct]').forEach(el => el.addEventListener('click', (e) => {
      e.preventDefault();
      const n = el.dataset.acct;
      const i = this.config.accounts.indexOf(n);
      if (i >= 0) this.config.accounts.splice(i, 1); else this.config.accounts.push(n);
      sfx.click(); el.classList.toggle('on');
    }));
    body.querySelectorAll('input[name="ap-scope"]').forEach(el => el.addEventListener('change', () => {
      const wrap = body.querySelector('#ap-srv-wrap');
      if (el.value === 'servers' && !this.servers.length) {
        const lbl = el.closest('label');
        shakeFail(lbl);
        showToast(t('common.invalid_choice'), 'error');
        el.checked = false;
        body.querySelector('input[name="ap-scope"][value="all"]').checked = true;
        this.config.scope = 'all';
        wrap.style.display = 'none';
        return;
      }
      this.config.scope = el.value;
      wrap.style.display = (this.config.scope === 'servers' ? '' : 'none');
      this._bindServerChips(body);
    }));
    this._bindServerChips(body);
    body.querySelector('#ap-save').addEventListener('click', async (ev) => {
      sfx.click();
      this.config.message = body.querySelector('#ap-msg').value;
      try {
        await pulseButton(ev.currentTarget, async () => {
          const r = await fetch('/api/antiprune/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.config) }).then(x => x.json());
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
        <div class="pc-chips-collapsed" id="ap-srv-collapsed">
          ${icon('shield')}
          <span><strong>${sel.length}</strong> · ${names || '—'}</span>
          <span class="pc-chips-collapsed-edit">edit</span>
        </div>
      `;
    }
    return `
      <div class="pc-chips" id="ap-srv-chips">
        ${this.servers.map(s => `
          <label class="pc-chip ${sel.includes(s.id) ? 'on' : ''}" data-srv="${s.id}">
            ${s.icon ? `<img src="${s.icon}" class="pc-srv-ic">` : icon('shield')} ${this.escHtml(s.name)}
          </label>
        `).join('')}
        ${sel.length ? `<button class="mm-btn ghost small" id="ap-srv-done" type="button">${icon('check')} done</button>` : ''}
      </div>
    `;
  }

  _bindServerChips(body) {
    const wrap = body.querySelector('#ap-srv-wrap');
    if (!wrap) return;
    const collapsed = wrap.querySelector('#ap-srv-collapsed');
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
    const done = wrap.querySelector('#ap-srv-done');
    if (done) done.addEventListener('click', () => {
      sfx.click();
      this._showAllServers = false;
      wrap.innerHTML = this._serverChipsHtml();
      this._bindServerChips(body);
    });
  }

  renderLog() {
    const body = this.contentArea.querySelector('#ap-body');
    if (!body) return;
    if (!this.log.length) {
      body.innerHTML = `<div class="mm-info-row mm-muted">${t('ap.empty_log')}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="ap-toolbar">
        <span class="pc-status ${this.config.enabled ? 'on' : 'off'}">${icon(this.config.enabled ? 'play' : 'stop')} ${this.config.enabled ? t('pc.on') : t('pc.off')}</span>
        <button class="mm-btn ghost small" onclick="window.antiPruneManager.refreshLog()">${icon('refresh')} ${t('common.refresh')}</button>
        <button class="mm-btn danger small" onclick="window.antiPruneManager.clearLog()">${icon('trash')} ${t('ap.clear_log')}</button>
      </div>
      <div class="ap-list">
        ${this.log.map(e => `
          <div class="ap-row ${e.ok ? 'ok' : 'fail'}">
            <div class="ap-row-icon">${icon(e.ok ? 'check' : 'x_circle')}</div>
            <img class="ap-user-av" src="${e.user.avatar}" onerror="this.src='/discord.png'">
            <div class="ap-row-meta">
              <div class="ap-row-line1">
                <strong>${this.escHtml(e.user.username)}</strong>
                <span class="mm-muted">${e.user.id}</span>
              </div>
              <div class="ap-row-line2">
                ${icon('shield')} ${this.escHtml(e.guild.name)}
                · ${t('ap.detected_by')}: <strong>${this.escHtml(e.detectedBy)}</strong>
                ${e.sentBy ? `· ${t('ap.sent_by')}: <strong>${this.escHtml(e.sentBy)}</strong>` : ''}
              </div>
              ${e.error ? `<div class="ap-error">${this.escHtml(e.error)}</div>` : ''}
              ${e.invite ? `<div class="ap-invite">${icon('mail')} <a href="${e.invite}" target="_blank">${e.invite}</a></div>` : ''}
            </div>
            <div class="ap-row-time">${this.fmtTime(e.ts)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async refreshLog() {
    sfx.click();
    const r = await fetch('/api/antiprune/log').then(x => x.json());
    if (r.success) { this.log = r.log || []; this.renderLog(); }
  }
  async clearLog() {
    if (!await showConfirm(t('ap.confirm_clear'), { confirmText: t('common.delete'), cancelText: t('common.cancel') })) return;
    sfx.click();
    await fetch('/api/antiprune/log', { method: 'DELETE' });
    this.log = []; this.renderLog();
  }

  fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
