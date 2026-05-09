import { copyToClipboard } from '../utils/clipboard.js';
import { showMessagePreview, showBulkMessagePreview } from '../utils/messagePreview.js';
import { getGroupsList } from '../utils/discord.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification, showConfirm } from '../utils/ui.js';
import { openOperationLog } from '../utils/operationLog.js';
import { markBusy, clearBusy, isBusy } from '../utils/dupGuard.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

/**
 * GroupManager v2 — same hardening as DMManager:
 *  - Per-(action, id) inflight Map (delete-msgs, delete-msgs-old, leave).
 *  - Global busy lock for bulk runs.
 *  - All operations report through OperationLog (delete pipes per-message
 *    events into the shared log via `opLog`).
 *  - Confirms for destructive paths.
 *  - Selection / scroll preservation.
 */
export class GroupManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.allGroups = [];
    this.filter = '';
    this._inflight = new Map();
    this._globalBusy = false;
    this._selected = new Set();
  }

  async refreshGroupsList() { await this.loadList({ keepSelection: true }); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('users')}</span>
            <div>
              <h2 class="mm-title">${this._esc(t('gr.title'))}</h2>
              <p class="mm-subtitle">${this._esc(t('gr.subtitle'))}</p>
            </div>
          </div>
          <div class="mm-tabs" id="gr-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <input type="text" id="gr-filter" class="list-filter-input"
                   placeholder="${this._esc(t('common.filter'))}"
                   value="${this._escAttr(this.filter)}">
            <button id="gr-refresh-btn" type="button" class="secondary-btn">${icon('refresh') || '↻'} ${this._esc(t('gr.refresh'))}</button>
            <button id="selectAllGroupsBtn" type="button">${this._esc(t('gr.select_all'))}</button>
            <button id="leaveSelectedGroupsBtn" type="button" class="danger-btn" disabled>${this._esc(t('gr.leave_selected'))}</button>
            <button id="deleteSelectedMessagesBtn" type="button" class="warning-btn" disabled>${this._esc(t('gr.delete_selected'))}</button>
          </div>
          <div id="groupsList"><div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div></div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#gr-toolbar');
    const picker = await buildAccountPicker({ selectId: 'gr-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; this._selected.clear(); this.loadList(); });

    const $ = (sel) => this.contentArea.querySelector(sel);
    $('#gr-filter').addEventListener('input', (e) => { this.filter = e.target.value; this._applyFilter(); });
    $('#gr-refresh-btn').addEventListener('click', () => this.refreshGroupsList());
    $('#selectAllGroupsBtn').addEventListener('click', () => this.toggleSelectAll());
    $('#leaveSelectedGroupsBtn').addEventListener('click', () => this.leaveSelectedGroups());
    $('#deleteSelectedMessagesBtn').addEventListener('click', () => this.deleteSelectedMessages());

    await this.loadList();
  }

  groupInitial(name) { return (name || 'G').trim().charAt(0).toUpperCase(); }

  _applyFilter() {
    const q = (this.filter || '').toLowerCase();
    this.contentArea.querySelectorAll('#groupsList .list-item').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    const counter = this.contentArea.querySelector('#gr-counter');
    const count = this.allGroups.filter(g => !q || g.name.toLowerCase().includes(q)).length;
    if (counter) counter.textContent = `${count} / ${this.allGroups.length}`;
  }

  async loadList({ keepSelection = false } = {}) {
    const list = this.contentArea.querySelector('#groupsList');
    if (!list) return;
    if (!keepSelection) this._selected = this._collectSelectedIds();
    const prevScroll = list.scrollTop;
    list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div>`;
    try {
      const groups = await getGroupsList(this.account);
      this.allGroups = groups;
      if (!groups.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('gr.empty'))}</div>`;
        return;
      }
      const counter = `<div class="list-counter" id="gr-counter">${groups.length} / ${groups.length}</div>`;
      list.innerHTML = counter + groups.map(g => this._renderRow(g)).join('');
      this._wireRowEvents(list);
      this._restoreSelection();
      this._applyFilter();
      this.updateSelectedCount();
      list.scrollTop = prevScroll;
    } catch (e) {
      list.innerHTML = `<p class="error">${this._esc(t('gr.failed'))}</p>`;
    }
  }

  _renderRow(g) {
    const checked = this._selected.has(g.id) ? 'checked' : '';
    const hasIcon = g.icon && g.icon !== '/discord.png';
    const initial = this._esc(this.groupInitial(g.name));
    const avatar = hasIcon
      ? `<img src="${this._escAttr(g.icon)}" alt="" onerror="this.parentElement.innerHTML='<span class=&quot;gr-fallback&quot;>${initial}</span>'">`
      : `<span class="gr-fallback">${initial}</span>`;
    return `
      <div class="list-item" data-id="${this._escAttr(g.id)}" data-name="${this._escAttr(g.name)}">
        <div class="list-item-left">
          <input type="checkbox" class="group-checkbox" data-id="${this._escAttr(g.id)}" ${checked}>
          <div class="group-avatar">${avatar}</div>
          <div class="group-info">
            <span class="group-name">${this._esc(g.name)}</span>
            <span class="group-members">${g.recipients} ${this._esc(t('gr.members'))}</span>
          </div>
        </div>
        <div class="button-group">
          <button data-act="copy"   data-id="${this._escAttr(g.id)}" class="secondary-btn">${icon('copy')} ${this._esc(t('common.copy_id'))}</button>
          <button data-act="del"    data-id="${this._escAttr(g.id)}" data-name="${this._escAttr(g.name)}" class="warning-btn">${icon('trash')} ${this._esc(t('gr.delete_msgs'))}</button>
          <button data-act="delold" data-id="${this._escAttr(g.id)}" data-name="${this._escAttr(g.name)}" class="warning-btn">${icon('clock_hist')} ${this._esc(t('gr.delete_old'))}</button>
          <button data-act="leave"  data-id="${this._escAttr(g.id)}" data-name="${this._escAttr(g.name)}" class="danger-btn">${icon('log_out')} ${this._esc(t('gr.leave'))}</button>
        </div>
      </div>
    `;
  }

  _wireRowEvents(list) {
    list.querySelectorAll('.group-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) this._selected.add(cb.dataset.id);
        else this._selected.delete(cb.dataset.id);
        this.updateSelectedCount();
      });
    });
    list.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        const name = btn.dataset.name || '';
        if (act === 'copy')   { this.copyId(id); return; }
        if (act === 'del')    { this.deleteMessages(id, name, false, btn); return; }
        if (act === 'delold') { this.deleteMessages(id, name, true,  btn); return; }
        if (act === 'leave')  { this.leaveGroup(id, name, btn); return; }
      });
    });
  }

  _collectSelectedIds() {
    const ids = new Set();
    this.contentArea.querySelectorAll('.group-checkbox:checked').forEach(cb => {
      if (cb.dataset.id) ids.add(cb.dataset.id);
    });
    return ids;
  }
  _restoreSelection() {
    this.contentArea.querySelectorAll('.group-checkbox').forEach(cb => {
      cb.checked = this._selected.has(cb.dataset.id);
    });
  }

  toggleSelectAll() {
    const visible = Array.from(this.contentArea.querySelectorAll('.group-checkbox'))
      .filter(cb => cb.closest('.list-item').style.display !== 'none');
    const allChecked = visible.length > 0 && visible.every(cb => cb.checked);
    visible.forEach(cb => {
      cb.checked = !allChecked;
      if (cb.checked) this._selected.add(cb.dataset.id);
      else this._selected.delete(cb.dataset.id);
    });
    const btn = this.contentArea.querySelector('#selectAllGroupsBtn');
    if (btn) btn.textContent = allChecked ? t('gr.select_all') : t('gr.deselect_all');
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = this.contentArea.querySelectorAll('.group-checkbox:checked').length;
    const leave = this.contentArea.querySelector('#leaveSelectedGroupsBtn');
    const del   = this.contentArea.querySelector('#deleteSelectedMessagesBtn');
    if (!leave || !del) return;
    leave.disabled = n === 0 || this._globalBusy;
    del.disabled   = n === 0 || this._globalBusy;
    leave.textContent = `${t('gr.leave_selected')} (${n})`;
    del.textContent   = `${t('gr.delete_selected')} (${n})`;
  }

  async copyId(id) { await copyToClipboard(id); showNotification(t('common.copied') || 'Copied', 'success'); }

  async deleteMessages(groupId, groupName, oldestFirst = false, btnEl = null, _opts = {}) {
    const { skipRefresh = false } = _opts;
    if (this._globalBusy) { showNotification(t('gr.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'del', groupId)) { showNotification(t('gr.busy_one'), 'warning'); return; }

    if (!markBusy(this._inflight, 'del', groupId, btnEl)) return;
    try {
      const grp = this.allGroups.find(g => g.id === groupId);
      const result = await showMessagePreview({
        channelId:   groupId,
        displayName: grp?.name || groupName || '',
        username:    '',
        avatar:      grp?.icon || '',
        isGroup:     true,
        oldestFirst,
      });
      if (result.deleted > 0 && !skipRefresh) this.refreshGroupsList();
    } finally {
      clearBusy(this._inflight, 'del', groupId, btnEl);
    }
  }

  async leaveGroup(groupId, groupName = '', btnEl = null) {
    if (this._globalBusy) { showNotification(t('gr.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'leave', groupId)) { showNotification(t('gr.busy_one'), 'warning'); return; }
    if (!await showConfirm(t('gr.confirm_leave_one').replace('{name}', groupName || groupId), {
      confirmText: t('gr.leave') || 'Leave',
      cancelText: t('common.cancel') || 'Cancel',
    })) return;
    if (!markBusy(this._inflight, 'leave', groupId, btnEl)) return;

    const log = openOperationLog({
      title: t('gr.op_leave_title'),
      context: (t('gr.op_in') || 'in {name}').replace('{name}', groupName || groupId),
      total: 1, cancellable: false,
    });
    const k = `lv:${groupId}`;
    log.start(k, { title: t('gr.op_leaving'), context: groupName || groupId });
    try {
      const r = await window.electronAPI.leaveGroup(groupId);
      if (r && r.success) {
        log.success(k, { title: t('gr.op_left'), detail: groupName || groupId });
        log.summary({ ok: 1, fail: 0, total: 1 });
        this.refreshGroupsList();
      } else {
        log.fail(k, { title: t('gr.op_leave_failed'), error: (r && r.error) || 'unknown' });
        log.summary({ ok: 0, fail: 1, total: 1 });
        showNotification((r && r.error) || t('gr.op_leave_failed'), 'error');
      }
    } catch (e) {
      log.fail(k, { title: t('gr.op_leave_failed'), error: String(e?.message || e) });
      log.summary({ ok: 0, fail: 1, total: 1 });
      showNotification(String(e?.message || e), 'error');
    } finally {
      clearBusy(this._inflight, 'leave', groupId, btnEl);
      log.close({ delay: 1500 });
    }
  }

  async leaveSelectedGroups() {
    if (this._globalBusy) { showNotification(t('gr.busy_global'), 'warning'); return; }
    const ids = Array.from(this._collectSelectedIds());
    if (!ids.length) return;
    if (!await showConfirm(t('gr.confirm_leave_many').replace('{n}', ids.length), {
      confirmText: t('gr.leave') || 'Leave',
      cancelText: t('common.cancel') || 'Cancel',
    })) return;

    const items = ids.map(id => {
      const row = this.contentArea.querySelector(`.list-item[data-id="${cssEsc(id)}"]`);
      return { id, name: row?.dataset.name || '' };
    });

    this._globalBusy = true;
    this.updateSelectedCount();

    const log = openOperationLog({
      title: t('gr.op_leave_bulk_title').replace('{n}', items.length),
      total: items.length,
    });
    let cancelled = false;
    log.onCancel(() => { cancelled = true; });
    const sum = { ok: 0, fail: 0, total: items.length };
    try {
      for (const it of items) {
        if (cancelled) break;
        const k = `lv:${it.id}`;
        log.start(k, { title: t('gr.op_leaving'), context: it.name || it.id });
        try {
          const r = await window.electronAPI.leaveGroup(it.id);
          if (r && r.success) { sum.ok++;  log.success(k, { title: t('gr.op_left'), detail: it.name || it.id }); }
          else                { sum.fail++; log.fail(k,    { title: t('gr.op_leave_failed'), error: (r && r.error) || 'unknown' }); }
        } catch (e) {
          sum.fail++;
          log.fail(k, { title: t('gr.op_leave_failed'), error: String(e?.message || e) });
        }
      }
    } finally {
      log.summary({ ok: sum.ok, fail: sum.fail, total: sum.total });
      log.close({ delay: 2200 });
      this._globalBusy = false;
      this._selected.clear();
      this.refreshGroupsList();
    }
  }

  async deleteSelectedMessages() {
    if (this._globalBusy) { showNotification(t('gr.busy_global'), 'warning'); return; }
    const ids = Array.from(this._collectSelectedIds());
    if (!ids.length) return;

    const items = ids.map(id => {
      const grp = this.allGroups.find(g => g.id === id);
      return {
        id,
        displayName: grp?.name || '',
        username:    '',
        avatar:      grp?.icon || '',
      };
    });

    this._globalBusy = true;
    this.updateSelectedCount();
    try {
      await showBulkMessagePreview({ items, isGroup: true });
    } finally {
      this._globalBusy = false;
      this._selected.clear();
      this.refreshGroupsList();
    }
  }

  _esc(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  _escAttr(s = '') { return this._esc(s); }
}

function cssEsc(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
}
