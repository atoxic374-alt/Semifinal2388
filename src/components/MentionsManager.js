// Mentions Tracker — captures every @mention/ID-mention in real time.
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';
import { showConfirm } from '../utils/ui.js';

export class MentionsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.mentions = [];
    this.accounts = {};
    this.account = null;
    this.allAccounts = true;
    this.es = null;
    this._clearBusy = false;
    this._loadBusy = false;
  }

  async init() {
    await this.render();
    this.connectStream();
  }
  disconnect() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } }

  connectStream() {
    this.disconnect();
    try {
      this.es = new EventSource('/api/features/stream?types=mention,mention_deleted');
      this.es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === 'mention' && d.mention) {
            if (!this.allAccounts && this.account && d.account !== this.account) return;
            this.mentions.unshift(d.mention);
            if (this.mentions.length > 200) this.mentions.length = 200;
            sfx.notify();
            this.renderList();
          } else if (d.type === 'mention_deleted') {
            const it = this.mentions.find(m => m.id === d.id);
            if (it) { it.deleted = true; this.renderList(); }
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
            <span class="mm-icon">${icon('bell')}</span>
            <div>
              <h2 class="mm-title">${t('mt.title')}</h2>
              <p class="mm-subtitle">${t('mt.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="mt-toolbar"></div>
        </div>
        <div class="mm-body" id="mt-body"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
      </div>
    `;
    const toolbar = this.contentArea.querySelector('#mt-toolbar');
    const picker = await buildAccountPicker({ selectId: 'mt-acct', selected: this.account });
    toolbar.innerHTML = `
      <label class="toggle-pill ${this.allAccounts ? 'on' : ''}" id="mt-all">
        ${icon('users')} <span>${t('mt.all_accounts')}</span>
      </label>
      ${picker.html}
      <button class="mm-btn ghost small" id="mt-refresh">${icon('refresh')} ${t('common.refresh')}</button>
      <button class="mm-btn danger small" id="mt-clear">${icon('trash')} ${t('mt.clear')}</button>
    `;
    picker.bind(toolbar, (val) => { this.account = val; this.allAccounts = false; toolbar.querySelector('#mt-all').classList.remove('on'); this.load(); });
    toolbar.querySelector('#mt-all').addEventListener('click', () => {
      this.allAccounts = !this.allAccounts;
      toolbar.querySelector('#mt-all').classList.toggle('on', this.allAccounts);
      this.load();
    });
    toolbar.querySelector('#mt-refresh').addEventListener('click', async () => {
      if (this._loadBusy) return;
      this._loadBusy = true;
      sfx.click();
      try { await this.load(); } finally { this._loadBusy = false; }
    });
    toolbar.querySelector('#mt-clear').addEventListener('click', async () => {
      if (this._clearBusy) return;
      if (!await showConfirm(t('mt.confirm_clear'), { confirmText: t('common.delete'), cancelText: t('common.cancel') })) return;
      this._clearBusy = true;
      sfx.click();
      try {
        await fetch('/api/mentions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: this.allAccounts ? null : this.account }) });
        this.mentions = []; this.renderList();
      } catch (e) {}
      finally { this._clearBusy = false; }
    });
    await this.load();
  }

  async load() {
    try {
      const q = new URLSearchParams();
      if (this.allAccounts) q.set('all', '1');
      else if (this.account) q.set('account', this.account);
      const r = await fetch('/api/mentions' + (q.toString() ? `?${q}` : '')).then(x => x.json());
      if (r.success) {
        this.mentions = r.mentions || [];
        this.accounts = r.accounts || {};
        this.renderList();
      }
    } catch (e) {}
  }

  renderList() {
    const body = this.contentArea.querySelector('#mt-body');
    if (!body) return;
    if (!this.mentions.length) {
      body.innerHTML = `<div class="mm-info-row mm-muted">${t('mt.empty')}</div>`;
      return;
    }
    body.innerHTML = `<div class="mt-list">${this.mentions.map(m => this.row(m)).join('')}</div>`;
  }

  row(m) {
    const acct = this.accounts[m.account] || {};
    const where = m.guildName
      ? `${m.guildIcon ? `<img src="${m.guildIcon}" class="mt-where-ic">` : icon('shield')} ${this.escHtml(m.guildName)} · #${this.escHtml(m.channelName)}`
      : `${icon('message')} ${m.channelType === 'DM' ? t('mt.in_dm') : '#' + this.escHtml(m.channelName)}`;
    const atts = (m.attachments || []).slice(0, 3).map(a => `<a class="mt-att" href="${a.url}" target="_blank" rel="noopener">${icon('image')} ${this.escHtml(a.name)}</a>`).join('');
    return `
      <div class="mt-row ${m.deleted ? 'deleted' : ''}">
        <div class="mt-acct"><img src="${acct.avatar || '/discord.png'}" onerror="this.src='/discord.png'" title="${this.escAttr(m.account)}"></div>
        <div class="mt-avatar"><img src="${m.author.avatar}" onerror="this.src='/discord.png'"></div>
        <div class="mt-meta">
          <div class="mt-line1">
            <strong>${this.escHtml(m.author.displayName)}</strong>
            <span class="mt-handle">@${this.escHtml(m.author.username)}</span>
            ${m.author.bot ? `<span class="pm-bot-tag">${icon('bot')} BOT</span>` : ''}
            <span class="mt-time">${this.fmtTime(m.ts)}</span>
          </div>
          <div class="mt-where">${where}</div>
          ${m.content ? `<div class="mt-content ${m.deleted ? 'strike' : ''}">${this.escHtml(m.content)}</div>` : ''}
          ${atts ? `<div class="mt-atts">${atts}</div>` : ''}
          ${m.deleted ? `<div class="mt-deleted">${icon('trash')} ${t('mt.deleted')}</div>` : ''}
          <div class="mt-actions">
            <button class="mm-btn ghost small" onclick="navigator.clipboard.writeText('${m.author.id}');window.sfx?.click()">${icon('copy')} ${t('mt.copy_id')}</button>
            <button class="mm-btn ghost small" onclick="navigator.clipboard.writeText('${m.id}');window.sfx?.click()">${icon('copy')} ${t('mt.copy_msg_id')}</button>
          </div>
        </div>
      </div>
    `;
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
