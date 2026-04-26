import { showProgressModal } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { getGroupsList } from '../utils/discord.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class GroupManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
    this.account = null;
  }

  async refreshGroupsList() {
    await this.render();
  }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('users')}</span>
            <div>
              <h2 class="mm-title">${t('gr.title')}</h2>
              <p class="mm-subtitle">${t('gr.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="gr-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <button id="selectAllGroupsBtn" onclick="window.groupManager.toggleSelectAll()">${t('gr.select_all')}</button>
            <button id="leaveSelectedGroupsBtn" onclick="window.groupManager.leaveSelectedGroups()" class="danger-btn" disabled>${t('gr.leave_selected')}</button>
            <button id="deleteSelectedMessagesBtn" onclick="window.groupManager.deleteSelectedMessages()" class="warning-btn" disabled>${t('gr.delete_selected')}</button>
          </div>
          <div id="groupsList"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#gr-toolbar');
    const picker = await buildAccountPicker({ selectId: 'gr-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; this.loadList(); });

    await this.loadList();
  }

  groupInitial(name) {
    const s = (name || 'G').trim();
    return s.charAt(0).toUpperCase();
  }

  async loadList() {
    const list = this.contentArea.querySelector('#groupsList');
    if (!list) return;
    list.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const groups = await getGroupsList(this.account);
      if (!groups.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${t('gr.empty')}</div>`;
        return;
      }
      list.innerHTML = groups.map(g => {
        const hasIcon = g.icon && g.icon !== '/discord.png';
        const avatar = hasIcon
          ? `<img src="${g.icon}" alt="" onerror="this.parentElement.innerHTML='<span class=&quot;gr-fallback&quot;>${this.escAttr(this.groupInitial(g.name))}</span>'">`
          : `<span class="gr-fallback">${this.escHtml(this.groupInitial(g.name))}</span>`;
        return `
          <div class="list-item" data-id="${g.id}" data-name="${this.escAttr(g.name)}">
            <div class="list-item-left">
              <input type="checkbox" class="group-checkbox" onchange="window.groupManager.updateSelectedCount()">
              <div class="group-avatar">${avatar}</div>
              <div class="group-info">
                <span class="group-name">${this.escHtml(g.name)}</span>
                <span class="group-members">${g.recipients} ${t('gr.members')}</span>
              </div>
            </div>
            <div class="button-group">
              <button onclick="window.groupManager.copyId('${g.id}')" class="secondary-btn">${icon('copy')} ${t('common.copy_id')}</button>
              <button onclick="window.groupManager.deleteMessages('${g.id}', this.closest('.list-item').dataset.name, false)" class="warning-btn">${icon('trash')} ${t('gr.delete_msgs')}</button>
              <button onclick="window.groupManager.deleteMessages('${g.id}', this.closest('.list-item').dataset.name, true)" class="warning-btn">${icon('clock_hist')} ${t('gr.delete_old')}</button>
              <button onclick="window.groupManager.leaveGroup('${g.id}')" class="danger-btn">${icon('log_out')} ${t('gr.leave')}</button>
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {
      list.innerHTML = `<p class="error">${t('gr.failed')}</p>`;
    }
  }

  toggleSelectAll() {
    const checkboxes = document.querySelectorAll('.group-checkbox');
    const btn = document.getElementById('selectAllGroupsBtn');
    const isAll = btn.textContent === t('gr.select_all');
    checkboxes.forEach(cb => cb.checked = isAll);
    btn.textContent = isAll ? t('gr.deselect_all') : t('gr.select_all');
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = document.querySelectorAll('.group-checkbox:checked').length;
    const leave = document.getElementById('leaveSelectedGroupsBtn');
    const del = document.getElementById('deleteSelectedMessagesBtn');
    if (!leave || !del) return;
    leave.disabled = n === 0;
    del.disabled = n === 0;
    leave.textContent = `${t('gr.leave_selected')} (${n})`;
    del.textContent = `${t('gr.delete_selected')} (${n})`;
  }

  async copyId(id) { await copyToClipboard(id); }

  async deleteMessages(groupId, groupName, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      await deleteDMMessages({
        channelId: groupId, username: groupName,
        electronAPI: window.electronAPI,
        onComplete: () => {
          this.isDeleting = false;
          if (!skipRefresh) this.refreshGroupsList();
        },
        skipRefresh, isGroup: true, oldestFirst
      });
    } catch (e) { this.isDeleting = false; }
  }

  async leaveGroup(groupId) {
    try {
      const r = await window.electronAPI.leaveGroup(groupId);
      if (r.success) this.refreshGroupsList();
    } catch (e) {}
  }

  async leaveSelectedGroups() {
    const sel = document.querySelectorAll('.group-checkbox:checked');
    const total = sel.length;
    if (!total) return;
    let done = 0;
    const { updateProgress, closeModal } = showProgressModal('Leaving Groups', total);
    for (const cb of sel) {
      const id = cb.closest('.list-item').dataset.id;
      try {
        await window.electronAPI.leaveGroup(id);
        done++; updateProgress(done);
      } catch (e) {}
    }
    setTimeout(() => { closeModal(); this.refreshGroupsList(); }, 800);
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    const sel = document.querySelectorAll('.group-checkbox:checked');
    const total = sel.length;
    if (!total) { this.isDeleting = false; return; }
    let done = 0;
    const { updateProgress, closeModal } = showProgressModal('Deleting Messages', total);
    for (const cb of sel) {
      const item = cb.closest('.list-item');
      try {
        await this.deleteMessages(item.dataset.id, item.dataset.name, false, true);
        done++; updateProgress(done);
      } catch (e) {}
    }
    setTimeout(() => { closeModal(); this.isDeleting = false; this.refreshGroupsList(); }, 800);
  }

  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
