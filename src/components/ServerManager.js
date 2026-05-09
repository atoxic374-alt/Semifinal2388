import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, showConfirm } from '../utils/ui.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { openOperationLog } from '../utils/operationLog.js';
import { markBusy, clearBusy, isBusy } from '../utils/dupGuard.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

/**
 * ServerManager v2 — same hardening as DMManager:
 *  - Per-(action, id) inflight Map (mute, leave).
 *  - Global busy lock for bulk runs.
 *  - All operations report through OperationLog; the legacy progress modal
 *    is gone, so leaving 200 servers no longer freezes the UI.
 *  - Confirms for destructive paths.
 *  - Selection / scroll preservation across refresh.
 */
export class ServerManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.filter = '';
    this.allServers = [];
    this._inflight = new Map();
    this._globalBusy = false;
    this._selected = new Set();
  }

  async refreshServersList() { await this.loadList({ keepSelection: true }); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('shield')}</span>
            <div>
              <h2 class="mm-title">${this._esc(t('sv.title'))}</h2>
              <p class="mm-subtitle">${this._esc(t('sv.subtitle'))}</p>
            </div>
          </div>
          <div class="mm-tabs" id="sv-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <input type="text" id="sv-filter" class="list-filter-input"
                   placeholder="${this._esc(t('common.filter'))}"
                   value="${this._escAttr(this.filter)}">
            <button id="sv-refresh-btn" type="button" class="secondary-btn">${icon('refresh') || '↻'} ${this._esc(t('sv.refresh'))}</button>
            <button id="selectAllServersBtn" type="button">${this._esc(t('sv.select_all'))}</button>
            <button id="leaveSelectedServersBtn" type="button" class="danger-btn" disabled>${this._esc(t('sv.leave_selected'))}</button>
            <button id="muteSelectedServersBtn" type="button" class="warning-btn" disabled>${this._esc(t('sv.mute_selected'))}</button>
            <button id="readAllBtn" type="button" class="success-btn">${icon('check')} ${this._esc(t('sv.read_all'))}</button>
          </div>
          <div id="serversList"><div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div></div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#sv-toolbar');
    const picker = await buildAccountPicker({ selectId: 'sv-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; this._selected.clear(); this.loadList(); });

    const $ = (sel) => this.contentArea.querySelector(sel);
    $('#sv-filter').addEventListener('input', (e) => { this.filter = e.target.value; this._applyFilter(); });
    $('#sv-refresh-btn').addEventListener('click', () => this.refreshServersList());
    $('#selectAllServersBtn').addEventListener('click', () => this.toggleSelectAllServers());
    $('#leaveSelectedServersBtn').addEventListener('click', () => this.leaveSelectedServers());
    $('#muteSelectedServersBtn').addEventListener('click', () => this.muteSelectedServers());
    $('#readAllBtn').addEventListener('click', () => this.readAll());

    await this.loadList();
  }

  _applyFilter() {
    const q = (this.filter || '').toLowerCase();
    this.contentArea.querySelectorAll('#serversList .list-item').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    const count = this.allServers.filter(s => !q || s.name.toLowerCase().includes(q)).length;
    const counter = this.contentArea.querySelector('#sv-counter');
    if (counter) counter.textContent = `${count} / ${this.allServers.length}`;
  }

  async loadList({ keepSelection = false } = {}) {
    const list = this.contentArea.querySelector('#serversList');
    if (!list) return;
    if (!keepSelection) this._selected = this._collectSelectedIds();
    const prevScroll = list.scrollTop;
    list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div>`;
    try {
      const servers = await getServersList(this.account);
      this.allServers = servers;
      if (!servers.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('sv.empty'))}</div>`;
        return;
      }
      const counter = `<div class="list-counter" id="sv-counter">${servers.length} / ${servers.length}</div>`;
      list.innerHTML = counter + servers.map(s => this._renderRow(s)).join('');
      this._wireRowEvents(list);
      this._restoreSelection();
      this._applyFilter();
      this.updateSelectedServersCount();
      list.scrollTop = prevScroll;
    } catch (e) {
      list.innerHTML = `<p class="error">${this._esc(t('sv.failed'))}</p>`;
    }
  }

  _renderRow(s) {
    const checked = this._selected.has(s.id) ? 'checked' : '';
    const memberLine = s.members ? `${s.members.toLocaleString()} ${this._esc(t('sv.members'))}` : '';
    return `
      <div class="list-item" data-id="${this._escAttr(s.id)}" data-name="${this._escAttr(s.name)}">
        <div class="list-item-left">
          <input type="checkbox" class="server-checkbox" data-id="${this._escAttr(s.id)}" ${checked}>
          <img src="${this._escAttr(s.icon)}" alt="" onerror="this.src='/discord.png'">
          <div class="user-info">
            <span class="display-name">${this._esc(s.name)}</span>
            <span class="username">${memberLine}</span>
          </div>
        </div>
        <div class="button-group">
          <button data-act="copy"  data-id="${this._escAttr(s.id)}" class="secondary-btn">${icon('copy')} ${this._esc(t('common.copy_id'))}</button>
          <button data-act="mute"  data-id="${this._escAttr(s.id)}" data-name="${this._escAttr(s.name)}" class="warning-btn">${icon('volume_x')} ${this._esc(t('sv.mute'))}</button>
          <button data-act="leave" data-id="${this._escAttr(s.id)}" data-name="${this._escAttr(s.name)}" class="danger-btn">${icon('log_out')} ${this._esc(t('sv.leave'))}</button>
        </div>
      </div>
    `;
  }

  _wireRowEvents(list) {
    list.querySelectorAll('.server-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) this._selected.add(cb.dataset.id);
        else this._selected.delete(cb.dataset.id);
        this.updateSelectedServersCount();
      });
    });
    list.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        const name = btn.dataset.name || '';
        if (act === 'copy')  { this.copyToClipboard(id); return; }
        if (act === 'mute')  { this.muteServer(id, name, btn); return; }
        if (act === 'leave') { this.leaveServer(id, name, btn); return; }
      });
    });
  }

  _collectSelectedIds() {
    const ids = new Set();
    this.contentArea.querySelectorAll('.server-checkbox:checked').forEach(cb => {
      if (cb.dataset.id) ids.add(cb.dataset.id);
    });
    return ids;
  }
  _restoreSelection() {
    this.contentArea.querySelectorAll('.server-checkbox').forEach(cb => {
      cb.checked = this._selected.has(cb.dataset.id);
    });
  }

  toggleSelectAllServers() {
    const visible = Array.from(this.contentArea.querySelectorAll('.server-checkbox'))
      .filter(cb => cb.closest('.list-item').style.display !== 'none');
    const allChecked = visible.length > 0 && visible.every(cb => cb.checked);
    visible.forEach(cb => {
      cb.checked = !allChecked;
      if (cb.checked) this._selected.add(cb.dataset.id);
      else this._selected.delete(cb.dataset.id);
    });
    const btn = this.contentArea.querySelector('#selectAllServersBtn');
    if (btn) btn.textContent = allChecked ? t('sv.select_all') : t('sv.deselect_all');
    this.updateSelectedServersCount();
  }

  updateSelectedServersCount() {
    const n = this.contentArea.querySelectorAll('.server-checkbox:checked').length;
    const leave = this.contentArea.querySelector('#leaveSelectedServersBtn');
    const mute  = this.contentArea.querySelector('#muteSelectedServersBtn');
    if (!leave || !mute) return;
    leave.disabled = n === 0 || this._globalBusy;
    mute.disabled  = n === 0 || this._globalBusy;
    leave.textContent = `${t('sv.leave_selected')} (${n})`;
    mute.textContent  = `${t('sv.mute_selected')} (${n})`;
  }

  copyToClipboard = copyToClipboard;

  async muteServer(serverId, name = '', btnEl = null) {
    if (this._globalBusy) { showNotification(t('sv.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'mute', serverId)) { showNotification(t('sv.busy_one'), 'warning'); return; }
    if (!markBusy(this._inflight, 'mute', serverId, btnEl)) return;
    const log = openOperationLog({
      title: t('sv.op_muting'), context: name || serverId, total: 1, cancellable: false,
    });
    const k = `mt:${serverId}`;
    log.start(k, { title: t('sv.op_muting'), context: name || serverId });
    try {
      const r = await window.electronAPI.muteServer(serverId);
      if (r && (r.success === undefined || r.success)) {
        log.success(k, { title: t('sv.op_muted'), detail: name || serverId });
        log.summary({ ok: 1, fail: 0, total: 1 });
        this.refreshServersList();
      } else {
        log.fail(k, { title: t('sv.op_mute_failed'), error: (r && r.error) || 'unknown' });
        log.summary({ ok: 0, fail: 1, total: 1 });
        showNotification((r && r.error) || t('sv.op_mute_failed'), 'error');
      }
    } catch (e) {
      log.fail(k, { title: t('sv.op_mute_failed'), error: String(e?.message || e) });
      log.summary({ ok: 0, fail: 1, total: 1 });
      showNotification(String(e?.message || e), 'error');
    } finally {
      clearBusy(this._inflight, 'mute', serverId, btnEl);
      log.close({ delay: 1500 });
    }
  }

  async unmuteServer(serverId, name = '', btnEl = null) {
    if (this._globalBusy) { showNotification(t('sv.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'unmute', serverId)) { showNotification(t('sv.busy_one'), 'warning'); return; }
    if (!markBusy(this._inflight, 'unmute', serverId, btnEl)) return;
    try {
      await window.electronAPI.unmuteServer(serverId);
      this.refreshServersList();
    } catch (e) {
      showNotification(String(e?.message || e), 'error');
    } finally {
      clearBusy(this._inflight, 'unmute', serverId, btnEl);
    }
  }

  async leaveServer(serverId, name = '', btnEl = null) {
    if (this._globalBusy) { showNotification(t('sv.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'leave', serverId)) { showNotification(t('sv.busy_one'), 'warning'); return; }
    if (!await showConfirm(t('sv.confirm_leave_one').replace('{name}', name || serverId), {
      confirmText: t('sv.leave') || 'Leave',
      cancelText: t('common.cancel') || 'Cancel',
    })) return;
    if (!markBusy(this._inflight, 'leave', serverId, btnEl)) return;

    const log = openOperationLog({
      title: t('sv.op_leave_title'), context: name || serverId, total: 1, cancellable: false,
    });
    const k = `lv:${serverId}`;
    log.start(k, { title: t('sv.op_leaving'), context: name || serverId });
    try {
      const r = await window.electronAPI.leaveServer(serverId);
      if (r && (r.success === undefined || r.success)) {
        log.success(k, { title: t('sv.op_left'), detail: name || serverId });
        log.summary({ ok: 1, fail: 0, total: 1 });
        this.refreshServersList();
      } else {
        log.fail(k, { title: t('sv.op_leave_failed'), error: (r && r.error) || 'unknown' });
        log.summary({ ok: 0, fail: 1, total: 1 });
        showNotification((r && r.error) || t('sv.op_leave_failed'), 'error');
      }
    } catch (e) {
      log.fail(k, { title: t('sv.op_leave_failed'), error: String(e?.message || e) });
      log.summary({ ok: 0, fail: 1, total: 1 });
      showNotification(String(e?.message || e), 'error');
    } finally {
      clearBusy(this._inflight, 'leave', serverId, btnEl);
      log.close({ delay: 1500 });
    }
  }

  async muteSelectedServers() {
    if (this._globalBusy) { showNotification(t('sv.busy_global'), 'warning'); return; }
    const ids = Array.from(this._collectSelectedIds());
    if (!ids.length) return;
    if (!await showConfirm(t('sv.confirm_mute_many').replace('{n}', ids.length), {
      confirmText: t('sv.mute_selected') || 'Mute',
      cancelText: t('common.cancel') || 'Cancel',
    })) return;

    const items = ids.map(id => {
      const row = this.contentArea.querySelector(`.list-item[data-id="${cssEsc(id)}"]`);
      return { id, name: row?.dataset.name || '' };
    });

    this._globalBusy = true;
    this.updateSelectedServersCount();

    const log = openOperationLog({
      title: t('sv.op_mute_bulk_title').replace('{n}', items.length),
      total: items.length,
    });
    let cancelled = false;
    log.onCancel(() => { cancelled = true; });
    const sum = { ok: 0, fail: 0, total: items.length };
    try {
      for (const it of items) {
        if (cancelled) break;
        const k = `mt:${it.id}`;
        log.start(k, { title: t('sv.op_muting'), context: it.name || it.id });
        try {
          const r = await window.electronAPI.muteServer(it.id);
          if (r && (r.success === undefined || r.success)) {
            sum.ok++;
            log.success(k, { title: t('sv.op_muted'), detail: it.name || it.id });
          } else {
            sum.fail++;
            log.fail(k, { title: t('sv.op_mute_failed'), error: (r && r.error) || 'unknown' });
          }
        } catch (e) {
          sum.fail++;
          log.fail(k, { title: t('sv.op_mute_failed'), error: String(e?.message || e) });
        }
      }
    } finally {
      log.summary({ ok: sum.ok, fail: sum.fail, total: sum.total });
      log.close({ delay: 2200 });
      this._globalBusy = false;
      this._selected.clear();
      this.refreshServersList();
    }
  }

  async leaveSelectedServers() {
    if (this._globalBusy) { showNotification(t('sv.busy_global'), 'warning'); return; }
    const ids = Array.from(this._collectSelectedIds());
    if (!ids.length) return;
    if (!await showConfirm(t('sv.confirm_leave_many').replace('{n}', ids.length), {
      confirmText: t('sv.leave') || 'Leave',
      cancelText: t('common.cancel') || 'Cancel',
    })) return;

    const items = ids.map(id => {
      const row = this.contentArea.querySelector(`.list-item[data-id="${cssEsc(id)}"]`);
      return { id, name: row?.dataset.name || '' };
    });

    this._globalBusy = true;
    this.updateSelectedServersCount();

    const log = openOperationLog({
      title: t('sv.op_leave_bulk_title').replace('{n}', items.length),
      total: items.length,
    });
    let cancelled = false;
    log.onCancel(() => { cancelled = true; });
    const sum = { ok: 0, fail: 0, total: items.length };
    try {
      for (const it of items) {
        if (cancelled) break;
        const k = `lv:${it.id}`;
        log.start(k, { title: t('sv.op_leaving'), context: it.name || it.id });
        try {
          const r = await window.electronAPI.leaveServer(it.id);
          if (r && (r.success === undefined || r.success)) {
            sum.ok++;
            log.success(k, { title: t('sv.op_left'), detail: it.name || it.id });
          } else {
            sum.fail++;
            log.fail(k, { title: t('sv.op_leave_failed'), error: (r && r.error) || 'unknown' });
          }
        } catch (e) {
          sum.fail++;
          log.fail(k, { title: t('sv.op_leave_failed'), error: String(e?.message || e) });
        }
      }
    } finally {
      log.summary({ ok: sum.ok, fail: sum.fail, total: sum.total });
      log.close({ delay: 2200 });
      this._globalBusy = false;
      this._selected.clear();
      this.refreshServersList();
    }
  }

  async readAll() {
    if (this._globalBusy) { showNotification(t('sv.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'readall', '_')) { showNotification(t('sv.busy_global'), 'warning'); return; }

    const servers = this.allServers.length ? this.allServers : [];
    const count = servers.length;
    const confirmMsg = count > 0
      ? (t('sv.confirm_read_all') || 'Mark all servers as read?').replace('{n}', count)
      : (t('sv.confirm_read_all_generic') || 'Mark all servers as read?');
    if (!await showConfirm(confirmMsg, {
      confirmText: t('sv.read_all') || 'Read All',
      cancelText: t('common.cancel') || 'Cancel',
    })) return;

    const btn = this.contentArea.querySelector('#readAllBtn');
    if (!markBusy(this._inflight, 'readall', '_', btn)) return;
    this._globalBusy = true;
    this.updateSelectedServersCount();

    const total = count || 1;
    const log = openOperationLog({
      title: t('sv.op_read_title') || 'Read All Servers',
      total,
      cancellable: true,
    });
    let cancelled = false;
    log.onCancel(() => { cancelled = true; });
    const sum = { ok: 0, fail: 0, total };

    try {
      if (servers.length === 0) {
        const k = 'readall';
        log.start(k, { title: t('sv.op_read_title') || 'Reading…' });
        const r = await window.electronAPI.readAll();
        if (r && r.success) {
          sum.ok = 1;
          log.success(k, { title: t('sv.read_done') || 'Done' });
        } else {
          sum.fail = 1;
          log.fail(k, { title: t('sv.read_failed') || 'Failed', error: (r && r.error) || 'unknown' });
        }
      } else {
        for (const sv of servers) {
          if (cancelled) break;
          const k = `ra:${sv.id}`;
          log.start(k, { title: t('sv.op_read_one') || 'Marking as read', context: sv.name || sv.id });
          try {
            const r = await window.electronAPI.readServer(sv.id);
            if (r && r.success) {
              sum.ok++;
              log.success(k, { title: t('sv.read_done') || 'Read', detail: sv.name || sv.id });
            } else {
              sum.fail++;
              log.fail(k, { title: t('sv.read_failed') || 'Failed', error: (r && r.error) || 'unknown' });
            }
          } catch (e) {
            sum.fail++;
            log.fail(k, { title: t('sv.read_failed') || 'Failed', error: String(e?.message || e) });
          }
          await new Promise(r => setTimeout(r, 120));
        }
      }
    } finally {
      log.summary({ ok: sum.ok, fail: sum.fail, total: sum.total });
      log.close({ delay: 2000 });
      this._globalBusy = false;
      clearBusy(this._inflight, 'readall', '_', btn);
      this.updateSelectedServersCount();
    }
  }

  _esc(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  _escAttr(s = '') { return this._esc(s); }
  escHtml(s = '') { return this._esc(s); }
  escAttr(s = '') { return this._esc(s); }
}

function cssEsc(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
}
