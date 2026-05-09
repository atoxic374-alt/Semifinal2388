// Messages Manager — send / repeat / schedule
import { showNotification } from '../utils/ui.js';
import { openOperationLog } from '../utils/operationLog.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class MessagesManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.activeTab = 'server';     // 'server' | 'dms' | 'groups' | 'jobs'
    this.messages = [''];          // panels
    this.tokens = [];              // selected token names (empty => active)
    this.allTokens = [];
    this.servers = [];
    this.channels = [];
    this.selectedServerId = null;
    this.sendToAllChannels = false;
    this.selectedChannelIds = [];
    this.dms = [];
    this.groups = [];
    this.selectedDMs = [];
    this.selectedGroups = [];
    this.mode = 'natural';
    this.intervalSec = 60;
    this.repeatCount = 0;
    this.scheduleAt = '';
    this.jobs = [];
    // Dup-protection
    this._busy = { sendNow: false, repeat: false, schedule: false };
    this._stoppingJobs = new Set();
  }

  async init() {
    await this.loadClients();
    this.render();
    this.refreshJobs();
  }

  async loadClients() {
    try {
      const r = await window.electronAPI.listClients();
      this.allTokens = r.success ? r.clients : [];
    } catch (e) { this.allTokens = []; }
  }

  async refreshJobs() {
    try {
      const r = await window.electronAPI.listMessageJobs();
      this.jobs = r.success ? r.jobs : [];
      const el = document.getElementById('mm-jobs-list');
      if (el) el.innerHTML = this.renderJobsList();
    } catch (e) {}
  }

  render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('mail')}</span>
            <div>
              <h2 class="mm-title">${t('mm.title')}</h2>
              <p class="mm-subtitle">${t('mm.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            ${this.tabBtn('server', 'radio',    t('mm.tab.servers'))}
            ${this.tabBtn('dms',    'message',  t('mm.tab.dms'))}
            ${this.tabBtn('groups', 'users',    t('mm.tab.groups'))}
            ${this.tabBtn('jobs',   'settings', t('mm.tab.jobs'))}
          </div>
        </div>

        <div class="mm-body">
          ${this.activeTab === 'jobs' ? this.renderJobsTab() : this.renderComposerTab()}
        </div>
      </div>
    `;
    this.bindGlobalEvents();
    this.bindActionEvents();
    if (this.activeTab === 'server') this.loadServers();
  }

  bindActionEvents() {
    const $ = (id) => this.contentArea.querySelector(id);
    $('[data-mm-action="send"]')?.addEventListener('click', () => this.actionSendNow());
    $('[data-mm-action="repeat"]')?.addEventListener('click', () => this.actionRepeat());
    $('[data-mm-action="schedule"]')?.addEventListener('click', () => this.actionSchedule());
    this.contentArea.querySelectorAll('[data-mm-stop]').forEach(btn => {
      btn.addEventListener('click', () => this.stopJob(btn.dataset.mmStop));
    });
  }

  tabBtn(id, ic, label) {
    return `<button class="mm-tab ${this.activeTab === id ? 'active' : ''}" onclick="window.messagesManager.switchTab('${id}')">${icon(ic)} ${label}</button>`;
  }

  switchTab(tab) {
    this.activeTab = tab;
    this.render();
    if (tab === 'jobs') this.refreshJobs();
  }

  renderComposerTab() {
    return `
      <div class="mm-grid">
        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('target')}</span><div><div class="mm-card-title">${t('mm.target')}</div><div class="mm-card-desc">${t('mm.target_desc')}</div></div></div>
          ${this.renderTargetSection()}
        </div>

        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('user')}</span><div><div class="mm-card-title">${t('mm.accounts')}</div><div class="mm-card-desc">${t('mm.accounts_desc')}</div></div></div>
          ${this.renderTokenSelector()}
        </div>

        <div class="mm-card mm-span-2">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('file_text')}</span><div><div class="mm-card-title">${t('mm.messages')}</div><div class="mm-card-desc">${t('mm.messages_desc')}</div></div></div>
          <div id="mm-messages">${this.renderMessagePanels()}</div>
          <button class="mm-btn ghost mm-add-msg" onclick="window.messagesManager.addMessage()">${icon('plus')} ${t('mm.add_panel')}</button>
        </div>

        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('zap')}</span><div><div class="mm-card-title">${t('mm.mode')}</div><div class="mm-card-desc">${t('mm.mode_desc')}</div></div></div>
          <div class="mm-radio-group">
            <label class="mm-radio ${this.mode === 'natural' ? 'active' : ''}"><input type="radio" name="mm-mode" value="natural" ${this.mode === 'natural' ? 'checked' : ''} onchange="window.messagesManager.mode='natural';window.messagesManager.refreshModeUI()"><div><strong>${t('mm.natural')}</strong><span>${t('mm.natural_desc')}</span></div></label>
            <label class="mm-radio ${this.mode === 'fast' ? 'active' : ''}"><input type="radio" name="mm-mode" value="fast" ${this.mode === 'fast' ? 'checked' : ''} onchange="window.messagesManager.mode='fast';window.messagesManager.refreshModeUI()"><div><strong>${t('mm.fast')}</strong><span>${t('mm.fast_desc')}</span></div></label>
          </div>
        </div>

        <div class="mm-card">
          <div class="mm-card-head"><span class="mm-card-icon">${icon('alarm')}</span><div><div class="mm-card-title">${t('mm.repeat_sched')}</div><div class="mm-card-desc">${t('mm.repeat_sched_desc')}</div></div></div>
          <div class="mm-field"><label>${t('mm.repeat_every')}</label><input type="number" min="2" id="mm-int" value="${this.intervalSec}"></div>
          <div class="mm-field"><label>${t('mm.stop_after')}</label><input type="number" min="0" id="mm-count" value="${this.repeatCount}"></div>
          <div class="mm-field"><label>${t('mm.schedule_at')}</label><input type="datetime-local" id="mm-sched" value="${this.scheduleAt}"></div>
        </div>

        <div class="mm-card mm-span-2 mm-actions-card">
          <button class="mm-btn primary" data-mm-action="send">${icon('rocket')} ${t('mm.send_now')}</button>
          <button class="mm-btn warning" data-mm-action="repeat">${icon('repeat')} ${t('mm.start_repeat')}</button>
          <button class="mm-btn success" data-mm-action="schedule">${icon('calendar')} ${t('mm.schedule')}</button>
        </div>
      </div>
    `;
  }

  renderTargetSection() {
    if (this.activeTab === 'server') {
      const opts = this.servers.map(s => `<option value="${s.id}" ${s.id === this.selectedServerId ? 'selected' : ''}>${this.escHtml(s.name)}</option>`).join('');
      return `
        <div class="mm-field"><label>${t('mm.server')}</label>
          <select id="mm-server" onchange="window.messagesManager.onServerChange(this.value)">
            <option value="">${t('mm.select_server')}</option>${opts}
          </select>
        </div>
        <label class="mm-toggle"><input type="checkbox" id="mm-allch" ${this.sendToAllChannels ? 'checked' : ''} onchange="window.messagesManager.sendToAllChannels = this.checked; window.messagesManager.renderChannels()"> ${t('mm.all_channels')}</label>
        <div id="mm-channels-wrap">${this.renderChannelsSection()}</div>
      `;
    }
    if (this.activeTab === 'dms') {
      return `<div class="mm-info-row">${icon('send')} ${t('mm.dms_info')}</div>
              <button class="mm-btn ghost small" onclick="window.messagesManager.previewDMs()">${t('mm.preview_targets')}</button>
              <div id="mm-dm-preview" class="mm-preview"></div>`;
    }
    if (this.activeTab === 'groups') {
      return `<div class="mm-info-row">${icon('users')} ${t('mm.groups_info')}</div>
              <button class="mm-btn ghost small" onclick="window.messagesManager.previewGroups()">${t('mm.preview_targets')}</button>
              <div id="mm-grp-preview" class="mm-preview"></div>`;
    }
    return '';
  }

  renderChannelsSection() {
    if (this.sendToAllChannels) return `<div class="mm-info-row">${t('mm.all_text_channels')}</div>`;
    if (!this.channels.length) return `<div class="mm-info-row mm-muted">${t('mm.select_server_first')}</div>`;
    return `
      <div class="mm-channels">
        ${this.channels.map(c => `
          <label class="mm-chip ${this.selectedChannelIds.includes(c.id) ? 'on' : ''}">
            <input type="checkbox" data-cid="${c.id}" ${this.selectedChannelIds.includes(c.id) ? 'checked' : ''} onchange="window.messagesManager.toggleChannel('${c.id}', this.checked)">
            <span>#${this.escHtml(c.name)}</span>
          </label>`).join('')}
      </div>
    `;
  }

  renderTokenSelector() {
    if (!this.allTokens.length) return `<div class="mm-info-row mm-muted">${t('mm.no_clients')}</div>`;
    return `
      <div class="mm-token-grid">
        ${this.allTokens.map(tk => `
          <label class="mm-token-chip ${this.tokens.includes(tk.name) ? 'on' : ''}">
            <input type="checkbox" data-tname="${tk.name}" ${this.tokens.includes(tk.name) ? 'checked' : ''} onchange="window.messagesManager.toggleToken('${tk.name}', this.checked)">
            <img src="${tk.avatar || '/discord.png'}" onerror="this.src='/discord.png'">
            <div><strong>${this.escHtml(tk.name)}</strong><span>${this.escHtml(tk.username || '')}</span></div>
          </label>
        `).join('')}
      </div>
      <div class="mm-token-actions">
        <button class="mm-btn ghost small" onclick="window.messagesManager.selectAllTokens(true)">${t('tk.select_all')}</button>
        <button class="mm-btn ghost small" onclick="window.messagesManager.selectAllTokens(false)">${t('tk.clear_sel')}</button>
      </div>
    `;
  }

  renderMessagePanels() {
    return this.messages.map((m, i) => `
      <div class="mm-msg-panel" data-i="${i}">
        <div class="mm-msg-head">
          <span>${t('mm.message_n')} #${i + 1}</span>
          ${this.messages.length > 1 ? `<button class="mm-x" onclick="window.messagesManager.removeMessage(${i})" title="${t('common.remove')}">${icon('x')}</button>` : ''}
        </div>
        <textarea rows="3" placeholder="${t('mm.type_msg')}" oninput="window.messagesManager.updateMessage(${i}, this.value)">${this.escHtml(m)}</textarea>
      </div>
    `).join('');
  }

  renderJobsTab() {
    return `
      <div class="mm-card mm-span-2">
        <div class="mm-card-head"><span class="mm-card-icon">${icon('settings')}</span><div><div class="mm-card-title">${t('mm.active_jobs')}</div><div class="mm-card-desc">${t('mm.active_jobs_desc')}</div></div></div>
        <div id="mm-jobs-list">${this.renderJobsList()}</div>
        <button class="mm-btn ghost small" onclick="window.messagesManager.refreshJobs()">${icon('rotate_cw')} ${t('mm.refresh')}</button>
      </div>
    `;
  }

  renderJobsList() {
    if (!this.jobs.length) return `<div class="mm-info-row mm-muted">${t('mm.no_jobs')}</div>`;
    return this.jobs.map(j => `
      <div class="mm-job-item">
        <div>
          <strong>${j.type === 'repeat' ? `${icon('repeat')} ${t('mm.repeating')}` : `${icon('calendar')} ${t('mm.scheduled')}`}</strong>
          <span class="mm-job-meta">${j.info.tokens?.length || 1} ${t('mm.account_s')} · ${j.info.messages?.length || 0} ${t('mm.msg_s')} · ${j.info.scope?.type || ''}</span>
        </div>
        <button class="mm-btn danger small" data-mm-stop="${j.id}">${t('mm.stop')}</button>
      </div>
    `).join('');
  }

  // ─── Events
  bindGlobalEvents() {
    document.getElementById('mm-int')?.addEventListener('input',  e => this.intervalSec = parseInt(e.target.value || '0'));
    document.getElementById('mm-count')?.addEventListener('input', e => this.repeatCount = parseInt(e.target.value || '0'));
    document.getElementById('mm-sched')?.addEventListener('input', e => this.scheduleAt = e.target.value);
  }

  refreshModeUI() {
    document.querySelectorAll('.mm-radio').forEach(el => {
      el.classList.toggle('active', el.querySelector('input')?.checked);
    });
  }

  // ─── Servers / channels
  async loadServers() {
    try {
      const r = await window.electronAPI.getServers();
      this.servers = r.success ? r.servers : [];
      const sel = document.getElementById('mm-server');
      if (sel) {
        sel.innerHTML = `<option value="">${t('mm.select_server')}</option>` +
          this.servers.map(s => `<option value="${s.id}" ${s.id === this.selectedServerId ? 'selected' : ''}>${this.escHtml(s.name)}</option>`).join('');
      }
    } catch (e) {}
  }

  async onServerChange(id) {
    this.selectedServerId = id || null;
    this.selectedChannelIds = [];
    this.channels = [];
    if (!id) { this.renderChannels(); return; }
    try {
      const r = await window.electronAPI.getServerChannels(id);
      this.channels = r.success ? r.channels : [];
    } catch (e) { this.channels = []; }
    this.renderChannels();
  }

  renderChannels() {
    const w = document.getElementById('mm-channels-wrap');
    if (w) w.innerHTML = this.renderChannelsSection();
  }

  toggleChannel(id, on) {
    if (on && !this.selectedChannelIds.includes(id)) this.selectedChannelIds.push(id);
    else if (!on) this.selectedChannelIds = this.selectedChannelIds.filter(x => x !== id);
  }

  toggleToken(name, on) {
    if (on && !this.tokens.includes(name)) this.tokens.push(name);
    else if (!on) this.tokens = this.tokens.filter(x => x !== name);
  }

  selectAllTokens(all) {
    this.tokens = all ? this.allTokens.map(tk => tk.name) : [];
    this.render();
  }

  // ─── Messages
  addMessage() { this.messages.push(''); document.getElementById('mm-messages').innerHTML = this.renderMessagePanels(); }
  removeMessage(i) { this.messages.splice(i, 1); document.getElementById('mm-messages').innerHTML = this.renderMessagePanels(); }
  updateMessage(i, val) { this.messages[i] = val; }

  // ─── Previews
  async previewDMs() {
    const r = await window.electronAPI.getDMs();
    const w = document.getElementById('mm-dm-preview');
    if (!r.success) { w.innerHTML = `<div class="mm-error">${this.escHtml(r.error)}</div>`; return; }
    w.innerHTML = `<div class="mm-preview-title">${r.dms.length} ${t('mm.dms_count')}</div>` +
      r.dms.map(d => `<div class="mm-preview-row"><img src="${d.avatar}" onerror="this.src='/discord.png'"><span>@${this.escHtml(d.username)}</span></div>`).join('');
  }

  async previewGroups() {
    const r = await window.electronAPI.getGroups();
    const w = document.getElementById('mm-grp-preview');
    if (!r.success) { w.innerHTML = `<div class="mm-error">${this.escHtml(r.error)}</div>`; return; }
    w.innerHTML = `<div class="mm-preview-title">${r.groups.length} ${t('mm.groups_count')}</div>` +
      r.groups.map(g => `<div class="mm-preview-row"><img src="${g.icon}" onerror="this.src='/discord.png'"><span>${this.escHtml(g.name)} · ${g.recipients} ${t('mm.ppl')}</span></div>`).join('');
  }

  // ─── Build payload
  buildPayload() {
    const messages = this.messages.map(m => (m || '').trim()).filter(Boolean);
    if (!messages.length) { showNotification(t('mm.add_one')); return null; }

    let scope;
    if (this.activeTab === 'server') {
      if (!this.selectedServerId) { showNotification(t('mm.pick_server')); return null; }
      if (this.sendToAllChannels) scope = { type: 'all_channels', serverId: this.selectedServerId };
      else {
        if (!this.selectedChannelIds.length) { showNotification(t('mm.pick_channel')); return null; }
        scope = { type: 'channel', channelIds: this.selectedChannelIds };
      }
    } else if (this.activeTab === 'dms')    scope = { type: 'all_dms' };
    else if (this.activeTab === 'groups')   scope = { type: 'all_groups' };

    return {
      tokens: this.tokens,
      scope,
      messages,
      mode: { type: this.mode, perMessageDelayMs: this.mode === 'fast' ? 400 : 1500 }
    };
  }

  // Show every test-mode action as a Discord-style preview toast
  _testPreview(action, p) {
    if (!window._testMode) return;
    const where =
      p.scope?.type === 'channel' ? `channel${(p.scope.channelIds || []).length > 1 ? 's' : ''}` :
      p.scope?.type === 'all_channels' ? 'all server channels' :
      p.scope?.type === 'all_dms' ? 'all DMs' :
      p.scope?.type === 'all_groups' ? 'all groups' : 'target';
    (p.messages || []).forEach((m, i) => {
      window.showTestPreview?.(action, m, where, i + 1, (p.messages || []).length);
    });
  }

  async actionSendNow() {
    if (Object.values(this._busy).some(Boolean)) { showNotification(t('mm.busy_action'), 'warning'); return; }
    const p = this.buildPayload(); if (!p) return;
    if (!window.confirm(t('mm.confirm_send'))) return;
    this._busy.sendNow = true;
    const sendBtn = this.contentArea.querySelector('[data-mm-action="send"]');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.dataset.prevHtml = sendBtn.innerHTML; sendBtn.innerHTML = `<span class="dm-mini-spin"></span> ${this._esc(t('mm.sending'))}`; }
    this._testPreview('send', p);
    const totalTokens = (p.tokens && p.tokens.length) || this.allTokens.length || 1;
    const log = openOperationLog({ title: t('mm.op_send_title'), total: totalTokens, cancellable: false });
    try {
      const r = await window.electronAPI.sendMessages(p);
      const results = r.results || [];
      let ok = 0, fail = 0;
      results.forEach((res, i) => {
        const label = res.token || `#${i+1}`;
        const k = `send:${i}`;
        log.start(k, { title: t('mm.op_sending_to').replace('{token}', label), context: label });
        if (res.ok) { ok++; log.success(k, { title: t('mm.op_sent_ok'), detail: label }); }
        else         { fail++; log.fail(k,    { title: t('mm.op_sent_fail'), error: res.error || 'unknown' }); }
      });
      if (!results.length) { ok = 1; log.start('s0', { title: t('mm.op_sending_to').replace('{token}', '…') }); log.success('s0', { title: t('mm.op_sent_ok') }); }
      log.summary({ ok, fail, total: results.length || 1 });
    } catch (e) {
      log.fail('s0', { title: t('mm.op_sent_fail'), error: String(e?.message || e) });
      log.summary({ ok: 0, fail: 1, total: 1 });
    } finally {
      this._busy.sendNow = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = sendBtn.dataset.prevHtml || sendBtn.innerHTML; }
      log.close({ delay: 2000 });
    }
  }

  async actionRepeat() {
    if (Object.values(this._busy).some(Boolean)) { showNotification(t('mm.busy_action'), 'warning'); return; }
    const p = this.buildPayload(); if (!p) return;
    p.intervalMs = Math.max(2000, (this.intervalSec || 60) * 1000);
    p.count = this.repeatCount || 0;
    this._busy.repeat = true;
    const btn = this.contentArea.querySelector('[data-mm-action="repeat"]');
    if (btn) { btn.disabled = true; btn.dataset.prevHtml = btn.innerHTML; btn.innerHTML = `<span class="dm-mini-spin"></span> …`; }
    this._testPreview('repeat', p);
    try {
      const r = await window.electronAPI.startRepeat(p);
      if (r.success) showNotification(`${t('mm.job_started')}: ${r.jobId}`, 'success');
      else showNotification(`${t('mm.failed')}: ${r.error}`, 'error');
    } catch (e) { showNotification(`${t('mm.failed')}: ${e.message}`, 'error'); }
    finally {
      this._busy.repeat = false;
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.prevHtml || btn.innerHTML; }
    }
  }

  async actionSchedule() {
    if (Object.values(this._busy).some(Boolean)) { showNotification(t('mm.busy_action'), 'warning'); return; }
    const p = this.buildPayload(); if (!p) return;
    if (!this.scheduleAt) { showNotification(t('mm.pick_dt')); return; }
    p.runAt = new Date(this.scheduleAt).toISOString();
    this._busy.schedule = true;
    const btn = this.contentArea.querySelector('[data-mm-action="schedule"]');
    if (btn) { btn.disabled = true; btn.dataset.prevHtml = btn.innerHTML; btn.innerHTML = `<span class="dm-mini-spin"></span> …`; }
    this._testPreview('schedule', p);
    try {
      const r = await window.electronAPI.scheduleMessage(p);
      if (r.success) showNotification(`${t('mm.scheduled_in')} ${(r.runIn / 1000) | 0}s`, 'success');
      else showNotification(`${t('mm.failed')}: ${r.error}`, 'error');
    } catch (e) { showNotification(`${t('mm.failed')}: ${e.message}`, 'error'); }
    finally {
      this._busy.schedule = false;
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.prevHtml || btn.innerHTML; }
    }
  }

  async stopJob(id) {
    if (this._stoppingJobs.has(id)) return;
    this._stoppingJobs.add(id);
    try { await window.electronAPI.stopMessageJob(id); } catch (e) {}
    finally { this._stoppingJobs.delete(id); this.refreshJobs(); }
  }

  _esc(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

  escHtml(t) {
    if (t === null || t === undefined) return '';
    return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}
