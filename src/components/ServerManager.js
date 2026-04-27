import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, showProgressModal } from '../utils/ui.js';
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class ServerManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.filter = '';
    this.allServers = [];
  }

  async refreshServersList() {
    await this.render();
  }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('shield')}</span>
            <div>
              <h2 class="mm-title">${t('sv.title')}</h2>
              <p class="mm-subtitle">${t('sv.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="sv-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="actions-bar">
            <input type="text" id="sv-filter" class="list-filter-input" placeholder="${t('common.filter') || 'Filter…'}" value="${this.escAttr(this.filter)}">
            <button id="selectAllServersBtn" onclick="window.serverManager.toggleSelectAllServers()">${t('sv.select_all')}</button>
            <button id="leaveSelectedServersBtn" onclick="window.serverManager.leaveSelectedServers()" class="danger-btn" disabled>${t('sv.leave_selected')}</button>
            <button id="muteSelectedServersBtn" onclick="window.serverManager.muteSelectedServers()" class="warning-btn" disabled>${t('sv.mute_selected')}</button>
            <button id="readAllBtn" onclick="window.serverManager.readAll()" class="success-btn">${icon('check')} ${t('sv.read_all')}</button>
          </div>
          <div id="serversList"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#sv-toolbar');
    const picker = await buildAccountPicker({ selectId: 'sv-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; this.loadList(); });

    this.contentArea.querySelector('#sv-filter').addEventListener('input', (e) => {
      this.filter = e.target.value;
      this._applyFilter();
    });

    await this.loadList();
  }

  _applyFilter() {
    const q = this.filter.toLowerCase();
    this.contentArea.querySelectorAll('#serversList .list-item').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    const count = this.allServers.filter(s => !q || s.name.toLowerCase().includes(q)).length;
    const counter = this.contentArea.querySelector('#sv-counter');
    if (counter) counter.textContent = `${count} / ${this.allServers.length}`;
  }

  async loadList() {
    const list = this.contentArea.querySelector('#serversList');
    if (!list) return;
    list.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const servers = await getServersList(this.account);
      this.allServers = servers;
      if (!servers.length) {
        list.innerHTML = `<div class="mm-info-row mm-muted">${t('sv.empty')}</div>`;
        return;
      }
      const counter = `<div class="list-counter" id="sv-counter">${servers.length} / ${servers.length}</div>`;
      list.innerHTML = counter + servers.map(s => `
        <div class="list-item" data-id="${s.id}" data-name="${this.escAttr(s.name)}">
          <div class="list-item-left">
            <input type="checkbox" class="server-checkbox" onchange="window.serverManager.updateSelectedServersCount()">
            <img src="${s.icon}" alt="" onerror="this.src='/discord.png'">
            <div class="user-info">
              <span class="display-name">${this.escHtml(s.name)}</span>
              <span class="username">${s.members ? `${s.members.toLocaleString()} ${t('sv.members') || 'members'}` : ''}</span>
            </div>
          </div>
          <div class="button-group">
            <button onclick="window.serverManager.copyToClipboard('${s.id}')" class="secondary-btn">${icon('copy')} ${t('common.copy_id')}</button>
            <button onclick="window.serverManager.muteServer('${s.id}')" class="warning-btn">${icon('volume_x')} ${t('sv.mute')}</button>
            <button onclick="window.serverManager.leaveServer('${s.id}')" class="danger-btn">${icon('log_out')} ${t('sv.leave')}</button>
          </div>
        </div>
      `).join('');
      this._applyFilter();
    } catch (e) {
      list.innerHTML = `<p class="error">${t('sv.failed')}</p>`;
    }
  }

  async muteServer(serverId) {
    try {
      await window.electronAPI.muteServer(serverId);
      this.refreshServersList();
    } catch (e) {}
  }

  async unmuteServer(serverId) {
    try {
      await window.electronAPI.unmuteServer(serverId);
      this.refreshServersList();
    } catch (e) {}
  }

  async muteSelectedServers() {
    const sel = document.querySelectorAll('.server-checkbox:checked');
    const total = sel.length;
    if (!total) return;
    let done = 0;
    const { updateProgress, closeModal } = showProgressModal('Muting Servers', total);
    for (const cb of sel) {
      const id = cb.closest('.list-item').dataset.id;
      try { await window.electronAPI.muteServer(id); done++; updateProgress(done); } catch (e) {}
    }
    setTimeout(() => { closeModal(); this.refreshServersList(); }, 800);
  }

  async readAll() {
    try {
      const r = await window.electronAPI.readAll();
      showNotification(r.success ? t('sv.read_done') : t('sv.read_failed'));
    } catch (e) { showNotification(t('sv.read_failed')); }
  }

  toggleSelectAllServers() {
    const visible = Array.from(document.querySelectorAll('.server-checkbox')).filter(cb => cb.closest('.list-item').style.display !== 'none');
    const btn = document.getElementById('selectAllServersBtn');
    const isAll = btn.textContent === t('sv.select_all');
    visible.forEach(cb => cb.checked = isAll);
    btn.textContent = isAll ? t('sv.deselect_all') : t('sv.select_all');
    this.updateSelectedServersCount();
  }

  updateSelectedServersCount() {
    const n = document.querySelectorAll('.server-checkbox:checked').length;
    const leave = document.getElementById('leaveSelectedServersBtn');
    const mute = document.getElementById('muteSelectedServersBtn');
    if (!leave || !mute) return;
    leave.disabled = n === 0;
    mute.disabled = n === 0;
    leave.textContent = `${t('sv.leave_selected')} (${n})`;
    mute.textContent = `${t('sv.mute_selected')} (${n})`;
  }

  async leaveSelectedServers() {
    const sel = document.querySelectorAll('.server-checkbox:checked');
    const total = sel.length;
    if (!total) return;
    let done = 0;
    const { updateProgress, closeModal } = showProgressModal('Leaving Servers', total);
    for (const cb of sel) {
      const item = cb.closest('.list-item');
      const id = item.dataset.id;
      try {
        await window.electronAPI.leaveServer(id);
        done++; updateProgress(done);
        item.remove();
      } catch (e) {}
    }
    setTimeout(() => { closeModal(); this.refreshServersList(); }, 800);
  }

  copyToClipboard = copyToClipboard;

  async leaveServer(serverId) {
    try {
      await window.electronAPI.leaveServer(serverId);
      this.refreshServersList();
    } catch (e) {}
  }

  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
