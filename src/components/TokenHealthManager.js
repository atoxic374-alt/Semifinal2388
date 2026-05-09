// Token Health Check — pings each saved token's identity and shows status.
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';

const STATUS_META = {
  healthy:      { color: '#27ae60', ic: 'check',     label: () => t('th.s.healthy') },
  invalid:      { color: '#e03535', ic: 'x_circle',  label: () => t('th.s.invalid') },
  banned:       { color: '#e03535', ic: 'shield',    label: () => t('th.s.banned') },
  rate_limited: { color: '#e07c35', ic: 'alarm',     label: () => t('th.s.rate_limited') },
  error:        { color: '#888',    ic: 'x_circle',  label: () => t('th.s.error') },
  unchecked:    { color: '#888',    ic: 'circle_btn',label: () => t('th.s.unchecked') },
};

export class TokenHealthManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.health = {};
    this.tokens = [];
    this.checking = new Set();
    this.es = null;
  }

  async init() {
    await this.render();
    this.connectStream();
  }
  disconnect() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } }

  connectStream() {
    this.disconnect();
    try {
      this.es = new EventSource('/api/features/stream?types=token_health');
      this.es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'token_health' && d.name) {
            this.health[d.name] = d.result;
            this.checking.delete(d.name);
            (d.result?.ok ? sfx.success : sfx.fail)();
            this.renderList();
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
              <h2 class="mm-title">${t('th.title')}</h2>
              <p class="mm-subtitle">${t('th.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            <button class="mm-btn small" id="th-check-all">${icon('refresh')} ${t('th.check_all')}</button>
          </div>
        </div>
        <div class="mm-body" id="th-body"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
      </div>
    `;
    this.contentArea.querySelector('#th-check-all').addEventListener('click', async () => {
      sfx.click();
      this.tokens.forEach(tk => this.checking.add(tk.name));
      this.renderList();
      await fetch('/api/token-health/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });
    await this.load();
  }

  async load() {
    try {
      const [hr, tr] = await Promise.all([
        fetch('/api/token-health').then(x => x.json()),
        fetch('/api/tokens').then(x => x.json())
      ]);
      if (hr.success) this.health = hr.health || {};
      if (tr.success) this.tokens = tr.tokens || [];
      this.renderList();
    } catch (e) {}
  }

  renderList() {
    const body = this.contentArea.querySelector('#th-body');
    if (!body) return;
    if (!this.tokens.length) {
      body.innerHTML = `<div class="mm-info-row mm-muted">${t('th.no_tokens')}</div>`;
      return;
    }
    body.innerHTML = `<div class="th-list">${this.tokens.map(tk => this.row(tk)).join('')}</div>`;
    body.querySelectorAll('.th-row').forEach(el => {
      const name = el.dataset.name;
      el.querySelector('.th-check')?.addEventListener('click', async () => {
        sfx.click();
        this.checking.add(name);
        this.renderList();
        await fetch('/api/token-health/check', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
      });
    });
  }

  row(tk) {
    const h = this.health[tk.name];
    const checking = this.checking.has(tk.name);
    const status = h?.status || 'unchecked';
    const meta = STATUS_META[status] || STATUS_META.unchecked;
    const user = h?.user || {};
    const last = h?.checkedAt ? new Date(h.checkedAt).toLocaleString() : t('th.never');
    return `
      <div class="th-row" data-name="${this.escAttr(tk.name)}" style="--th-accent:${meta.color}">
        <div class="th-avatar">
          ${user.avatar ? `<img src="${user.avatar}" onerror="this.src='/discord.png'">` : `<div class="th-avatar-ph">${this.escHtml(tk.name.charAt(0).toUpperCase())}</div>`}
          <span class="th-pulse ${checking ? 'on' : ''}"></span>
        </div>
        <div class="th-meta">
          <div class="th-name">${this.escHtml(tk.name)} ${tk.autoConnect ? `<span class="th-tag">${t('th.auto')}</span>` : ''}</div>
          <div class="th-user">${user.displayName ? `<strong>${this.escHtml(user.displayName)}</strong> · @${this.escHtml(user.username)}` : `<em class="mm-muted">${t('th.no_data')}</em>`}</div>
          <div class="th-foot">
            <span class="th-status" style="background:${meta.color}22;color:${meta.color}">${icon(meta.ic)} ${meta.label()}</span>
            <span class="th-time">${icon('clock')} ${last}</span>
          </div>
          ${h?.error ? `<div class="th-error">${this.escHtml(h.error)}</div>` : ''}
        </div>
        <button class="mm-btn ghost small th-check" ${checking ? 'disabled' : ''}>
          ${checking ? `<span class="th-spin"></span>` : icon('refresh')} ${checking ? t('th.checking') : t('th.check')}
        </button>
      </div>
    `;
  }

  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
