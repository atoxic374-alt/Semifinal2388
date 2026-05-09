// Reaction Manager — auto-react & auto-button click
import { showNotification } from '../utils/ui.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class ReactionManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.activeTab = 'server'; // server | group | dm | all | active
    this.allTokens = [];
    this.tokens = [];
    this.servers = [];
    this.groups = [];
    this.dms = [];
    this.scopeId = '';
    this.mode = 'mirror';
    this.emojis = '';
    this.buttons = '';
    this.listeners = [];
    this._startBusy = false;
    this._stoppingListeners = new Set();
  }

  async init() {
    await Promise.all([this.loadClients(), this.loadServers(), this.loadGroups(), this.loadDMs(), this.refreshListeners()]);
    this.render();
  }

  async loadClients() { try { const r = await window.electronAPI.listClients(); this.allTokens = r.success ? r.clients : []; } catch (e) {} }
  async loadServers() { try { const r = await window.electronAPI.getServers(); this.servers = r.success ? r.servers : []; } catch (e) {} }
  async loadGroups()  { try { const r = await window.electronAPI.getGroups();  this.groups  = r.success ? r.groups  : []; } catch (e) {} }
  async loadDMs()     { try { const r = await window.electronAPI.getDMs();     this.dms     = r.success ? r.dms     : []; } catch (e) {} }

  async refreshListeners() {
    try { const r = await window.electronAPI.listReactions(); this.listeners = r.success ? r.listeners : []; } catch (e) { this.listeners = []; }
    const el = document.getElementById('rm-listeners');
    if (el) el.innerHTML = this.renderListeners();
  }

  render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('heart')}</span>
            <div>
              <h2 class="mm-title">${t('rm.title')}</h2>
              <p class="mm-subtitle">${t('rm.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            ${this.tabBtn('server', 'radio',    t('rm.tab.server'))}
            ${this.tabBtn('group',  'users',    t('rm.tab.group'))}
            ${this.tabBtn('dm',     'message',  t('rm.tab.dm'))}
            ${this.tabBtn('all',    'globe',    t('rm.tab.all'))}
            ${this.tabBtn('active', 'settings', t('rm.tab.active'))}
          </div>
        </div>
        <div class="mm-body">
          ${this.activeTab === 'active' ? this.renderActive() : this.renderComposer()}
        </div>
      </div>
    `;
  }

  tabBtn(id, ic, label) {
    return `<button class="mm-tab ${this.activeTab === id ? 'active' : ''}" onclick="window.reactionManager.switchTab('${id}')">${icon(ic)} ${label}</button>`;
  }
  switchTab(tab) { this.activeTab = tab; this.render(); if (tab === 'active') this.refreshListeners(); }

  renderComposer() {
    return `
      <div class="mm-grid">
        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('rm.scope')}</div><div class="mm-card-desc">${t('rm.scope_desc')}</div></div></div>
          ${this.renderScope()}
        </div>

        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('user')}</span><div><div class="mm-card-title">${t('rm.accounts')}</div><div class="mm-card-desc">${t('rm.accounts_desc')}</div></div></div>
          ${this.renderTokenSelector()}
        </div>

        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('zap')}</span><div><div class="mm-card-title">${t('rm.mode')}</div><div class="mm-card-desc">${t('rm.mode_desc')}</div></div></div>
          <div class="mm-radio-group">
            <label class="mm-radio ${this.mode === 'mirror' ? 'active' : ''}"><input type="radio" name="rm-mode" value="mirror" ${this.mode === 'mirror' ? 'checked' : ''} onchange="window.reactionManager.mode='mirror'"><div><strong>${t('rm.mirror')}</strong><span>${t('rm.mirror_desc')}</span></div></label>
            <label class="mm-radio ${this.mode === 'specific' ? 'active' : ''}"><input type="radio" name="rm-mode" value="specific" ${this.mode === 'specific' ? 'checked' : ''} onchange="window.reactionManager.mode='specific'"><div><strong>${t('rm.specific')}</strong><span>${t('rm.specific_desc')}</span></div></label>
          </div>
        </div>

        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('smile')}</span><div><div class="mm-card-title">${t('rm.emojis')}</div><div class="mm-card-desc">${t('rm.emojis_desc')}</div></div></div>
          <div class="mm-field"><textarea rows="2" placeholder=":fire:, :heart:, :tada:" oninput="window.reactionManager.emojis = this.value">${this.escHtml(this.emojis)}</textarea></div>
        </div>

        <div class="mm-card mm-span-2">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('circle_btn')}</span><div><div class="mm-card-title">${t('rm.buttons')}</div><div class="mm-card-desc">${t('rm.buttons_desc')}</div></div></div>
          <div class="mm-field"><input type="text" placeholder="${t('rm.btn_placeholder')}" value="${this.escHtml(this.buttons)}" oninput="window.reactionManager.buttons = this.value"></div>
        </div>

        <div class="mm-card mm-span-2 mm-actions-card">
          <button class="mm-btn primary" onclick="window.reactionManager.actionStart()">${icon('play')} ${t('rm.start')}</button>
          <button class="mm-btn ghost small" onclick="window.reactionManager.switchTab('active')">${icon('settings')} ${t('rm.view_active')}</button>
        </div>
      </div>
    `;
  }

  renderScope() {
    if (this.activeTab === 'server') {
      const opts = this.servers.map(s => `<option value="${s.id}" ${s.id === this.scopeId ? 'selected' : ''}>${this.escHtml(s.name)}</option>`).join('');
      return `<div class="mm-field"><label>${t('rm.tab.server')}</label><select onchange="window.reactionManager.scopeId = this.value"><option value="">${t('rm.select')}</option>${opts}</select></div>`;
    }
    if (this.activeTab === 'group') {
      const opts = this.groups.map(g => `<option value="${g.id}" ${g.id === this.scopeId ? 'selected' : ''}>${this.escHtml(g.name)}</option>`).join('');
      return `<div class="mm-field"><label>${t('rm.group')}</label><select onchange="window.reactionManager.scopeId = this.value"><option value="">${t('rm.select')}</option>${opts}</select></div>`;
    }
    if (this.activeTab === 'dm') {
      const opts = this.dms.map(d => `<option value="${d.id}" ${d.id === this.scopeId ? 'selected' : ''}>@${this.escHtml(d.username)}</option>`).join('');
      return `<div class="mm-field"><label>${t('rm.dm')}</label><select onchange="window.reactionManager.scopeId = this.value"><option value="">${t('rm.select')}</option>${opts}</select></div>`;
    }
    return `<div class="mm-info-row">${icon('globe')} ${t('rm.scope.all_info')}</div>`;
  }

  renderTokenSelector() {
    if (!this.allTokens.length) return `<div class="mm-info-row mm-muted">${t('rm.no_clients')}</div>`;
    return `
      <div class="mm-token-grid">
        ${this.allTokens.map(tk => `
          <label class="mm-token-chip ${this.tokens.includes(tk.name) ? 'on' : ''}">
            <input type="checkbox" ${this.tokens.includes(tk.name) ? 'checked' : ''} onchange="window.reactionManager.toggleToken('${this.escJs(tk.name)}', this.checked)">
            <img src="${tk.avatar || '/discord.png'}" onerror="this.src='/discord.png'">
            <div><strong>${this.escHtml(tk.name)}</strong><span>${this.escHtml(tk.username || '')}</span></div>
          </label>`).join('')}
      </div>
      <div class="mm-token-actions">
        <button class="mm-btn ghost small" onclick="window.reactionManager.selectAll(true)">${t('tk.select_all')}</button>
        <button class="mm-btn ghost small" onclick="window.reactionManager.selectAll(false)">${t('tk.clear_sel')}</button>
      </div>
    `;
  }

  renderActive() {
    return `
      <div class="mm-card mm-span-2">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('settings')}</span><div><div class="mm-card-title">${t('rm.active_listeners')}</div><div class="mm-card-desc">${t('rm.active_desc')}</div></div></div>
        <div id="rm-listeners">${this.renderListeners()}</div>
        <button class="mm-btn ghost small" onclick="window.reactionManager.refreshListeners()">${icon('rotate_cw')} ${t('rm.refresh')}</button>
      </div>
    `;
  }

  renderListeners() {
    if (!this.listeners.length) return `<div class="mm-info-row mm-muted">${t('rm.no_listeners')}</div>`;
    return this.listeners.map(l => `
      <div class="mm-job-item">
        <div>
          <strong>${l.mode === 'mirror' ? `${icon('mirror')} ${t('rm.mirror')}` : `${icon('target')} ${t('rm.specific')}`}</strong>
          <span class="mm-job-meta">${t('rm.scope_l')}: ${this.escHtml(l.scope?.type)} · ${t('rm.accounts_l')}: ${l.tokens?.length || 1} · ${t('rm.emojis_l')}: ${l.emojis?.length || 0} · ${t('rm.buttons_l')}: ${l.buttonNames?.length || 0}</span>
        </div>
        <button class="mm-btn danger small" onclick="window.reactionManager.stop('${l.id}')">${t('mm.stop')}</button>
      </div>
    `).join('');
  }

  toggleToken(n, on) {
    if (on && !this.tokens.includes(n)) this.tokens.push(n);
    else if (!on) this.tokens = this.tokens.filter(x => x !== n);
  }
  selectAll(all) { this.tokens = all ? this.allTokens.map(tk => tk.name) : []; this.render(); }

  async actionStart() {
    if (this._startBusy) { showNotification(t('rm.busy'), 'warning'); return; }
    let scope;
    if (this.activeTab === 'all')          scope = { type: 'all' };
    else if (this.activeTab === 'server')  scope = this.scopeId ? { type: 'server', id: this.scopeId } : null;
    else if (this.activeTab === 'group')   scope = this.scopeId ? { type: 'group',  id: this.scopeId } : null;
    else if (this.activeTab === 'dm')      scope = this.scopeId ? { type: 'dm',     id: this.scopeId } : null;
    if (!scope) return showNotification(t('rm.pick_target'));

    const emojis = (this.emojis || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    const buttonNames = (this.buttons || '').split(/[,]+/).map(s => s.trim()).filter(Boolean);
    if (this.mode === 'specific' && !emojis.length && !buttonNames.length) return showNotification(t('rm.add_emojis'));
    if (!window.confirm(t('rm.confirm_start'))) return;

    this._startBusy = true;
    const startBtn = this.contentArea.querySelector('.mm-btn.primary');
    if (startBtn) { startBtn.disabled = true; startBtn.dataset.prevHtml = startBtn.innerHTML; startBtn.innerHTML = `<span class="dm-mini-spin"></span> …`; }

    if (window._testMode) {
      const desc = `${scope.type === 'all' ? 'all targets' : scope.type + ':' + scope.id}`;
      const text = `mode=${this.mode} ${this.mode === 'specific' ? `emojis=[${emojis.join(',')}] buttons=[${buttonNames.join(',')}]` : '(mirror author)'}`;
      window.showTestPreview?.('react', text, desc, 1, 1);
    }
    try {
      const r = await window.electronAPI.startReactions({ tokens: this.tokens, scope, mode: this.mode, emojis, buttonNames });
      if (r.success) { showNotification(`${t('rm.listener_started')}: ${r.listenerId}`, 'success'); this.switchTab('active'); }
      else showNotification(`${t('mm.failed')}: ${r.error}`, 'error');
    } catch (e) { showNotification(`${t('mm.failed')}: ${e.message}`, 'error'); }
    finally {
      this._startBusy = false;
      if (startBtn) { startBtn.disabled = false; startBtn.innerHTML = startBtn.dataset.prevHtml || startBtn.innerHTML; }
    }
  }

  async stop(id) {
    if (this._stoppingListeners.has(id)) { showNotification(t('rm.stop_busy'), 'warning'); return; }
    this._stoppingListeners.add(id);
    try { await window.electronAPI.stopReactions(id); }
    catch (e) {}
    finally { this._stoppingListeners.delete(id); this.refreshListeners(); }
  }

  escHtml(t) { if (t == null) return ''; return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  escJs(t) { return String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
}
