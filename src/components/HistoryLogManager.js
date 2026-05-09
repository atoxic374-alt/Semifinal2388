// History Log — persistent log of all actions (sends, schedules, clones, etc.) with live updates.
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';
import { showConfirm } from '../utils/ui.js';

const TYPE_META = {
  send:               { ic: 'send',    color: '#5865f2', label: () => t('fl.t.send') },
  schedule:           { ic: 'clock',   color: '#e07c35', label: () => t('fl.t.schedule') },
  schedule_run:       { ic: 'play',    color: '#27ae60', label: () => t('fl.t.schedule_run') },
  clone_paste:        { ic: 'copy',    color: '#a855f7', label: () => t('fl.t.clone_paste') },
  clone_build_server: { ic: 'shield',  color: '#06b6d4', label: () => t('fl.t.clone_build') },
  clone_messages:     { ic: 'message', color: '#a855f7', label: () => t('fl.t.clone_messages') },
  connect:            { ic: 'check',   color: '#27ae60', label: () => t('fl.t.connect') },
  disconnect:         { ic: 'x',       color: '#888888', label: () => t('fl.t.disconnect') },
  save_token:         { ic: 'archive', color: '#3a8fd1', label: () => t('fl.t.save_token') },
  delete_token:       { ic: 'trash',   color: '#e03535', label: () => t('fl.t.delete_token') },
};

const STATUS_COLOR = {
  success: '#27ae60', partial: '#e07c35', failed: '#e03535', pending: '#3a8fd1'
};

