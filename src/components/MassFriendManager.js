// MassFriendManager — bulk add/remove friends from a server with filters and rate-limiting.
// All operations run as background tasks (taskBar.js shows live progress).
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification, showConfirm } from '../utils/ui.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';

export class MassFriendManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.servers = [];
    this.selectedServer = '';
    this.members = [];
    this.totalMembers = 0;
    this.filter = { excludeBots: true, usernameContains: '' };
    this.throttleMs = 7000;
    this.max = 50;
    this.tab = 'add';   // 'add' | 'remove'
    this.removeMode = 'server';  // 'all' | 'server' | 'ids'
    this.idsText = '';
    this.loading = false;
  }

  async init() { await this.render(); await this.loadServers(); }
  async refresh() { await this.render(); }

  async loadServers() {
    try {
      const url = '/api/discord/servers' + (this.account ? `?account=${encodeURIComponent(this.account)}` : '');
      const r = await fetch(url).then(x => x.json());
      this.servers = r.servers || [];
      const sel = this.contentArea.querySelector('#mf-server');
      if (sel) sel.innerHTML = `<option value="">${t('mf.choose_server')}</option>` +
        this.servers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    } catch (e) { showNotification(String(e.message || e), 'error'); }
  }

  async loadMembers() {
    if (!this.selectedServer) return;
    this.loading = true; this.renderMembers();
    try {
      const url = `/api/discord/servers/${this.selectedServer}/members` + (this.account ? `?account=${encodeURIComponent(this.account)}` : '');
      const r = await fetch(url).then(x => x.json());
      if (!r.success) { showNotification(r.error || 'Failed', 'error'); this.members = []; this.totalMembers = 0; }
      else { this.members = r.members || []; this.totalMembers = r.total || this.members.length; }
    } catch (e) { showNotification(String(e.message || e), 'error'); }
    this.loading = false; this.renderMembers();
  }

  filteredMembers() {
    return this.members.filter(m => {
      if (this.filter.excludeBots && m.bot) return false;
      if (this.filter.usernameContains) {
        const q = this.filter.usernameContains.toLowerCase();
        if (!(m.username || '').toLowerCase().includes(q) &&
            !(m.displayName || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  renderMembers() {
    const list = this.contentArea.querySelector('#mf-members');
    if (!list) return;
    if (this.loading) { list.innerHTML = `<div class="mf-loading"><div class="lux-spinner"></div></div>`; return; }
    const arr = this.filteredMembers();
    const counter = this.contentArea.querySelector('#mf-counter');
    if (counter) counter.textContent = `${arr.length} / ${this.members.length} ${t('mf.shown')}  ·  ${this.totalMembers} ${t('mf.total')}`;
    list.innerHTML = arr.slice(0, 200).map(m => `
      <div class="mf-member ${m.bot ? 'bot' : ''}">
        <img src="${escapeAttr(m.avatar)}" alt="">
        <div class="mf-m-info">
          <div class="mf-m-name">${escapeHtml(m.displayName)} ${m.bot ? '<span class="mf-bot">BOT</span>' : ''}</div>
          <div class="mf-m-sub">@${escapeHtml(m.username)} · ${m.id}</div>
        </div>
      </div>`).join('');
    if (arr.length > 200) list.insertAdjacentHTML('beforeend', `<div class="mf-trim">${t('mf.trimmed_to_200')}</div>`);
  }

  async render() {
    const acctPick = await buildAccountPicker({ selectId: 'mf-acct', selected: this.account });
    this.contentArea.innerHTML = `
      <div class="mf-wrap">
        <div class="mf-head">
          <h1>${icon('users')} ${t('mf.title')}</h1>
          <p>${t('mf.subtitle')}</p>
        </div>

        <div class="mf-tabs">
          <button class="mf-tab ${this.tab==='add'?'active':''}" data-tab="add">${t('mf.tab_add')}</button>
          <button class="mf-tab ${this.tab==='remove'?'active':''}" data-tab="remove">${t('mf.tab_remove')}</button>
        </div>

        <div class="mf-controls">
          <div class="mf-acct">${acctPick.html}</div>
          ${this.tab === 'add' ? `
            <select id="mf-server"><option value="">${t('mf.choose_server')}</option></select>
            <input type="text" id="mf-filter-name" placeholder="${t('mf.filter_username')}" value="${escapeAttr(this.filter.usernameContains)}">
            <label class="mf-chk"><input type="checkbox" id="mf-no-bots" ${this.filter.excludeBots ? 'checked' : ''}><span>${t('mf.exclude_bots')}</span></label>
            <label class="mf-num">${t('mf.max')} <input type="number" id="mf-max" min="1" max="500" value="${this.max}"></label>
            <label class="mf-num">${t('mf.delay_ms')} <input type="number" id="mf-throttle" min="3000" max="60000" step="500" value="${this.throttleMs}"></label>
          ` : `
            <select id="mf-rmode">
              <option value="server"${this.removeMode==='server'?' selected':''}>${t('mf.rmode_server')}</option>
              <option value="all"${this.removeMode==='all'?' selected':''}>${t('mf.rmode_all')}</option>
              <option value="ids"${this.removeMode==='ids'?' selected':''}>${t('mf.rmode_ids')}</option>
            </select>
            <select id="mf-server" ${this.removeMode==='server'?'':'disabled'}><option value="">${t('mf.choose_server')}</option></select>
            <input type="text" id="mf-filter-name" placeholder="${t('mf.filter_username')}" value="${escapeAttr(this.filter.usernameContains)}">
            <label class="mf-chk"><input type="checkbox" id="mf-no-bots" ${this.filter.excludeBots ? 'checked' : ''}><span>${t('mf.exclude_bots')}</span></label>
            <label class="mf-num">${t('mf.delay_ms')} <input type="number" id="mf-throttle" min="2000" max="60000" step="500" value="${this.throttleMs}"></label>
          `}
        </div>

        ${this.tab === 'remove' && this.removeMode === 'ids' ? `
          <textarea id="mf-ids" placeholder="${t('mf.ids_placeholder')}" rows="4">${escapeHtml(this.idsText)}</textarea>
        ` : ''}

        <div class="mf-warn">⚠ ${t('mf.warning')}</div>

        <div class="mf-actions">
          ${this.tab === 'add' ? `
            <button id="mf-preview" class="mf-btn-secondary">${icon('refresh')} ${t('mf.preview_members')}</button>
            <button id="mf-go-add" class="mf-btn-primary">${icon('rocket')} ${t('mf.start_add')}</button>
          ` : `
            <button id="mf-go-remove" class="mf-btn-danger">${icon('trash')} ${t('mf.start_remove')}</button>
          `}
        </div>

        ${this.tab === 'add' ? `
          <div class="mf-counter" id="mf-counter"></div>
          <div class="mf-members" id="mf-members"></div>
        ` : `
          <div class="mf-tip">${t('mf.remove_tip')}</div>
        `}
      </div>
    `;

    acctPick.bind?.(this.contentArea);
    const acctSel = this.contentArea.querySelector('#mf-acct');
    acctSel?.addEventListener('change', () => { this.account = acctSel.value || null; this.loadServers(); });

    this.contentArea.querySelectorAll('.mf-tab').forEach(b => b.addEventListener('click', () => { this.tab = b.dataset.tab; this.render(); }));

    const sSel = this.contentArea.querySelector('#mf-server');
    sSel?.addEventListener('change', () => { this.selectedServer = sSel.value; });
    const rmode = this.contentArea.querySelector('#mf-rmode');
    rmode?.addEventListener('change', () => { this.removeMode = rmode.value; this.render(); });

    this.contentArea.querySelector('#mf-filter-name')?.addEventListener('input', e => { this.filter.usernameContains = e.target.value; this.renderMembers(); });
    this.contentArea.querySelector('#mf-no-bots')?.addEventListener('change', e => { this.filter.excludeBots = e.target.checked; this.renderMembers(); });
    this.contentArea.querySelector('#mf-max')?.addEventListener('input', e => { this.max = parseInt(e.target.value, 10) || 50; });
    this.contentArea.querySelector('#mf-throttle')?.addEventListener('input', e => { this.throttleMs = parseInt(e.target.value, 10) || 7000; });
    this.contentArea.querySelector('#mf-ids')?.addEventListener('input', e => { this.idsText = e.target.value; });

    this.contentArea.querySelector('#mf-preview')?.addEventListener('click', () => this.loadMembers());
    this.contentArea.querySelector('#mf-go-add')?.addEventListener('click', () => this.startAdd());
    this.contentArea.querySelector('#mf-go-remove')?.addEventListener('click', () => this.startRemove());

    if (!this.servers.length) await this.loadServers();
    else if (sSel) sSel.innerHTML = `<option value="">${t('mf.choose_server')}</option>` +
        this.servers.map(s => `<option value="${s.id}"${s.id===this.selectedServer?' selected':''}>${escapeHtml(s.name)}</option>`).join('');
  }

  async startAdd() {
    if (!this.selectedServer) { showNotification(t('mf.need_server'), 'error'); return; }
    if (!await showConfirm(t('mf.confirm_add'), { confirmText: t('common.confirm') || 'OK', cancelText: t('common.cancel') })) return;
    sfx.click();
    try {
      const body = {
        account: this.account || undefined,
        serverId: this.selectedServer,
        filter: { excludeBots: !!this.filter.excludeBots, usernameContains: this.filter.usernameContains || undefined },
        throttleMs: this.throttleMs,
        max: this.max
      };
      const r = await fetch('/api/friends/bulk-add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
      if (!r.success) { showNotification(r.error || 'Failed', 'error'); return; }
      showNotification(t('mf.task_started'), 'success');
      sfx.ding?.();
    } catch (e) { showNotification(String(e.message || e), 'error'); }
  }

  async startRemove() {
    if (!await showConfirm(t('mf.confirm_remove'), { confirmText: t('common.delete'), cancelText: t('common.cancel') })) return;
    sfx.click();
    try {
      const ids = this.removeMode === 'ids'
        ? this.idsText.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean)
        : [];
      if (this.removeMode === 'ids' && !ids.length) { showNotification(t('mf.need_ids'), 'error'); return; }
      if (this.removeMode === 'server' && !this.selectedServer) { showNotification(t('mf.need_server'), 'error'); return; }
      const body = {
        account: this.account || undefined,
        mode: this.removeMode,
        serverId: this.removeMode === 'server' ? this.selectedServer : undefined,
        ids: this.removeMode === 'ids' ? ids : undefined,
        filter: { excludeBots: !!this.filter.excludeBots, usernameContains: this.filter.usernameContains || undefined },
        throttleMs: this.throttleMs
      };
      const r = await fetch('/api/friends/bulk-remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
      if (!r.success) { showNotification(r.error || 'Failed', 'error'); return; }
      showNotification(t('mf.task_started'), 'success');
      sfx.ding?.();
    } catch (e) { showNotification(String(e.message || e), 'error'); }
  }
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
