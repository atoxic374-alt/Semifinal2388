// Server Lookup — inspect any guild by ID (joined or public preview).
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class LookupManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.serverId = '';
    this.result = null;
    this.loading = false;
  }

  async init() { await this.render(); }
  async refresh() { await this.render(); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('search')}</span>
            <div>
              <h2 class="mm-title">${t('lk.title')}</h2>
              <p class="mm-subtitle">${t('lk.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="lk-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="lk-form">
            <input type="text" id="lk-input" placeholder="${t('lk.input_ph')}" value="${this.escAttr(this.serverId)}">
            <button onclick="window.lookupManager.lookup()">${icon('search')} ${t('lk.lookup')}</button>
          </div>
          <div id="lk-result">${this.renderResult()}</div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#lk-toolbar');
    const picker = await buildAccountPicker({ selectId: 'lk-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; });

    const input = this.contentArea.querySelector('#lk-input');
    input?.addEventListener('input', (e) => { this.serverId = e.target.value; });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.lookup(); });
  }

  async lookup() {
    if (this.loading) return;
    const id = (this.serverId || '').trim();
    if (!id) return;
    this.loading = true;
    const out = this.contentArea.querySelector('#lk-result');
    if (out) out.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const url = `/api/lookup/server/${encodeURIComponent(id)}` + (this.account ? `?account=${encodeURIComponent(this.account)}` : '');
      const res = await fetch(url);
      const r = await res.json();
      if (!r.success) {
        this.result = null;
        if (out) out.innerHTML = `<div class="mm-info-row mm-muted">${t('lk.fail')}: ${this.escHtml(r.error || '')}</div>`;
        return;
      }
      this.result = r;
      if (out) out.innerHTML = this.renderResult();
    } catch (e) {
      if (out) out.innerHTML = `<div class="mm-info-row mm-muted">${t('lk.fail')}: ${this.escHtml(e.message)}</div>`;
    } finally { this.loading = false; }
  }

  copyId(id) { copyToClipboard(id); }

  renderResult() {
    if (!this.result) return `<div class="mm-info-row mm-muted">${t('lk.empty')}</div>`;
    const { joined, server } = this.result;
    const initial = (server.name || '?').charAt(0).toUpperCase();
    const features = (server.features || []).slice(0, 18);
    return `
      <div class="lk-result">
        <div class="lk-banner">${server.banner ? `<img src="${server.banner}" alt="">` : ''}</div>
        <div class="lk-result-head">
          <div class="lk-icon">${server.icon ? `<img src="${server.icon}" alt="">` : this.escHtml(initial)}</div>
          <div class="lk-headmeta">
            <div class="lk-name">
              ${this.escHtml(server.name)}
              <span class="lk-pill ${joined ? 'yes' : 'no'}">${icon(joined ? 'check' : 'circle_dot')} ${joined ? t('lk.joined_yes') : t('lk.joined_no')}</span>
            </div>
            <div class="lk-id">${server.id} · <a href="#" onclick="window.lookupManager.copyId('${server.id}');return false;">${t('lk.copy')}</a></div>
          </div>
        </div>

        <div class="lk-grid">
          ${this.stat(t('lk.members'), this.fmtNum(server.members))}
          ${joined ? this.stat(t('lk.boosts'), `${server.boosts || 0} (Tier ${server.tier || 0})`) : ''}
          ${!joined && server.online != null ? this.stat(t('lk.online'), this.fmtNum(server.online)) : ''}
          ${server.createdAt ? this.stat(t('lk.created'), new Date(server.createdAt).toLocaleDateString()) : ''}
          ${joined && server.ownerName ? this.stat(t('lk.owner'), this.escHtml(server.ownerName)) : ''}
          ${joined ? this.stat(t('lk.your_roles'), server.myRoles || 0) : ''}
          ${joined && server.myJoinedAt ? this.stat(t('lk.your_join'), new Date(server.myJoinedAt).toLocaleDateString()) : ''}
        </div>

        ${joined ? `
          <div class="lk-channels">
            <div>
              <h4>${icon('hash')} ${t('lk.text_channels')}</h4>
              <div class="lk-stat-value">${server.totalText} <span style="font-size:11px;color:var(--text-secondary);font-weight:400">(${server.visibleText} ${t('lk.visible')})</span></div>
            </div>
            <div>
              <h4>${icon('volume')} ${t('lk.voice_channels')}</h4>
              <div class="lk-stat-value">${server.totalVoice}</div>
            </div>
          </div>
        ` : (server.description ? `<div style="padding:0 16px 12px;color:var(--text-secondary);font-size:13px">${this.escHtml(server.description)}</div>` : '')}

        ${features.length ? `
          <div style="padding:0 16px 8px;color:var(--text-secondary);font-size:12px;font-weight:600">${t('lk.features')}</div>
          <div class="lk-features">
            ${features.map(f => `<span class="lk-feature">${this.escHtml(f)}</span>`).join('')}
          </div>` : ''
        }
      </div>
    `;
  }

  stat(label, value) {
    return `<div class="lk-stat"><div class="lk-stat-label">${label}</div><div class="lk-stat-value">${value}</div></div>`;
  }

  fmtNum(n) {
    if (!n && n !== 0) return '—';
    if (n > 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n > 1000)    return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
