import { showProgressModal } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { getFriendsList } from '../utils/discord.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class FriendsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
  }

  async refreshFriendsList() {
    await this.render();
  }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('users')}</span>
            <div>
              <h2 class="mm-title">${t('fr.title')}</h2>
              <p class="mm-subtitle">${t('fr.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="fr-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <button id="selectAllFriendsBtn" onclick="window.friendsManager.toggleSelectAll()">${t('fr.select_all')}</button>
            <button id="removeSelectedFriendsBtn" onclick="window.friendsManager.removeSelected()" class="danger-btn" disabled>${t('fr.remove_selected')}</button>
          </div>
          <div id="friendsList"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#fr-toolbar');
    const picker = await buildAccountPicker({ selectId: 'fr-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; this.loadList(); });

    await this.loadList();
  }

  async loadList() {
    const list = this.contentArea.querySelector('#friendsList');
    if (!list) return;
    list.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const friends = await getFriendsList(this.account);
      if (!friends.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${t('fr.empty')}</div>`;
        return;
      }
      list.innerHTML = friends.map(f => `
        <div class="list-item" data-id="${f.id}">
          <div class="list-item-left">
            <input type="checkbox" class="friend-checkbox" onchange="window.friendsManager.updateSelectedCount()">
            <img src="${f.avatar}" alt="" onerror="this.src='/discord.png'">
            <div class="user-info">
              <span class="display-name">${this.escHtml(f.displayName)}</span>
              <span class="username">@${this.escHtml(f.username)}</span>
            </div>
          </div>
          <div class="button-group">
            <button onclick="window.friendsManager.copyId('${f.id}')" class="secondary-btn">${icon('copy')} ${t('common.copy_id')}</button>
            <button onclick="window.friendsManager.removeFriend('${f.id}')" class="danger-btn">${icon('trash')} ${t('fr.remove')}</button>
          </div>
        </div>
      `).join('');
    } catch (e) {
      list.innerHTML = `<p class="error">${t('fr.failed')}</p>`;
    }
  }

  toggleSelectAll() {
    const checkboxes = document.querySelectorAll('.friend-checkbox');
    const btn = document.getElementById('selectAllFriendsBtn');
    const isAll = btn.textContent === t('fr.select_all');
    checkboxes.forEach(cb => cb.checked = isAll);
    btn.textContent = isAll ? t('fr.deselect_all') : t('fr.select_all');
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = document.querySelectorAll('.friend-checkbox:checked').length;
    const btn = document.getElementById('removeSelectedFriendsBtn');
    if (!btn) return;
    btn.disabled = n === 0;
    btn.textContent = `${t('fr.remove_selected')} (${n})`;
  }

  async copyId(id) { await copyToClipboard(id); }

  async removeFriend(id) {
    try {
      await window.electronAPI.deleteFriend(id);
      this.refreshFriendsList();
    } catch (e) {}
  }

  async removeSelected() {
    const sel = document.querySelectorAll('.friend-checkbox:checked');
    const total = sel.length;
    if (!total) return;
    let done = 0;
    const { updateProgress, closeModal } = showProgressModal('Removing Friends', total);
    for (const cb of sel) {
      const id = cb.closest('.list-item').dataset.id;
      try {
        await window.electronAPI.deleteFriend(id);
        done++; updateProgress(done);
      } catch (e) {}
    }
    setTimeout(() => { closeModal(); this.refreshFriendsList(); }, 800);
  }

  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
}
