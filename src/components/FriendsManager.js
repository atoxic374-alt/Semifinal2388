import { copyToClipboard } from '../utils/clipboard.js';
import { getFriendsList } from '../utils/discord.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification } from '../utils/ui.js';
import { openOperationLog } from '../utils/operationLog.js';
import { markBusy, clearBusy, isBusy } from '../utils/dupGuard.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

/**
 * FriendsManager v2 — same hardening as DMManager:
 *  - Per-(action, id) inflight Map prevents double-fire on per-row buttons.
 *  - Global busy lock prevents two bulk runs from racing each other.
 *  - All operations report through the shared OperationLog overlay.
 *  - Confirmations on every destructive path.
 *  - Selection / filter / scroll position survive a refresh.
 *  - All `onclick=` removed in favour of addEventListener so the dup-guard
 *    runs deterministically.
 */
export class FriendsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.filter = '';
    this.allFriends = [];
    this._inflight = new Map();
    this._globalBusy = false;
    this._selected = new Set();
  }

  async refreshFriendsList() { await this.loadList({ keepSelection: true }); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('users')}</span>
            <div>
              <h2 class="mm-title">${this._esc(t('fr.title'))}</h2>
              <p class="mm-subtitle">${this._esc(t('fr.subtitle'))}</p>
            </div>
          </div>
          <div class="mm-tabs" id="fr-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <input type="text" id="fr-filter" class="list-filter-input"
                   placeholder="${this._esc(t('common.filter'))}"
                   value="${this._escAttr(this.filter)}">
            <button id="fr-refresh-btn" type="button" class="secondary-btn">${icon('refresh') || '↻'} ${this._esc(t('fr.refresh'))}</button>
            <button id="selectAllFriendsBtn" type="button">${this._esc(t('fr.select_all'))}</button>
            <button id="removeSelectedFriendsBtn" type="button" class="danger-btn" disabled>${this._esc(t('fr.remove_selected'))}</button>
          </div>
          <div id="friendsList"><div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div></div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#fr-toolbar');
    const picker = await buildAccountPicker({ selectId: 'fr-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; this._selected.clear(); this.loadList(); });

    const $ = (sel) => this.contentArea.querySelector(sel);
    $('#fr-filter').addEventListener('input', (e) => { this.filter = e.target.value; this._applyFilter(); });
    $('#fr-refresh-btn').addEventListener('click', () => this.refreshFriendsList());
    $('#selectAllFriendsBtn').addEventListener('click', () => this.toggleSelectAll());
    $('#removeSelectedFriendsBtn').addEventListener('click', () => this.removeSelected());

    await this.loadList();
  }

  _applyFilter() {
    const q = (this.filter || '').toLowerCase();
    this.contentArea.querySelectorAll('#friendsList .list-item').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    const count = this.allFriends.filter(f =>
      !q || f.username.toLowerCase().includes(q) || f.displayName.toLowerCase().includes(q)
    ).length;
    const counter = this.contentArea.querySelector('#fr-counter');
    if (counter) counter.textContent = `${count} / ${this.allFriends.length}`;
  }

  async loadList({ keepSelection = false } = {}) {
    const list = this.contentArea.querySelector('#friendsList');
    if (!list) return;
    if (!keepSelection) this._selected = this._collectSelectedIds();
    const prevScroll = list.scrollTop;
    list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('common.loading'))}</div>`;
    try {
      const friends = await getFriendsList(this.account);
      this.allFriends = friends;
      if (!friends.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${this._esc(t('fr.empty'))}</div>`;
        return;
      }
      const counter = `<div class="list-counter" id="fr-counter">${friends.length} / ${friends.length}</div>`;
      list.innerHTML = counter + friends.map(f => this._renderRow(f)).join('');
      this._wireRowEvents(list);
      this._restoreSelection();
      this._applyFilter();
      this.updateSelectedCount();
      list.scrollTop = prevScroll;
    } catch (e) {
      list.innerHTML = `<p class="error">${this._esc(t('fr.failed'))}</p>`;
    }
  }

  _renderRow(f) {
    const checked = this._selected.has(f.id) ? 'checked' : '';
    return `
      <div class="list-item" data-id="${this._escAttr(f.id)}" data-name="${this._escAttr(f.username + ' ' + f.displayName)}" data-username="${this._escAttr(f.username)}">
        <div class="list-item-left">
          <input type="checkbox" class="friend-checkbox" data-id="${this._escAttr(f.id)}" ${checked}>
          <img src="${this._escAttr(f.avatar)}" alt="" onerror="this.src='/discord.png'">
          <div class="user-info">
            <span class="display-name">${this._esc(f.displayName)}</span>
            <span class="username">@${this._esc(f.username)}</span>
          </div>
        </div>
        <div class="button-group">
          <button data-act="copy"   data-id="${this._escAttr(f.id)}" class="secondary-btn">${icon('copy')} ${this._esc(t('common.copy_id'))}</button>
          <button data-act="remove" data-id="${this._escAttr(f.id)}" data-username="${this._escAttr(f.username)}" class="danger-btn">${icon('trash')} ${this._esc(t('fr.remove'))}</button>
        </div>
      </div>
    `;
  }

  _wireRowEvents(list) {
    list.querySelectorAll('.friend-checkbox').forEach(cb => {
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
        if (act === 'copy')   { this.copyId(id); return; }
        if (act === 'remove') { this.removeFriend(id, btn.dataset.username || '', btn); return; }
      });
    });
  }

  _collectSelectedIds() {
    const ids = new Set();
    this.contentArea.querySelectorAll('.friend-checkbox:checked').forEach(cb => {
      if (cb.dataset.id) ids.add(cb.dataset.id);
    });
    return ids;
  }
  _restoreSelection() {
    this.contentArea.querySelectorAll('.friend-checkbox').forEach(cb => {
      cb.checked = this._selected.has(cb.dataset.id);
    });
  }

  toggleSelectAll() {
    const visible = Array.from(this.contentArea.querySelectorAll('.friend-checkbox'))
      .filter(cb => cb.closest('.list-item').style.display !== 'none');
    const allChecked = visible.length > 0 && visible.every(cb => cb.checked);
    visible.forEach(cb => {
      cb.checked = !allChecked;
      if (cb.checked) this._selected.add(cb.dataset.id);
      else this._selected.delete(cb.dataset.id);
    });
    const btn = this.contentArea.querySelector('#selectAllFriendsBtn');
    if (btn) btn.textContent = allChecked ? t('fr.select_all') : t('fr.deselect_all');
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = this.contentArea.querySelectorAll('.friend-checkbox:checked').length;
    const btn = this.contentArea.querySelector('#removeSelectedFriendsBtn');
    if (!btn) return;
    btn.disabled = n === 0 || this._globalBusy;
    btn.textContent = `${t('fr.remove_selected')} (${n})`;
  }

  async copyId(id) {
    await copyToClipboard(id);
    showNotification(t('common.copied') || 'Copied', 'success');
  }

  async removeFriend(id, username = '', btnEl = null) {
    if (this._globalBusy) { showNotification(t('fr.busy_global'), 'warning'); return; }
    if (isBusy(this._inflight, 'remove', id)) { showNotification(t('fr.busy_one'), 'warning'); return; }
    if (!window.confirm(t('fr.confirm_remove_one').replace('{name}', username || id))) return;
    if (!markBusy(this._inflight, 'remove', id, btnEl)) return;

    const log = openOperationLog({
      title: t('fr.op_remove_title'),
      context: `@${username || id}`,
      total: 1,
      cancellable: false,
    });
    const k = `rm:${id}`;
    log.start(k, { title: t('fr.op_removing'), context: `@${username || id}` });
    try {
      const r = await window.electronAPI.deleteFriend(id);
      if (r && r.success) {
        log.success(k, { title: t('fr.op_removed'), detail: `@${username || id}` });
        log.summary({ ok: 1, fail: 0, total: 1 });
        this.allFriends = this.allFriends.filter(f => f.id !== id);
        this.refreshFriendsList();
      } else {
        log.fail(k, { title: t('fr.op_remove_failed'), error: (r && r.error) || 'unknown' });
        log.summary({ ok: 0, fail: 1, total: 1 });
        showNotification((r && r.error) || t('fr.op_remove_failed'), 'error');
      }
    } catch (e) {
      log.fail(k, { title: t('fr.op_remove_failed'), error: String(e?.message || e) });
      log.summary({ ok: 0, fail: 1, total: 1 });
      showNotification(String(e?.message || e), 'error');
    } finally {
      clearBusy(this._inflight, 'remove', id, btnEl);
      log.close({ delay: 1500 });
    }
  }

  async removeSelected() {
    if (this._globalBusy) { showNotification(t('fr.busy_global'), 'warning'); return; }
    const ids = Array.from(this._collectSelectedIds());
    if (!ids.length) return;
    if (!window.confirm(t('fr.confirm_remove_many').replace('{n}', ids.length))) return;

    const items = ids.map(id => {
      const row = this.contentArea.querySelector(`.list-item[data-id="${cssEsc(id)}"]`);
      return { id, username: row?.dataset.username || '' };
    });

    this._globalBusy = true;
    this.updateSelectedCount();

    const log = openOperationLog({
      title: t('fr.op_remove_bulk_title').replace('{n}', items.length),
      context: '',
      total: items.length,
    });
    let cancelled = false;
    log.onCancel(() => { cancelled = true; });

    const sum = { ok: 0, fail: 0, total: items.length };
    try {
      for (const it of items) {
        if (cancelled) break;
        const k = `rm:${it.id}`;
        log.start(k, { title: t('fr.op_removing'), context: `@${it.username || it.id}` });
        try {
          const r = await window.electronAPI.deleteFriend(it.id);
          if (r && r.success) {
            sum.ok++;
            log.success(k, { title: t('fr.op_removed'), detail: `@${it.username || it.id}` });
          } else {
            sum.fail++;
            log.fail(k, { title: t('fr.op_remove_failed'), error: (r && r.error) || 'unknown' });
          }
        } catch (e) {
          sum.fail++;
          log.fail(k, { title: t('fr.op_remove_failed'), error: String(e?.message || e) });
        }
      }
    } finally {
      log.summary({ ok: sum.ok, fail: sum.fail, total: sum.total });
      log.close({ delay: 2200 });
      this._globalBusy = false;
      this._selected.clear();
      this.refreshFriendsList();
    }
  }

  _esc(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  _escAttr(s = '') { return this._esc(s); }
}

function cssEsc(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
}
