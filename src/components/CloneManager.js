// Clone Manager — snapshot servers/groups/DMs, save them, paste via webhook (fast) or rebuild server.
// Server snapshots can include messages. Paste UI: multi-select options, per-channel selection, multi-account paste.
import { buildAccountPicker } from '../utils/accountPicker.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';
import { showProgressModal, showToast, pulseButton, showConfirm } from '../utils/ui.js';

export class CloneManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.tab = 'capture';
    this.account = null;
    this.sources = { guilds: [], dms: [], groups: [] };
    this.saved = [];
    this.viewing = null;
    // Paste state
    this.pasteOpts = {
      categories: true, textChannels: true, voiceChannels: true,
      roles: true, rolePerms: false, channelPerms: false,
      emojis: false, messages: false
    };
    this.selectedChannels = null; // null = all, [] = none, [ids] = specific
    this.selectedAccounts = []; // multi-account paste
    this.allClients = [];
    this.presets = []; // saved paste configurations
  }

  async loadPresets() {
    try {
      const r = await window.electronAPI.cloneListPresets();
      this.presets = r.success ? (r.presets || []) : [];
    } catch (e) { this.presets = []; }
  }

  async savePresetAs(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) { showToast(t('cl.preset.need_name'), 'error'); return false; }
    try {
      const r = await window.electronAPI.cloneSavePreset({
        name: trimmed,
        options: { ...this.pasteOpts },
        selectedChannels: this.selectedChannels,
        accounts: [...this.selectedAccounts],
        targetGuildId: this.contentArea.querySelector('#cl-tgt')?.value?.trim() || null
      });
      if (!r.success) throw new Error(r.error || 'Failed');
      await this.loadPresets();
      showToast(t('cl.preset.saved'), 'success');
      return true;
    } catch (e) { showToast(e.message, 'error'); return false; }
  }

  async applyPreset(id, body, s) {
    try {
      const r = await window.electronAPI.cloneGetPreset(id);
      if (!r.success) throw new Error(r.error || 'Failed');
      const p = r.preset;
      this.pasteOpts = { ...this.pasteOpts, ...(p.options || {}) };
      // strip extra (e.g. messageChannelIds) that aren't toggles
      ['messageChannelIds'].forEach(k => delete this.pasteOpts[k]);
      this.selectedChannels = p.selectedChannels === undefined ? null : p.selectedChannels;
      this.selectedAccounts = Array.isArray(p.accounts) ? [...p.accounts] : [];
      // Re-render the options panel
      const old = body.querySelector('.cl-opts-panel');
      const tmp = document.createElement('div');
      tmp.innerHTML = this.renderPasteOptions(s);
      old.replaceWith(tmp.firstElementChild);
      this.bindPasteOptions(body, s);
      // Restore target guild id if saved
      const tgt = body.querySelector('#cl-tgt');
      if (tgt && p.targetGuildId) tgt.value = p.targetGuildId;
      sfx.success();
      showToast(t('cl.preset.loaded'), 'success');
    } catch (e) { showToast(e.message, 'error'); }
  }

  async deletePreset(id, body, s) {
    try {
      const r = await window.electronAPI.cloneDeletePreset(id);
      if (!r.success) throw new Error(r.error || 'Failed');
      await this.loadPresets();
      const old = body.querySelector('.cl-opts-panel');
      const tmp = document.createElement('div');
      tmp.innerHTML = this.renderPasteOptions(s);
      old.replaceWith(tmp.firstElementChild);
      this.bindPasteOptions(body, s);
      showToast(t('cl.preset.deleted'), 'info');
    } catch (e) { showToast(e.message, 'error'); }
  }

  async init() {
    await Promise.all([this.loadAllClients(), this.loadPresets()]);
    await this.render();
  }

  async loadAllClients() {
    try {
      const r = await fetch('/api/discord/clients').then(x => x.json());
      this.allClients = r.success ? (r.clients || []) : [];
    } catch (e) { this.allClients = []; }
  }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('copy')}</span>
            <div>
              <h2 class="mm-title">${t('cl.title')}</h2>
              <p class="mm-subtitle">${t('cl.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs">
            <button class="mm-btn small ${this.tab === 'capture' ? '' : 'ghost'}" id="cl-tab-capture">${icon('archive')} ${t('cl.capture')}</button>
            <button class="mm-btn small ${this.tab === 'saved' ? '' : 'ghost'}" id="cl-tab-saved">${icon('folder')} ${t('cl.saved')}</button>
          </div>
        </div>
        <div class="mm-body" id="cl-body"></div>
      </div>
    `;
    this.contentArea.querySelector('#cl-tab-capture').addEventListener('click', () => { sfx.click(); this.tab = 'capture'; this.viewing = null; this.render(); });
    this.contentArea.querySelector('#cl-tab-saved').addEventListener('click', () => { sfx.click(); this.tab = 'saved'; this.viewing = null; this.render(); });
    if (this.viewing) this.renderViewer();
    else if (this.tab === 'capture') await this.renderCapture();
    else await this.renderSaved();
  }

  async renderCapture() {
    const body = this.contentArea.querySelector('#cl-body');
    body.innerHTML = `<div id="cl-toolbar"></div><div id="cl-srclist"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>`;
    const tb = body.querySelector('#cl-toolbar');
    const picker = await buildAccountPicker({ selectId: 'cl-acct', selected: this.account });
    tb.className = 'mm-tabs';
    tb.innerHTML = `${picker.html}<button class="mm-btn ghost small" id="cl-load">${icon('refresh')} ${t('common.refresh')}</button>`;
    picker.bind(tb, (val) => { this.account = val; this.loadSources(); });
    tb.querySelector('#cl-load').addEventListener('click', () => { sfx.click(); this.loadSources(); });
    await this.loadSources();
  }

  async loadSources() {
    const list = this.contentArea.querySelector('#cl-srclist');
    if (!list) return;
    list.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const q = this.account ? `?account=${encodeURIComponent(this.account)}` : '';
      const r = await fetch('/api/clone/sources' + q).then(x => x.json());
      if (!r.success) { list.innerHTML = `<div class="mm-info-row mm-muted">${this.escHtml(r.error || 'Failed')}</div>`; return; }
      this.sources = r;
      list.innerHTML = `
        <h3 class="cl-h">${icon('shield')} ${t('cl.servers')} (${r.guilds.length})</h3>
        <div class="cl-grid">
          ${r.guilds.map(g => `
            <div class="cl-card">
              <div class="cl-card-head">
                ${g.icon ? `<img src="${g.icon}">` : `<div class="cl-card-ph">${this.escHtml(g.name.charAt(0))}</div>`}
                <div><div class="cl-card-title">${this.escHtml(g.name)}</div><div class="cl-card-sub">${g.members} members ${g.owner ? `· ${icon('crown')} owner` : ''}</div></div>
              </div>
              <div class="cl-card-actions">
                <button class="mm-btn small" data-snap="server" data-id="${g.id}">${icon('archive')} ${t('cl.snapshot')}</button>
              </div>
            </div>
          `).join('') || `<em class="mm-muted">${t('cl.no_servers')}</em>`}
        </div>

        <h3 class="cl-h">${icon('users')} ${t('cl.groups')} (${r.groups.length})</h3>
        <div class="cl-grid">
          ${r.groups.map(g => `
            <div class="cl-card">
              <div class="cl-card-head">
                ${g.icon ? `<img src="${g.icon}">` : `<div class="cl-card-ph">${icon('users')}</div>`}
                <div><div class="cl-card-title">${this.escHtml(g.name)}</div><div class="cl-card-sub">${g.recipients} ${t('cl.recipients')}</div></div>
              </div>
              <div class="cl-card-actions">
                <button class="mm-btn small" data-snap="group" data-id="${g.id}">${icon('archive')} ${t('cl.snapshot')}</button>
              </div>
            </div>
          `).join('') || `<em class="mm-muted">${t('cl.no_groups')}</em>`}
        </div>

        <h3 class="cl-h">${icon('message')} ${t('cl.dms')} (${r.dms.length})</h3>
        <div class="cl-grid">
          ${r.dms.map(d => `
            <div class="cl-card">
              <div class="cl-card-head">
                <img src="${d.icon}" onerror="this.src='/discord.png'">
                <div><div class="cl-card-title">@${this.escHtml(d.name)}</div></div>
              </div>
              <div class="cl-card-actions">
                <button class="mm-btn small" data-snap="dm" data-id="${d.id}">${icon('archive')} ${t('cl.snapshot')}</button>
              </div>
            </div>
          `).join('') || `<em class="mm-muted">${t('cl.no_dms')}</em>`}
        </div>
      `;
      list.querySelectorAll('[data-snap]').forEach(el => el.addEventListener('click', () => this.snapshot(el.dataset.snap, el.dataset.id)));
    } catch (e) { list.innerHTML = `<div class="mm-info-row mm-muted">${e.message}</div>`; }
  }

  async snapshot(kind, id) {
    sfx.click();
    if (kind === 'server') {
      const opts = await this.askCaptureOptions();
      if (!opts) return;
      const m = showProgressModal(t('cl.capturing'), 1);
      try {
        const params = new URLSearchParams();
        if (this.account) params.set('account', this.account);
        if (opts.withMessages) { params.set('messages', '1'); params.set('perChannel', String(opts.perChannel)); }
        const url = `/api/clone/snapshot/server/${id}?${params.toString()}`;
        const r = await fetch(url).then(x => x.json());
        m.updateProgress(1); m.closeModal();
        if (!r.success) { sfx.fail(); showToast(r.error || 'Failed', 'error'); return; }
        sfx.success();
        this.viewing = { snapshot: r.snapshot, name: '' };
        this.selectedChannels = null;
        this.renderViewer();
      } catch (e) { m.closeModal(); sfx.fail(); showToast(e.message, 'error'); }
      return;
    }
    // group / dm — no extra options
    const m = showProgressModal(t('cl.capturing'), 1);
    try {
      const q = this.account ? `?account=${encodeURIComponent(this.account)}` : '';
      const url = kind === 'group' ? `/api/clone/snapshot/group/${id}?limit=200` : `/api/clone/snapshot/dm/${id}?limit=200`;
      const r = await fetch(url + (q ? (url.includes('?') ? '&' : '?') + q.slice(1) : '')).then(x => x.json());
      m.updateProgress(1); m.closeModal();
      if (!r.success) { sfx.fail(); showToast(r.error || 'Failed', 'error'); return; }
      sfx.success();
      this.viewing = { snapshot: r.snapshot, name: '' };
      this.renderViewer();
    } catch (e) { m.closeModal(); sfx.fail(); showToast(e.message, 'error'); }
  }

  askCaptureOptions() {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'cl-modal-back';
      back.innerHTML = `
        <div class="cl-modal" role="dialog" aria-modal="true">
          <div class="cl-modal-head">
            <span style="color:var(--accent)">${icon('archive')}</span>
            <h3>${t('cl.cap.title')}</h3>
          </div>
          <div class="cl-modal-body">
            <label class="cl-cap-row">
              <input type="checkbox" id="cap-msgs">
              <span style="flex:1">${t('cl.cap.with_messages')}</span>
            </label>
            <div class="cl-cap-row" id="cap-pc-wrap" style="display:none">
              <span style="flex:1">${t('cl.cap.per_channel')}</span>
              <input type="number" min="1" max="200" value="50" class="mm-input" id="cap-per-channel">
            </div>
          </div>
          <div class="cl-modal-foot">
            <button class="mm-btn ghost small" id="cap-cancel">${t('common.cancel')}</button>
            <button class="mm-btn small" id="cap-ok">${icon('archive')} ${t('cl.cap.start')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(back);
      const cleanup = () => { try { back.remove(); } catch (e) {} };
      const cb = back.querySelector('#cap-msgs');
      const pcw = back.querySelector('#cap-pc-wrap');
      cb.addEventListener('change', () => { pcw.style.display = cb.checked ? 'flex' : 'none'; });
      back.querySelector('#cap-cancel').addEventListener('click', () => { sfx.click(); cleanup(); resolve(null); });
      back.querySelector('#cap-ok').addEventListener('click', () => {
        sfx.click();
        const withMessages = cb.checked;
        const perChannel = parseInt(back.querySelector('#cap-per-channel').value, 10) || 50;
        cleanup();
        resolve({ withMessages, perChannel });
      });
      back.addEventListener('click', (e) => { if (e.target === back) { cleanup(); resolve(null); } });
    });
  }

  renderViewer() {
    const body = this.contentArea.querySelector('#cl-body');
    if (!body || !this.viewing) return;
    const s = this.viewing.snapshot;
    let summary = '';
    if (s.kind === 'server') {
      const totalMsgs = Object.values(s.channelMessages || {}).reduce((a, b) => a + b.length, 0);
      summary = `
        <div class="cl-summary">
          <div class="cl-sum-cell"><strong>${this.escHtml(s.server.name)}</strong></div>
          <div class="cl-sum-cell">${icon('hash')} ${(s.textChannels || []).length} text</div>
          <div class="cl-sum-cell">${icon('volume')} ${(s.voiceChannels || []).length} voice</div>
          <div class="cl-sum-cell">${icon('folder')} ${(s.categories || []).length} cats</div>
          <div class="cl-sum-cell">${icon('crown')} ${(s.roles || []).length} roles</div>
          <div class="cl-sum-cell">${icon('smile')} ${(s.emojis || []).length} emojis</div>
          ${s.hasMessages ? `<div class="cl-sum-cell">${icon('message')} ${totalMsgs} msgs</div>` : ''}
        </div>
      `;
    } else {
      summary = `
        <div class="cl-summary">
          <div class="cl-sum-cell"><strong>${this.escHtml((s.recipient || s.group)?.name || (s.recipient || s.group)?.username || 'chat')}</strong></div>
          <div class="cl-sum-cell">${icon('message')} ${(s.messages || []).length} ${t('cl.messages')}</div>
        </div>
      `;
    }

    const messagesHtml = s.kind !== 'server'
      ? this.renderChatPreview(s.messages || [])
      : this.renderServerStructure(s);

    const pasteHtml = s.kind === 'server'
      ? this.renderPasteOptions(s)
      : `
        <div class="cl-viewer-actions">
          <input type="text" class="mm-input" id="cl-wh" placeholder="https://discord.com/api/webhooks/...">
          <button class="mm-btn" id="cl-paste-wh">${icon('send')} ${t('cl.paste_wh')}</button>
        </div>
      `;

    body.innerHTML = `
      <div class="cl-viewer">
        <div class="cl-viewer-head">
          <button class="mm-btn ghost small" id="cl-back">${icon('arrow_left')} ${t('common.back')}</button>
          <strong>${t('cl.snapshot')}: ${s.kind}</strong>
        </div>
        ${summary}
        <div class="cl-viewer-actions">
          <input type="text" class="mm-input" id="cl-name" placeholder="${this.escAttr(t('cl.name_ph'))}" value="${this.escAttr(this.viewing.name || '')}">
          <button class="mm-btn" id="cl-save">${icon('archive')} ${t('cl.save')}</button>
        </div>
        ${pasteHtml}
        ${messagesHtml}
      </div>
    `;
    body.querySelector('#cl-back').addEventListener('click', () => { sfx.click(); this.viewing = null; this.render(); });
    body.querySelector('#cl-save').addEventListener('click', async (ev) => {
      sfx.click();
      const name = body.querySelector('#cl-name').value.trim();
      try {
        await pulseButton(ev.currentTarget, async () => {
          const r = await fetch('/api/clone/saved', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snapshot: s, name })
          }).then(x => x.json());
          if (!r.success) throw new Error(r.error || 'Failed');
          return r;
        });
        showToast(t('cl.saved_ok'), 'success');
      } catch (e) { showToast(e.message, 'error'); }
    });
    if (s.kind !== 'server') {
      body.querySelector('#cl-paste-wh').addEventListener('click', async () => {
        sfx.click();
        const url = body.querySelector('#cl-wh').value.trim();
        if (!url) { showToast(t('cl.need_wh'), 'error'); return; }
        const m = showProgressModal(t('cl.pasting'), s.messages.length);
        try {
          const r = await fetch('/api/clone/paste/webhook', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ webhookUrl: url, messages: s.messages, includeAuthor: true })
          }).then(x => x.json());
          m.updateProgress(s.messages.length); m.closeModal();
          if (r.success) {
            sfx.success();
            const okC = (r.results || []).filter(x => x.ok).length;
            showToast(`${t('cl.pasted')}: ${okC}/${s.messages.length}`, okC === s.messages.length ? 'success' : 'info');
          } else { sfx.fail(); showToast(r.error || 'Failed', 'error'); }
        } catch (e) { m.closeModal(); sfx.fail(); showToast(e.message, 'error'); }
      });
    } else {
      this.bindPasteOptions(body, s);
    }
  }

  renderChatPreview(messages) {
    return `
      <div class="cl-msgs">
        ${messages.slice(-30).map(m => `
          <div class="cl-msg">
            <img src="${m.author.avatar}" onerror="this.src='/discord.png'">
            <div>
              <div class="cl-msg-line"><strong>${this.escHtml(m.author.displayName)}</strong> <span class="mm-muted">${this.fmtTime(m.ts)}</span></div>
              <div>${this.escHtml(m.content || '')}</div>
              ${(m.attachments || []).map(a => `<a href="${a.url}" target="_blank" class="cl-att">${icon('image')} ${this.escHtml(a.name)}</a>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  renderServerStructure(s) {
    return `
      <div class="cl-channels">
        ${(s.categories || []).map(c => `
          <div class="cl-cat"><strong>${icon('folder')} ${this.escHtml(c.name)}</strong></div>
          ${(s.textChannels || []).filter(x => x.parent_id === c.id).map(ch => `<div class="cl-ch">${icon('hash')} ${this.escHtml(ch.name)}${(s.channelMessages?.[ch.id]?.length) ? ` <span class="mm-muted">(${s.channelMessages[ch.id].length})</span>` : ''}</div>`).join('')}
          ${(s.voiceChannels || []).filter(x => x.parent_id === c.id).map(ch => `<div class="cl-ch">${icon('volume')} ${this.escHtml(ch.name)}</div>`).join('')}
        `).join('')}
        ${(s.textChannels || []).filter(x => !x.parent_id).map(ch => `<div class="cl-ch">${icon('hash')} ${this.escHtml(ch.name)}${(s.channelMessages?.[ch.id]?.length) ? ` <span class="mm-muted">(${s.channelMessages[ch.id].length})</span>` : ''}</div>`).join('')}
      </div>
    `;
  }

  renderPasteOptions(s) {
    const opts = this.pasteOpts;
    const hasMsgs = !!s.hasMessages;
    const accountChips = this.allClients.length
      ? this.allClients.map(c => {
          const on = this.selectedAccounts.includes(c.name);
          const display = c.displayName || c.username || c.name;
          const handle  = c.username || '';
          const sub = handle && handle !== display ? `<span class="cl-acct-handle">@${this.escHtml(handle)}</span>` : '';
          return `
            <span class="cl-acct-chip ${on ? 'on' : ''}" data-acct="${this.escAttr(c.name)}">
              <img src="${c.avatar || '/discord.png'}" onerror="this.src='/discord.png'">
              <span class="cl-acct-name">${this.escHtml(display)}</span>${sub}
            </span>
          `;
        }).join('')
      : `<em class="mm-muted">${t('cl.no_servers')}</em>`;

    const presetChips = (this.presets || []).map(p => `
      <span class="cl-preset-chip" data-preset="${this.escAttr(p.id)}" title="${this.escAttr(t('cl.preset.click_to_load'))}">
        ${icon('archive')} <span class="cl-preset-name">${this.escHtml(p.name)}</span>
        <button class="cl-preset-x" data-preset-del="${this.escAttr(p.id)}" title="${this.escAttr(t('common.delete'))}">×</button>
      </span>
    `).join('');

    const optionRow = (key, label, extra = '') => `
      <label class="cl-opt-row ${opts[key] ? 'checked' : ''}" data-opt-row="${key}">
        <input type="checkbox" data-opt="${key}" ${opts[key] ? 'checked' : ''}>
        <span class="cl-opt-label">${label}</span>
        ${extra}
      </label>
    `;

    const channelExtra = hasMsgs ? `
      <span class="cl-opt-extra ${opts.messages ? '' : 'disabled'}" id="cl-pick-channels">
        ${this.selectedChannels === null
          ? t('cl.opts.all_channels')
          : t('cl.opts.selected_channels').replace('{n}', this.selectedChannels.length)}
      </span>
    ` : '';

    return `
      <div class="cl-opts-panel">
        <div class="cl-opts-head">
          <h3>${icon('copy')} ${t('cl.opts.title')}</h3>
          <div class="mm-muted">${t('cl.opts.subtitle')}</div>
        </div>

        <div class="cl-presets">
          <div class="cl-presets-head">
            <strong>${icon('archive')} ${t('cl.preset.title')}</strong>
            <span class="mm-muted" style="font-size:12px">${t('cl.preset.subtitle')}</span>
          </div>
          <div class="cl-presets-row">
            <input type="text" class="mm-input" id="cl-preset-name" placeholder="${this.escAttr(t('cl.preset.name_ph'))}">
            <button class="mm-btn small" id="cl-preset-save">${icon('plus')} ${t('cl.preset.save')}</button>
          </div>
          <div class="cl-preset-chips" id="cl-preset-chips">
            ${presetChips || `<em class="mm-muted">${t('cl.preset.empty')}</em>`}
          </div>
        </div>

        <div class="cl-opts-grid">
          ${optionRow('categories',    t('cl.opts.categories'))}
          ${optionRow('textChannels',  t('cl.opts.text_channels'))}
          ${optionRow('voiceChannels', t('cl.opts.voice_channels'))}
          ${optionRow('roles',         t('cl.opts.roles'))}
          ${optionRow('rolePerms',     t('cl.opts.role_perms'))}
          ${optionRow('channelPerms',  t('cl.opts.channel_perms'))}
          ${optionRow('emojis',        t('cl.opts.emojis'))}
          ${hasMsgs ? optionRow('messages', t('cl.opts.messages'), channelExtra) : ''}
        </div>

        <div class="mm-section-title">${t('cl.opts.accounts')}</div>
        <div class="mm-muted" style="font-size:12px;margin-bottom:6px">${t('cl.opts.accounts_help')}</div>
        <div class="cl-acct-chips" id="cl-acct-chips">${accountChips}</div>

        <div class="cl-opts-actions">
          <input type="text" class="mm-input" id="cl-tgt" placeholder="${this.escAttr(t('cl.opts.target'))}">
          <button class="mm-btn" id="cl-build">${icon('shield')} ${t('cl.opts.start')}</button>
        </div>
      </div>
    `;
  }

  bindPasteOptions(body, s) {
    body.querySelectorAll('[data-opt-row]').forEach(row => {
      const key = row.dataset.optRow;
      row.addEventListener('click', (e) => {
        // Avoid double-toggle when clicking the inner checkbox or the channel-pick chip.
        if (e.target.closest('#cl-pick-channels')) return;
        if (e.target.tagName !== 'INPUT') {
          e.preventDefault();
          this.pasteOpts[key] = !this.pasteOpts[key];
        } else {
          this.pasteOpts[key] = e.target.checked;
        }
        sfx.click();
        // Refresh just the panel
        const old = body.querySelector('.cl-opts-panel');
        const tmp = document.createElement('div');
        tmp.innerHTML = this.renderPasteOptions(s);
        old.replaceWith(tmp.firstElementChild);
        this.bindPasteOptions(body, s);
      });
    });

    const pick = body.querySelector('#cl-pick-channels');
    if (pick) {
      pick.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.pasteOpts.messages) return;
        sfx.click();
        this.openChannelPicker(s, body);
      });
    }

    body.querySelectorAll('.cl-acct-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        sfx.click();
        const name = chip.dataset.acct;
        const i = this.selectedAccounts.indexOf(name);
        if (i >= 0) this.selectedAccounts.splice(i, 1);
        else this.selectedAccounts.push(name);
        chip.classList.toggle('on');
      });
    });

    // Preset save
    const saveBtn = body.querySelector('#cl-preset-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        sfx.click();
        const inp = body.querySelector('#cl-preset-name');
        const name = inp?.value?.trim();
        if (!name) { showToast(t('cl.preset.need_name'), 'error'); return; }
        const okSave = await this.savePresetAs(name);
        if (okSave) {
          inp.value = '';
          const old = body.querySelector('.cl-opts-panel');
          const tmp = document.createElement('div');
          tmp.innerHTML = this.renderPasteOptions(s);
          old.replaceWith(tmp.firstElementChild);
          this.bindPasteOptions(body, s);
        }
      });
    }

    // Preset chips: load or delete
    body.querySelectorAll('.cl-preset-chip').forEach(chip => {
      chip.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-preset-del]');
        if (delBtn) {
          e.stopPropagation();
          const okDel = await showConfirm(t('cl.preset.confirm_delete'), { confirmText: t('common.delete'), cancelText: t('common.cancel') });
          if (!okDel) return;
          await this.deletePreset(delBtn.dataset.presetDel, body, s);
          return;
        }
        sfx.click();
        await this.applyPreset(chip.dataset.preset, body, s);
      });
    });

    body.querySelector('#cl-build').addEventListener('click', async (ev) => {
      sfx.click();
      const targetGuildId = body.querySelector('#cl-tgt').value.trim();
      if (!targetGuildId) { showToast(t('cl.need_target'), 'error'); return; }

      const someOpt = Object.entries(this.pasteOpts).some(([k, v]) => v &&
        ['categories','textChannels','voiceChannels','roles','rolePerms','channelPerms','emojis','messages'].includes(k));
      if (!someOpt) { showToast(t('cl.opts.need_one'), 'error'); return; }

      const accounts = this.selectedAccounts.length
        ? this.selectedAccounts
        : (this.account ? [this.account] : []);
      if (!accounts.length) { showToast(t('cl.opts.need_account'), 'error'); return; }

      const okGo = await showConfirm(t('cl.confirm_build'), { confirmText: t('cl.opts.start'), cancelText: t('common.cancel') });
      if (!okGo) return;

      const m = showProgressModal(t('cl.building'), 1);
      try {
        const r = await fetch('/api/clone/paste/server-build', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accounts,
            snapshot: s,
            targetGuildId,
            options: {
              ...this.pasteOpts,
              messageChannelIds: this.pasteOpts.messages ? this.selectedChannels : null
            }
          })
        }).then(x => x.json());
        m.closeModal();
        if (r.success) {
          sfx.success();
          this.showReport(r.created || {});
        } else {
          sfx.fail(); showToast(r.error || 'Failed', 'error');
        }
      } catch (e) { m.closeModal(); sfx.fail(); showToast(e.message, 'error'); }
    });
  }

  openChannelPicker(s, body) {
    const channels = (s.textChannels || []).map(ch => ({
      id: ch.id, name: ch.name, parent_id: ch.parent_id,
      msgCount: s.channelMessages?.[ch.id]?.length || 0
    }));
    const categories = s.categories || [];
    const sel = new Set(this.selectedChannels === null ? channels.map(c => c.id) : this.selectedChannels);

    const back = document.createElement('div');
    back.className = 'cl-modal-back';

    const renderRows = (filter) => {
      const f = (filter || '').toLowerCase();
      const matches = channels.filter(c => !f || c.name.toLowerCase().includes(f));
      let html = '';
      const grouped = new Map();
      for (const ch of matches) {
        const k = ch.parent_id || '__none';
        if (!grouped.has(k)) grouped.set(k, []);
        grouped.get(k).push(ch);
      }
      for (const cat of categories) {
        const items = grouped.get(cat.id);
        if (!items?.length) continue;
        html += `<div class="cl-channel-row cat"><span class="cl-ch-name">${icon('folder')} ${this.escHtml(cat.name)}</span></div>`;
        for (const ch of items) {
          html += `
            <label class="cl-channel-row" data-ch="${ch.id}">
              <input type="checkbox" ${sel.has(ch.id) ? 'checked' : ''}>
              <span>${icon('hash')}</span>
              <span class="cl-ch-name">${this.escHtml(ch.name)}</span>
              ${ch.msgCount ? `<span class="mm-muted">${ch.msgCount} ${t('cl.messages')}</span>` : ''}
            </label>`;
        }
      }
      const orphans = grouped.get('__none');
      if (orphans?.length) {
        html += `<div class="cl-channel-row cat"><span class="cl-ch-name">— uncategorized —</span></div>`;
        for (const ch of orphans) {
          html += `
            <label class="cl-channel-row" data-ch="${ch.id}">
              <input type="checkbox" ${sel.has(ch.id) ? 'checked' : ''}>
              <span>${icon('hash')}</span>
              <span class="cl-ch-name">${this.escHtml(ch.name)}</span>
              ${ch.msgCount ? `<span class="mm-muted">${ch.msgCount} ${t('cl.messages')}</span>` : ''}
            </label>`;
        }
      }
      return html || `<em class="mm-muted">${t('cl.no_servers')}</em>`;
    };

    back.innerHTML = `
      <div class="cl-modal" role="dialog" aria-modal="true">
        <div class="cl-modal-head">
          <span style="color:var(--accent)">${icon('hash')}</span>
          <h3>${t('cl.opts.choose_channels')}</h3>
        </div>
        <div class="cl-modal-body">
          <input type="text" class="cl-modal-search" id="cl-pick-search" placeholder="${this.escAttr(t('cl.opts.search_channels'))}">
          <div class="cl-channel-list" id="cl-pick-list">${renderRows('')}</div>
        </div>
        <div class="cl-modal-foot">
          <button class="mm-btn ghost small" id="cl-pick-clear">${t('cl.opts.clear_all')}</button>
          <button class="mm-btn ghost small" id="cl-pick-all">${t('cl.opts.select_all')}</button>
          <span style="flex:1"></span>
          <button class="mm-btn ghost small" id="cl-pick-cancel">${t('common.cancel')}</button>
          <button class="mm-btn small" id="cl-pick-ok">${icon('check')} ${t('cl.opts.done')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(back);
    const list = back.querySelector('#cl-pick-list');
    const cleanup = () => { try { back.remove(); } catch (e) {} };

    const bindRows = () => {
      list.querySelectorAll('[data-ch]').forEach(row => {
        row.addEventListener('change', () => {
          const id = row.dataset.ch;
          const cb = row.querySelector('input');
          if (cb.checked) sel.add(id); else sel.delete(id);
        });
      });
    };
    bindRows();

    back.querySelector('#cl-pick-search').addEventListener('input', (e) => {
      list.innerHTML = renderRows(e.target.value);
      bindRows();
    });
    back.querySelector('#cl-pick-clear').addEventListener('click', () => {
      sfx.click();
      sel.clear();
      list.innerHTML = renderRows(back.querySelector('#cl-pick-search').value);
      bindRows();
    });
    back.querySelector('#cl-pick-all').addEventListener('click', () => {
      sfx.click();
      channels.forEach(c => sel.add(c.id));
      list.innerHTML = renderRows(back.querySelector('#cl-pick-search').value);
      bindRows();
    });
    back.querySelector('#cl-pick-cancel').addEventListener('click', () => { sfx.click(); cleanup(); });
    back.querySelector('#cl-pick-ok').addEventListener('click', () => {
      sfx.click();
      this.selectedChannels = sel.size === channels.length ? null : Array.from(sel);
      cleanup();
      // Refresh the paste panel to update the chip text.
      const old = body.querySelector('.cl-opts-panel');
      const tmp = document.createElement('div');
      tmp.innerHTML = this.renderPasteOptions(s);
      old.replaceWith(tmp.firstElementChild);
      this.bindPasteOptions(body, s);
    });
    back.addEventListener('click', (e) => { if (e.target === back) cleanup(); });
  }

  showReport(created) {
    const back = document.createElement('div');
    back.className = 'cl-modal-back';
    const errs = (created.errors || []).slice(0, 8);
    const more = (created.errors || []).length - errs.length;
    back.innerHTML = `
      <div class="cl-modal" role="dialog" aria-modal="true">
        <div class="cl-modal-head">
          <span style="color:var(--success, #27ae60)">${icon('check')}</span>
          <h3>${t('cl.report.title')}</h3>
        </div>
        <div class="cl-modal-body">
          <h4 style="margin:0 0 10px">${t('cl.report.created')}</h4>
          <div class="cl-summary">
            <div class="cl-sum-cell">${icon('folder')} ${created.categories || 0} cats</div>
            <div class="cl-sum-cell">${icon('hash')} ${created.textChannels || 0} text</div>
            <div class="cl-sum-cell">${icon('volume')} ${created.voiceChannels || 0} voice</div>
            <div class="cl-sum-cell">${icon('crown')} ${created.roles || 0} roles</div>
            <div class="cl-sum-cell">${icon('shield')} ${created.channelPerms || 0} perms</div>
            <div class="cl-sum-cell">${icon('smile')} ${created.emojis || 0} emojis</div>
            <div class="cl-sum-cell">${icon('message')} ${created.messagesPosted || 0} msgs</div>
          </div>
          ${errs.length ? `
            <h4 style="margin:14px 0 6px">${t('cl.report.errors')} (${(created.errors || []).length})</h4>
            <ul class="mm-muted" style="margin:0;padding-inline-start:20px;font-size:12px">
              ${errs.map(e => `<li>${this.escHtml(e)}</li>`).join('')}
              ${more > 0 ? `<li>… +${more} more</li>` : ''}
            </ul>
          ` : ''}
        </div>
        <div class="cl-modal-foot">
          <button class="mm-btn small" id="cl-rep-ok">${icon('check')} ${t('common.close')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(back);
    const cleanup = () => { try { back.remove(); } catch (e) {} };
    back.querySelector('#cl-rep-ok').addEventListener('click', () => { sfx.click(); cleanup(); });
    back.addEventListener('click', (e) => { if (e.target === back) cleanup(); });
  }

  async renderSaved() {
    const body = this.contentArea.querySelector('#cl-body');
    body.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const r = await fetch('/api/clone/saved').then(x => x.json());
      if (!r.success) { body.innerHTML = `<div class="mm-info-row mm-muted">${r.error}</div>`; return; }
      this.saved = r.snapshots || [];
      if (!this.saved.length) { body.innerHTML = `<div class="mm-info-row mm-muted">${t('cl.no_saved')}</div>`; return; }
      body.innerHTML = `
        <div class="cl-saved-list">
          ${this.saved.map(s => `
            <div class="cl-saved-row">
              <div class="cl-saved-icon">${icon(s.kind === 'server' ? 'shield' : s.kind === 'group' ? 'users' : 'message')}</div>
              <div class="cl-saved-meta">
                <strong>${this.escHtml(s.name)}</strong>
                <div class="mm-muted">${s.kind} · ${this.fmtTime(s.savedAt)} · ${this.escHtml(JSON.stringify(s.summary))}</div>
              </div>
              <div class="cl-saved-actions">
                <button class="mm-btn ghost small" data-open="${s.id}">${icon('image')} ${t('cl.open')}</button>
                <button class="mm-btn danger small" data-del="${s.id}">${icon('trash')} ${t('common.delete')}</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      body.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', async () => {
        sfx.click();
        const r = await fetch('/api/clone/saved/' + el.dataset.open).then(x => x.json());
        if (r.success) { this.viewing = { snapshot: r.snapshot, name: r.name }; this.selectedChannels = null; this.renderViewer(); }
      }));
      body.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', async () => {
        const ok = await showConfirm(t('cl.confirm_delete'), { confirmText: t('common.delete'), cancelText: t('common.cancel') });
        if (!ok) return;
        sfx.click();
        await fetch('/api/clone/saved/' + el.dataset.del, { method: 'DELETE' });
        this.renderSaved();
      }));
    } catch (e) { body.innerHTML = `<div class="mm-info-row mm-muted">${e.message}</div>`; }
  }

  fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
