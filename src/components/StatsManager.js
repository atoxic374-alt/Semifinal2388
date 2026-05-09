// Stats Dashboard — quick analytics across the active account.
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class StatsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.stats = null;
    this.loading = false;
  }

  async init() { await this.render(); }
  async refresh() { await this.render(); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('bar_chart')}</span>
            <div>
              <h2 class="mm-title">${t('st.title')}</h2>
              <p class="mm-subtitle">${t('st.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="st-toolbar"></div>
        </div>
        <div class="mm-body" id="st-body">
          <div class="mm-info-row mm-muted">${t('common.loading')}</div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#st-toolbar');
    const picker = await buildAccountPicker({ selectId: 'st-acct', selected: this.account });
    toolbar.innerHTML = `
      ${picker.html}
      <button class="mm-btn ghost small" onclick="window.statsManager.load()">${icon('refresh')} ${t('st.refresh')}</button>
    `;
    picker.bind(toolbar, (val) => { this.account = val; this.load(); });

    await this.load();
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    const body = this.contentArea.querySelector('#st-body');
    if (body) body.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      // The backend uses ?account=… via pickClient; we rely on accountAware api wrapper if present.
      const url = '/api/stats/summary' + (this.account ? `?account=${encodeURIComponent(this.account)}` : '');
      const res = await fetch(url);
      const r = await res.json();
      if (!r.success) {
        body.innerHTML = `<div class="mm-info-row mm-muted">${this.escHtml(r.error || t('common.failed_load'))}</div>`;
        return;
      }
      this.stats = r.stats;
      this.renderStats();
    } catch (e) {
      body.innerHTML = `<div class="mm-info-row mm-muted">${this.escHtml(e.message)}</div>`;
    } finally { this.loading = false; }
  }

  card(ic, value, label) {
    return `
      <div class="st-card">
        <div class="st-card-icon">${icon(ic)}</div>
        <div class="st-card-meta">
          <div class="st-card-value">${value ?? 0}</div>
          <div class="st-card-label">${label}</div>
        </div>
      </div>
    `;
  }

  renderStats() {
    const s = this.stats;
    const body = this.contentArea.querySelector('#st-body');
    if (!body || !s) return;
    body.innerHTML = `
      <div class="st-grid">
        ${this.card('user',      s.username || '—',          t('st.account'))}
        ${this.card('users',     s.accounts,                  t('st.accounts_total'))}
        ${this.card('circle_dot',s.connected,                 t('st.accounts_connected'))}
        ${this.card('shield',    s.servers,                   t('st.servers'))}
        ${this.card('crown',     s.ownedServers,              t('st.owned'))}
        ${this.card('trending',  this.fmtNum(s.members),      t('st.members'))}
        ${this.card('message',   s.dms,                       t('st.dms'))}
        ${this.card('bot',       s.botDMs,                    t('st.dms_bots'))}
        ${this.card('user',      s.humanDMs,                  t('st.dms_humans'))}
        ${this.card('users',     s.groups,                    t('st.groups'))}
      </div>
      <div class="st-recent">
        <h3>${icon('bell')} ${t('st.recent_dms')}</h3>
        <div class="st-recent-list">
          ${(s.topDMs || []).length === 0
            ? `<div class="st-empty">${t('st.no_recent')}</div>`
            : s.topDMs.map(d => `
                <div class="st-recent-row">
                  <div class="pm-list-avatar"><img src="${d.avatar}" alt="" onerror="this.src='/discord.png'"></div>
                  <div class="st-recent-meta">
                    <div class="st-recent-from">@${this.escHtml(d.username)}${d.unread ? ` <span class="pm-unread-dot" style="position:static;display:inline-flex">${d.unread > 9 ? '9+' : d.unread}</span>` : ''}</div>
                    <div class="st-recent-acct">${this.escHtml(s.accountName || '')}</div>
                  </div>
                  <div class="st-recent-time">${this.fmtTime(d.ts)}</div>
                </div>
              `).join('')
          }
        </div>
      </div>
    `;
  }

  fmtNum(n) {
    if (!n) return '0';
    if (n > 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n > 1000)    return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
}
