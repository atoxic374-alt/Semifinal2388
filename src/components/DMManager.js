import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification } from '../utils/ui.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
    this.account = null;
    this.botsOnly = false;
    this.filter = '';
    this.allDMs = [];
  }

  async refreshDMsList() {
    await this.render();
  }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('message')}</span>
            <div>
              <h2 class="mm-title">${t('dm.title')}</h2>
              <p class="mm-subtitle">${t('dm.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="dm-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <input type="text" id="dm-filter" class="list-filter-input" placeholder="${t('common.filter') || 'Filter…'}" value="${this.escAttr(this.filter)}">
            <button id="selectAllDMsBtn" onclick="window.dmManager.toggleSelectAllDMs()">${t('dm.select_all')}</button>
            <button id="deleteSelectedMessagesBtn" onclick="window.dmManager.deleteSelectedMessages()" class="warning-btn" disabled>${t('dm.delete_selected')}</button>
            <button id="closeSelectedDMsBtn" onclick="window.dmManager.closeSelectedDMs()" class="danger-btn" disabled>${t('dm.close_selected')}</button>
          </div>
          <div id="dmsList">${this.renderLoadingRow()}</div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#dm-toolbar');
    const picker = await buildAccountPicker({ selectId: 'dm-acct', selected: this.account });
    toolbar.innerHTML = `
      ${picker.html}
      <label class="toggle-pill ${this.botsOnly ? 'on' : ''}" id="dm-bots-pill">
        ${icon('bot')}
        <span>${t('dm.bots_only')}</span>
        <input type="checkbox" ${this.botsOnly ? 'checked' : ''}>
      </label>
    `;
    picker.bind(toolbar, (val) => { this.account = val; this.loadList(); });
    toolbar.querySelector('#dm-bots-pill').addEventListener('click', (e) => {
      e.preventDefault();
      this.botsOnly = !this.botsOnly;
      this.render();
    });

    this.contentArea.querySelector('#dm-filter').addEventListener('input', (e) => {
      this.filter = e.target.value;
      this._applyFilter();
    });

    await this.loadList();
  }

  renderLoadingRow() {
    return `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
  }

  _applyFilter() {
    const q = this.filter.toLowerCase();
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

  async loadList() {
    const list = this.contentArea.querySelector('#dmsList');
    if (!list) return;
    list.innerHTML = this.renderLoadingRow();
    try {
      const dms = await getDMsList(this.account, this.botsOnly);
      this.allDMs = dms;
      if (!dms.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${t('dm.empty')}</div>`;
        return;
      }
      const counter = `<div class="list-counter" id="dm-counter">${dms.length} / ${dms.length}</div>`;
      list.innerHTML = counter + dms.map(dm => `
        <div class="list-item" data-id="${dm.id}" data-name="${this.escAttr(dm.username + ' ' + dm.displayName)}" data-username="${this.escAttr(dm.username)}">
          <div class="list-item-left">
            <input type="checkbox" class="dm-checkbox" onchange="window.dmManager.updateSelectedCount()">
            <img src="${dm.avatar}" alt="" onerror="this.src='/discord.png'">
            <div class="user-info">
              <span class="display-name">${this.escHtml(dm.displayName)}${dm.bot ? ` <span class="pm-bot-tag">${icon('bot')} BOT</span>` : ''}</span>
              <span class="username">@${this.escHtml(dm.username)}</span>
            </div>
          </div>
          <div class="button-group">
            <button onclick="window.dmManager.copyToClipboard('${dm.id}')" class="secondary-btn">${icon('copy')} ${t('common.copy_id')}</button>
            <button onclick="window.dmManager.deleteDMMessages('${dm.id}', this.closest('.list-item').dataset.username, false)" class="warning-btn">${icon('trash')} ${t('dm.delete_msgs')}</button>
            <button onclick="window.dmManager.deleteDMMessages('${dm.id}', this.closest('.list-item').dataset.username, true)" class="warning-btn">${icon('clock_hist')} ${t('dm.delete_old')}</button>
            <button onclick="window.dmManager.closeDM('${dm.id}')" class="danger-btn">${icon('x_circle')} ${t('dm.close')}</button>
          </div>
        </div>
      `).join('');
      this._applyFilter();
    } catch (e) {
      list.innerHTML = `<p class="error">${t('dm.failed')}</p>`;
    }
  }

  toggleSelectAllDMs() {
    const visibleCheckboxes = Array.from(document.querySelectorAll('.dm-checkbox')).filter(cb => cb.closest('.list-item').style.display !== 'none');
    const selectAllBtn = document.getElementById('selectAllDMsBtn');
    const isSelectAll = selectAllBtn.textContent === t('dm.select_all');
    visibleCheckboxes.forEach(cb => cb.checked = isSelectAll);
    selectAllBtn.textContent = isSelectAll ? t('dm.deselect_all') : t('dm.select_all');
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = document.querySelectorAll('.dm-checkbox:checked').length;
    const del = document.getElementById('deleteSelectedMessagesBtn');
    const close = document.getElementById('closeSelectedDMsBtn');
    if (!del || !close) return;
    del.disabled = n === 0;
    close.disabled = n === 0;
    del.textContent = `${t('dm.delete_selected')} (${n})`;
    close.textContent = `${t('dm.close_selected')} (${n})`;
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      const items = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(cb => {
        const item = cb.closest('.list-item');
        return { id: item.dataset.id, username: item.dataset.username };
      });
      await handleBulkDMActions(items, 'delete', window.electronAPI);
      this.refreshDMsList();
    } finally { this.isDeleting = false; }
  }

  async closeSelectedDMs() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      const items = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(cb => {
        const item = cb.closest('.list-item');
        return { id: item.dataset.id, username: item.dataset.username };
      });
      await handleBulkDMActions(items, 'close', window.electronAPI);
      this.refreshDMsList();
    } finally { this.isDeleting = false; }
  }

  copyToClipboard = copyToClipboard;

  async deleteDMMessages(channelId, username, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      await deleteDMMessages({
        channelId, username,
        electronAPI: window.electronAPI,
        onComplete: () => {
          this.isDeleting = false;
          if (!skipRefresh) this.refreshDMsList();
        },
        skipRefresh, oldestFirst
      });
    } catch (e) { this.isDeleting = false; }
  }

  async closeDM(channelId) {
    try {
      const r = await window.electronAPI.closeDM(channelId);
      if (r.success) this.refreshDMsList();
    } catch (e) {}
  }

  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
