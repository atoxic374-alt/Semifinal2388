import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { showMessagePreview, showBulkMessagePreview } from '../utils/messagePreview.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification, showConfirm } from '../utils/ui.js';
import { openOperationLog } from '../utils/operationLog.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

/**
 * DMManager — restructured for v2:
 *
 *  - Per-DM in-flight tracking (`_inflight` Map keyed by `${action}:${dmId}`)
 *    so the SAME button cannot fire twice, AND so two different actions on
 *    the SAME DM (e.g. delete-msgs + close) cannot collide.
 *  - Global lock (`_globalBusy`) for bulk runs — single bulk op at a time.
 *  - Visual busy state per row: a button enters `.is-busy` (spinner + dim +
 *    pointer-events:none), so the user sees exactly which DM is mid-op.
 *  - All operations report through the shared OperationLog overlay (animated
 *    activity log with success/fail/total counters and per-step rows).
 *  - Confirmation dialogs for destructive actions (close, bulk-close,
 *    delete-msgs, bulk-delete) so an accidental click does nothing.
 *  - Re-render now PRESERVES selection + filter + scroll position so the
 *    user doesn't lose their place after an action.
 */
export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.botsOnly = false;
    this.filter = '';
    this.allDMs = [];
    this._inflight = new Map();           // `${action}:${id}` → true
    this._globalBusy = false;             // true while a bulk op is running
    this._selected = new Set();           // dm ids currently checked (survives reload)
  }

  // ── Concurrency helpers ─────────────────────────────────────────────

  _markBusy(action, id, btnEl) {
    const key = `${action}:${id}`;
    if (this._inflight.has(key)) return false;
    this._inflight.set(key, true);
    if (btnEl) {
      btnEl.classList.add('is-busy');
      btnEl.dataset.prevHtml = btnEl.innerHTML;
      btnEl.disabled = true;
      btnEl.innerHTML = `<span class="dm-mini-spin"></span> ${this._esc(t('dm.in_progress'))}`;
    }
    return true;
  }
  _clearBusy(action, id, btnEl) {
    const key = `${action}:${id}`;
    this._inflight.delete(key);
    if (btnEl) {
      btnEl.classList.remove('is-busy');
      btnEl.disabled = false;
      if (btnEl.dataset.prevHtml) {
        btnEl.innerHTML = btnEl.dataset.prevHtml;
        delete btnEl.dataset.prevHtml;
      }
    }
  }
  _isBusy(action, id) { return this._inflight.has(`${action}:${id}`); }

  async refreshDMsList() { await this.loadList({ keepSelection: true }); }

  // ── Render ──────────────────────────────────────────────────────────

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('message')}</span>
            <div>
              <h2 class="mm-title">${this._esc(t('dm.title'))}</h2>
              <p class="mm-subtitle">${this._esc(t('dm.subtitle'))}</p>
            </div>
          </div>
          <div class="mm-tabs" id="dm-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <input type="text" id="dm-filter" class="list-filter-input"
                   placeholder="${this._esc(t('common.filter'))}"
                   value="${this._escAttr(this.filter)}">
            <button id="dm-refresh-btn" class="secondary-btn" type="button">
              ${icon('refresh') || '↻'} ${this._esc(t('dm.refresh'))}
            </button>
            <button id="selectAllDMsBtn" type="button">${this._esc(t('dm.select_all'))}</button>
            <button id="deleteSelectedMessagesBtn" type="button" class="warning-btn" disabled>
              ${this._esc(t('dm.delete_selected'))}
            </button>
            <button id="closeSelectedDMsBtn" type="button" class="danger-btn" disabled>
              ${this._esc(t('dm.close_selected'))}
            </button>
          </div>
          <div id="dmsList">${this._renderLoadingRow()}</div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#dm-toolbar');
    const picker = await buildAccountPicker({ selectId: 'dm-acct', selected: this.account });
    toolbar.innerHTML = `
      ${picker.html}
      <label class="toggle-pill ${this.botsOnly ? 'on' : ''}" id="dm-bots-pill">
        ${icon('bot')}
        <span>${this._esc(t('dm.bots_only'))}</span>
        <input type="checkbox" ${this.botsOnly ? 'checked' : ''}>
      </label>
    `;
    picker.bind(toolbar, (val) => {
      this.account = val;
      this._selected.clear();
      this.loadList();
    });
    toolbar.querySelector('#dm-bots-pill').addEventListener('click', (e) => {
      e.preventDefault();
      this.botsOnly = !this.botsOnly;
      this._selected.clear();
      this.render();
    });

    // Use addEventListener everywhere — no inline onclick — so the
    // duplication guard runs deterministically and we control every entry
    // point.
    const $ = (sel) => this.contentArea.querySelector(sel);
    $('#dm-filter').addEventListener('input', (e) => {
      this.filter = e.target.value;
      this._applyFilter();
    });
    $('#dm-refresh-btn').addEventListener('click', () => this.refreshDMsList());
    $('#selectAllDMsBtn').addEventListener('click', () => this.toggleSelectAllDMs());
    $('#deleteSelectedMessagesBtn').addEventListener('click', () => this.deleteSelectedMessages());
    $('#closeSelectedDMsBtn').addEventListener('click', () => this.closeSelectedDMs());

    await this.loadList();
  }

  _renderLoadingRow() { return `<div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div>`; }

  _applyFilter() {
    const q = (this.filter || '').toLowerCase();
    this.contentArea.querySelectorAll('#dmsList .list-item').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    const count = this.allDMs.filter(d =>
      !q || d.username.toLowerCase().includes(q) || d.displayName.toLowerCase().includes(q)
    ).length;
    const counter = this.contentArea.querySelector('#dm-counter');
    if (counter) counter.textContent = `${count} / ${this.allDMs.length}`;
  }

  async loadList({ keepSelection = false } = {}) {
    const list = this.contentArea.querySelector('#dmsList');
    if (!list) return;
    if (!keepSelection) this._selected = this._collectSelectedIds();
    const prevScroll = list.scrollTop;
    list.innerHTML = this._renderLoadingRow();
    try {
      const dms = await getDMsList(this.account, this.botsOnly);
      this.allDMs = dms;
      if (!dms.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('dm.empty'))}</div>`;
        return;
      }
      const counter = `<div class="list-counter" id="dm-counter">${dms.length} / ${dms.length}</div>`;
      list.innerHTML = counter + dms.map(dm => this._renderRow(dm)).join('');
      this._wireRowEvents(list);
      this._restoreSelection();
      this._applyFilter();
      this.updateSelectedCount();
      list.scrollTop = prevScroll;
    } catch (e) {
      list.innerHTML = `<p class="error">${this._esc(t('dm.failed'))}</p>`;
    }
  }

  _renderRow(dm) {
    const checked = this._selected.has(dm.id) ? 'checked' : '';
    return `
      <div class="list-item" data-id="${this._escAttr(dm.id)}"
           data-name="${this._escAttr(dm.username + ' ' + dm.displayName)}"
           data-username="${this._escAttr(dm.username)}">
        <div class="list-item-left">
          <input type="checkbox" class="dm-checkbox" data-id="${this._escAttr(dm.id)}" ${checked}>
          <img src="${this._escAttr(dm.avatar)}" alt="" onerror="this.src='/discord.png'">
          <div class="user-info">
            <span class="display-name">${this._esc(dm.displayName)}${dm.bot ? ` <span class="pm-bot-tag">${icon('bot')} BOT</span>` : ''}</span>
            <span class="username">@${this._esc(dm.username)}</span>
          </div>
        </div>
        <div class="button-group">
          <button data-act="copy"   data-id="${this._escAttr(dm.id)}" class="secondary-btn">${icon('copy')} ${this._esc(t('common.copy_id'))}</button>
          <button data-act="del"    data-id="${this._escAttr(dm.id)}" data-username="${this._escAttr(dm.username)}" class="warning-btn">${icon('trash')} ${this._esc(t('dm.delete_msgs'))}</button>
          <button data-act="delold" data-id="${this._escAttr(dm.id)}" data-username="${this._escAttr(dm.username)}" class="warning-btn">${icon('clock_hist')} ${this._esc(t('dm.delete_old'))}</button>
          <button data-act="close"  data-id="${this._escAttr(dm.id)}" data-username="${this._escAttr(dm.username)}" class="danger-btn">${icon('x_circle')} ${this._esc(t('dm.close'))}</button>
        </div>
      </div>
    `;
  }

  _wireRowEvents(list) {
    list.querySelectorAll('.dm-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        if (cb.checked) this._selected.add(id);
        else this._selected.delete(id);
        this.updateSelectedCount();
      });
    });
    list.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        const uname = btn.dataset.username || '';
        if (act === 'copy')   { this.copyId(id); return; }
        if (act === 'del')    { this.deleteDMMessages(id, uname, false, btn); return; }
        if (act === 'delold') { this.deleteDMMessages(id, uname, true, btn);  return; }
        if (act === 'close')  { this.closeDM(id, uname, btn); return; }
      });
    });
  }

  _collectSelectedIds() {
    const ids = new Set();
    this.contentArea.querySelectorAll('.dm-checkbox:checked').forEach(cb => {
      if (cb.dataset.id) ids.add(cb.dataset.id);
    });
    return ids;
  }
  _restoreSelection() {
    this.contentArea.querySelectorAll('.dm-checkbox').forEach(cb => {
      cb.checked = this._selected.has(cb.dataset.id);
    });
  }

  toggleSelectAllDMs() {
    const visible = Array.from(this.contentArea.querySelectorAll('.dm-checkbox'))
      .filter(cb => cb.closest('.list-item').style.display !== 'none');
    const allChecked = visible.length > 0 && visible.every(cb => cb.checked);
    visible.forEach(cb => {
      cb.checked = !allChecked;
      if (cb.checked) this._selected.add(cb.dataset.id);
      else this._selected.delete(cb.dataset.id);
    });
    const btn = this.contentArea.querySelector('#selectAllDMsBtn');
    if (btn) btn.textContent = allChecked ? t('dm.select_all') : t('dm.deselect_all');
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = this.contentArea.querySelectorAll('.dm-checkbox:checked').length;
    const del = this.contentArea.querySelector('#deleteSelectedMessagesBtn');
    const close = this.contentArea.querySelector('#closeSelectedDMsBtn');
    if (!del || !close) return;
    const busy = this._globalBusy;
    del.disabled = n === 0 || busy;
    close.disabled = n === 0 || busy;
    del.textContent = `${t('dm.delete_selected')} (${n})`;
    close.textContent = `${t('dm.close_selected')} (${n})`;
  }

  // ── Bulk ops ────────────────────────────────────────────────────────

  async _runBulk(action) {
    if (this._globalBusy) { showNotification(t('dm.busy_global'), 'warning'); return; }
    const ids = Array.from(this._collectSelectedIds());
    if (!ids.length) return;

    if (action === 'delete') {
      // Visual bulk preview — handles confirm + deletion inside the modal
      const items = ids.map(id => {
        const dm = this.allDMs.find(d => d.id === id);
        return {
          id,
          displayName: dm?.displayName || '',
          username:    dm?.username    || '',
          avatar:      dm?.avatar      || '',
        };
      });
      this._globalBusy = true;
      this.updateSelectedCount();
      try {
        await showBulkMessagePreview({ items, isGroup: false });
      } finally {
        this._globalBusy = false;
        this._selected.clear();
        this.refreshDMsList();
      }
    } else {
      // Close DMs — keep original text-confirm + operation-log flow
      const items = ids.map(id => {
        const row = this.contentArea.querySelector(`.list-item[data-id="${cssEsc(id)}"]`);
        return { id, username: row?.dataset.username || '' };
      });
      const confirmed = await showConfirm(t('dm.confirm_close_many').replace('{n}', items.length), {
        confirmText: t('dm.close') || 'Close',
        cancelText:  t('common.cancel') || 'Cancel',
      });
      if (!confirmed) return;
      this._globalBusy = true;
      this.updateSelectedCount();
      try {
        await handleBulkDMActions(items, action, window.electronAPI);
      } catch (e) {
        showNotification(String(e?.message || e), 'error');
      } finally {
        this._globalBusy = false;
        this._selected.clear();
        this.refreshDMsList();
      }
    }
  }

  deleteSelectedMessages() { return this._runBulk('delete'); }
  closeSelectedDMs()       { return this._runBulk('close'); }

  // ── Per-row ops ─────────────────────────────────────────────────────

  copyId(id) {
    copyToClipboard(id);
    showNotification(t('common.copied') || 'Copied', 'success');
  }

  // (Kept name `copyToClipboard` for backwards-compat with any external caller.)
  copyToClipboard = copyToClipboard;

  async deleteDMMessages(channelId, username, oldestFirst = false, btnEl = null, _opts = {}) {
    const { skipRefresh = false } = _opts;
    if (this._globalBusy) { showNotification(t('dm.busy_global'), 'warning'); return; }
    if (this._isBusy('delete', channelId)) { showNotification(t('dm.busy_one'), 'warning'); return; }
    if (!this._markBusy('delete', channelId, btnEl)) return;
    try {
      const dm = this.allDMs.find(d => d.id === channelId);
      const result = await showMessagePreview({
        channelId,
        displayName: dm?.displayName || username || '',
        username:    dm?.username    || username || '',
        avatar:      dm?.avatar      || '',
        isGroup:     false,
        oldestFirst,
      });
      if (result.deleted > 0 && !skipRefresh) this.refreshDMsList();
    } finally {
      this._clearBusy('delete', channelId, btnEl);
    }
  }

  async closeDM(channelId, username = '', btnEl = null) {
    if (this._globalBusy) { showNotification(t('dm.busy_global'), 'warning'); return; }
    if (this._isBusy('close', channelId)) { showNotification(t('dm.busy_one'), 'warning'); return; }
    const confirmed = await showConfirm(t('dm.confirm_close_one').replace('{name}', username || channelId), {
      confirmText: t('dm.close') || 'Close',
      cancelText: t('common.cancel') || 'Cancel',
    });
    if (!confirmed) return;
    if (!this._markBusy('close', channelId, btnEl)) return;
    const log = openOperationLog({
      title: t('dm.op_close_title'),
      context: (t('dm.op_with') || 'with @{name}').replace('{name}', username || channelId),
      total: 1,
      cancellable: false,
    });
    const stepKey = `close:${channelId}`;
    log.start(stepKey, { title: t('dm.op_closing_one'), context: `id ${channelId}` });
    try {
      const r = await window.electronAPI.closeDM(channelId);
      if (r && r.success) {
        log.success(stepKey, { title: t('dm.op_closed_one'), detail: `id ${channelId}` });
        log.summary({ ok: 1, fail: 0, total: 1 });
        showNotification(t('dm.op_closed_one'), 'success');
        this._clearBusy('close', channelId, btnEl);
        this.refreshDMsList();
      } else {
        log.fail(stepKey, { title: t('dm.op_close_failed'), error: (r && r.error) || 'unknown' });
        log.summary({ ok: 0, fail: 1, total: 1 });
        showNotification((r && r.error) || t('dm.op_close_failed'), 'error');
        this._clearBusy('close', channelId, btnEl);
      }
    } catch (e) {
      log.fail(stepKey, { title: t('dm.op_close_failed'), error: String(e?.message || e) });
      log.summary({ ok: 0, fail: 1, total: 1 });
      showNotification(String(e?.message || e), 'error');
      this._clearBusy('close', channelId, btnEl);
    } finally {
      log.close({ delay: 1800 });
    }
  }

  _esc(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  _escAttr(s = '') { return this._esc(s); }
}

// Tiny CSS.escape polyfill for our id-based selectors (Discord channel ids
// are numeric strings so the polyfill is only there to stay safe).
function cssEsc(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
}