export class HistoryLogManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.entries = [];
    this.accounts = {};
    this.filter = { account: '', type: '', status: '', q: '' };
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
      this.es = new EventSource('/api/features/stream?types=history');
      this.es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'history' && d.entry) {
            this.entries.unshift(d.entry);
            if (this.entries.length > 500) this.entries.length = 500;
            sfx.pop();
            this.renderTable();
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
            <span class="mm-icon">${icon('scroll')}</span>
            <div>
              <h2 class="mm-title">${t('fl.title')}</h2>
              <p class="mm-subtitle">${t('fl.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="fl-toolbar">
            <select id="fl-acct" class="fl-select"><option value="">${t('fl.all_accounts')}</option></select>
            <select id="fl-type" class="fl-select">
              <option value="">${t('fl.all_types')}</option>
              <option value="send">${t('fl.t.send')}</option>
              <option value="schedule">${t('fl.t.schedule')}</option>
              <option value="schedule_run">${t('fl.t.schedule_run')}</option>
              <option value="clone_paste">${t('fl.t.clone_paste')}</option>
              <option value="clone_build_server">${t('fl.t.clone_build')}</option>
            </select>
            <select id="fl-status" class="fl-select">
              <option value="">${t('fl.all_status')}</option>
              <option value="success">${t('fl.s.success')}</option>
              <option value="partial">${t('fl.s.partial')}</option>
              <option value="failed">${t('fl.s.failed')}</option>
              <option value="pending">${t('fl.s.pending')}</option>
            </select>
            <input type="text" id="fl-search" class="fl-search" placeholder="${t('fl.search_ph')}">
            <button class="mm-btn ghost small" id="fl-refresh">${icon('refresh')} ${t('common.refresh')}</button>
            <button class="mm-btn danger small" id="fl-clear">${icon('trash')} ${t('fl.clear')}</button>
          </div>
        </div>
        <div class="mm-body" id="fl-body"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
      </div>
    `;
    const root = this.contentArea;
    root.querySelector('#fl-refresh').addEventListener('click', () => { sfx.click(); this.load(); });
    root.querySelector('#fl-clear').addEventListener('click', async () => {
      if (!await showConfirm(t('fl.confirm_clear'), { confirmText: t('common.delete'), cancelText: t('common.cancel') })) return;
      sfx.click();
      await fetch('/api/history-log', { method: 'DELETE' });
      this.entries = []; this.renderTable();
    });
    root.querySelector('#fl-acct').addEventListener('change', (e) => { this.filter.account = e.target.value; this.renderTable(); });
    root.querySelector('#fl-type').addEventListener('change', (e) => { this.filter.type = e.target.value; this.renderTable(); });
    root.querySelector('#fl-status').addEventListener('change', (e) => { this.filter.status = e.target.value; this.renderTable(); });
    root.querySelector('#fl-search').addEventListener('input', (e) => { this.filter.q = e.target.value.toLowerCase(); this.renderTable(); });
    await this.load();
  }

  async load() {
    try {
      const r = await fetch('/api/history-log').then(x => x.json());
      if (r.success) {
        this.entries = r.history || [];
        this.accounts = r.accounts || {};
        this.populateAccountSelect();
        this.renderTable();
      }
    } catch (e) {}
  }

  populateAccountSelect() {
    const sel = this.contentArea.querySelector('#fl-acct');
    if (!sel) return;
    const cur = this.filter.account;
    const set = new Set(Object.keys(this.accounts));
    this.entries.forEach(e => set.add(e.account));
    sel.innerHTML = `<option value="">${t('fl.all_accounts')}</option>` +
      Array.from(set).map(n => `<option value="${this.escAttr(n)}" ${n === cur ? 'selected' : ''}>${this.escHtml(n)}</option>`).join('');
  }

  filtered() {
    const f = this.filter;
    return this.entries.filter(e => {
      if (f.account && e.account !== f.account) return false;
      if (f.type && e.type !== f.type) return false;
      if (f.status && e.status !== f.status) return false;
      if (f.q) {
        if (!JSON.stringify(e).toLowerCase().includes(f.q)) return false;
      }
      return true;
    });
  }

  renderTable() {
    const body = this.contentArea.querySelector('#fl-body');
    if (!body) return;
    const items = this.filtered();
    if (!items.length) {
      body.innerHTML = `<div class="mm-info-row mm-muted">${t('fl.empty')}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="fl-list">
        ${items.map(e => this.row(e)).join('')}
      </div>
    `;
  }

  row(e) {
    const meta = TYPE_META[e.type] || { ic: 'circle_btn', color: '#888', label: () => e.type };
    const acct = this.accounts[e.account];
    const avatar = acct?.avatar || '/discord.png';
    const sColor = STATUS_COLOR[e.status] || '#888';
    const target = this.targetText(e);
    return `
      <div class="fl-row" style="--fl-accent:${meta.color}">
        <div class="fl-row-icon" style="background:${meta.color}22;color:${meta.color}">${icon(meta.ic)}</div>
        <div class="fl-row-meta">
          <div class="fl-row-line1">
            <strong>${meta.label()}</strong>
            <span class="fl-acct"><img src="${avatar}" onerror="this.style.display='none'">${this.escHtml(e.account || '?')}</span>
            <span class="fl-status" style="background:${sColor}22;color:${sColor}">${t('fl.s.' + (e.status || 'unknown')) || e.status}</span>
          </div>
          <div class="fl-row-line2">
            ${target}
            ${e.messages != null ? `<span class="fl-chip">${icon('message')} ${e.messages}</span>` : ''}
            ${e.channels != null ? `<span class="fl-chip">${icon('hash')} ${e.channels}</span>` : ''}
            ${e.ok != null ? `<span class="fl-chip success">${icon('check')} ${e.ok}</span>` : ''}
            ${e.fail ? `<span class="fl-chip danger">${icon('x')} ${e.fail}</span>` : ''}
            ${e.error ? `<span class="fl-error" title="${this.escAttr(e.error)}">${icon('x_circle')} ${this.escHtml(String(e.error).slice(0, 60))}</span>` : ''}
          </div>
        </div>
        <div class="fl-row-time">${this.fmtTime(e.ts)}</div>
      </div>
    `;
  }

  targetText(e) {
    const tgt = e.target || {};
    let label = '';
    if (tgt.kind === 'webhook') label = t('fl.tgt_webhook');
    else if (tgt.type === 'channel') label = t('fl.tgt_channels') + ` (${(tgt.channelIds || []).length})`;
    else if (tgt.type === 'all_channels') label = t('fl.tgt_all_channels');
    else if (tgt.type === 'all_dms') label = t('fl.tgt_all_dms');
    else if (tgt.type === 'all_groups') label = t('fl.tgt_all_groups');
    else if (tgt.id) label = `${t('fl.tgt_server')}: ${tgt.id}`;
    else label = JSON.stringify(tgt).slice(0, 40);
    return `<span class="fl-target">${icon('target')} ${this.escHtml(label)}</span>`;
  }

  fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
