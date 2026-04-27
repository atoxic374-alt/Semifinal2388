// SearchManager — find any Discord user by ID or display/username, even if not friend.
// Shows: profile, mutual servers, mutual friends count, last seen message,
// live voice state (with everyone in the voice channel), capable of "screenshot voice".
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification, showConfirm } from '../utils/ui.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';

export class SearchManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.allAccounts = true;
    this.query = '';
    this.mode = 'auto';   // 'id' | 'username' | 'auto'
    this.result = null;
    this.candidates = null;
    this.loading = false;
    this.poll = null;
    this._suggTimer = null;
  }

  async init() { await this.render(); }
  async refresh() { await this.render(); }

  async render() {
    const acctPick = await buildAccountPicker({ selectId: 'sm-acct', selected: this.account });
    this.contentArea.innerHTML = `
      <div class="sm-wrap">
        <div class="sm-head">
          <div class="sm-title-row">
            <h1>${icon('search')} ${t('sm.title')}</h1>
            <p>${t('sm.subtitle')}</p>
          </div>
          <div class="sm-controls">
            <div class="sm-acct">${acctPick.html}</div>
            <label class="sm-all">
              <input type="checkbox" id="sm-all" ${this.allAccounts ? 'checked' : ''}>
              <span>${t('sm.search_all_accounts')}</span>
            </label>
          </div>
          <div class="sm-search" style="position:relative">
            <input type="text" id="sm-query" placeholder="${t('sm.placeholder')}" value="${escapeAttr(this.query)}" autocomplete="off">
            <select id="sm-mode">
              <option value="auto"${this.mode==='auto'?' selected':''}>${t('sm.mode_auto')}</option>
              <option value="id"${this.mode==='id'?' selected':''}>${t('sm.mode_id')}</option>
              <option value="username"${this.mode==='username'?' selected':''}>${t('sm.mode_username')}</option>
            </select>
            <button id="sm-go" class="sm-go-btn">${icon('search')} ${t('sm.go')}</button>
            <div id="sm-dropdown" class="sm-suggest-dropdown" style="display:none"></div>
          </div>
        </div>

        <div class="sm-body" id="sm-body">
          ${this.loading ? `<div class="sm-loading"><div class="lux-spinner"></div><p>${t('sm.searching')}</p></div>` : this.renderResultHTML()}
        </div>
      </div>
    `;

    acctPick.bind?.(this.contentArea);
    const acctSel = this.contentArea.querySelector('#sm-acct');
    acctSel?.addEventListener('change', () => { this.account = acctSel.value || null; });
    this.contentArea.querySelector('#sm-all').addEventListener('change', e => { this.allAccounts = e.target.checked; });
    this.contentArea.querySelector('#sm-mode').addEventListener('change', e => { this.mode = e.target.value; });
    const inp = this.contentArea.querySelector('#sm-query');
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { this._closeDropdown(); this.runSearch(); }
      if (e.key === 'Escape') this._closeDropdown();
    });
    inp.addEventListener('input', () => this._onQueryInput());
    inp.addEventListener('focus', () => { if (inp.value.trim()) this._onQueryInput(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sm-search')) this._closeDropdown();
    }, { capture: true, once: false });
    this.contentArea.querySelector('#sm-go').addEventListener('click', () => { this._closeDropdown(); this.runSearch(); });

    this.bindResultActions();
  }

  _closeDropdown() {
    const d = this.contentArea?.querySelector('#sm-dropdown');
    if (d) d.style.display = 'none';
  }

  _onQueryInput() {
    clearTimeout(this._suggTimer);
    const inp = this.contentArea?.querySelector('#sm-query');
    const q = (inp?.value || '').trim();
    if (!q || q.length < 1 || /^\d{15,22}$/.test(q)) { this._closeDropdown(); return; }
    this._suggTimer = setTimeout(() => this._fetchSuggestions(q), 160);
  }

  async _fetchSuggestions(q) {
    try {
      const params = new URLSearchParams({ q });
      if (this.account) params.set('account', this.account);
      const r = await fetch('/api/search/suggest?' + params).then(x => x.json());
      this._renderDropdown(r.suggestions || []);
    } catch (_) {}
  }

  _renderDropdown(suggestions) {
    const dd = this.contentArea?.querySelector('#sm-dropdown');
    if (!dd) return;
    if (!suggestions.length) { dd.style.display = 'none'; return; }
    dd.style.display = '';
    dd.innerHTML = suggestions.map(s => `
      <button class="sm-suggest-item" data-id="${escapeAttr(s.id)}">
        <img src="${escapeAttr(s.avatar)}" alt="" onerror="this.src='/discord.png'">
        <div class="sm-suggest-text">
          <span class="sm-suggest-name">${escapeHtml(s.globalName || s.username)}</span>
          <span class="sm-suggest-sub">@${escapeHtml(s.username)}</span>
        </div>
      </button>
    `).join('');
    dd.querySelectorAll('.sm-suggest-item').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        const inp = this.contentArea?.querySelector('#sm-query');
        if (inp) inp.value = id;
        this.query = id;
        this.mode = 'id';
        const modeEl = this.contentArea?.querySelector('#sm-mode');
        if (modeEl) modeEl.value = 'id';
        this._closeDropdown();
        this.runSearch();
      });
    });
  }

  renderResultHTML() {
    if (this.candidates) {
      return `
        <div class="sm-card sm-candidates">
          <h3>${t('sm.multiple_matches')}</h3>
          <div class="sm-cand-list">
            ${this.candidates.map(c => `
              <button class="sm-cand" data-id="${c.id}">
                <img src="${escapeAttr(c.avatar)}" alt="">
                <div>
                  <div class="sm-cand-name">${escapeHtml(c.globalName || c.username)}</div>
                  <div class="sm-cand-sub">@${escapeHtml(c.username)} · ${c.id}</div>
                </div>
              </button>`).join('')}
          </div>
        </div>`;
    }
    if (!this.result) return `<div class="sm-empty">${icon('search')}<p>${t('sm.empty_hint')}</p></div>`;

    const r = this.result;
    const u = r.user;
    const created = u.createdAt ? new Date(u.createdAt).toLocaleString() : '';
    return `
      <div class="sm-card sm-profile" style="${u.banner ? `background-image:linear-gradient(180deg,rgba(11,15,26,0) 40%, rgba(11,15,26,.95)), url(${escapeAttr(u.banner)})` : ''}">
        <div class="sm-prof-row">
          <img class="sm-avatar" src="${escapeAttr(u.avatar)}" alt="">
          <div class="sm-prof-text">
            <h2>${escapeHtml(u.globalName || u.username)} ${u.bot ? '<span class="sm-bot">BOT</span>' : ''}</h2>
            <div class="sm-uname">@${escapeHtml(u.username)}</div>
            <div class="sm-id" data-copy="${u.id}" title="${t('sm.click_to_copy')}">${u.id}</div>
            ${u.pronouns ? `<div class="sm-pron">${escapeHtml(u.pronouns)}</div>` : ''}
            ${u.bio ? `<div class="sm-bio">${escapeHtml(u.bio)}</div>` : ''}
            <div class="sm-meta">
              <span>${t('sm.created')}: ${created}</span>
              ${r.mutualFriendsCount ? `<span>${t('sm.mutual_friends')}: ${r.mutualFriendsCount}</span>` : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="sm-grid">
        <div class="sm-card sm-card-voice">
          <div class="sm-card-head"><h3>${icon('volume')} ${t('sm.voice')}</h3>
            <button class="sm-refresh" data-act="voice">${icon('refresh')}</button>
            ${r.voice && r.voice.length ? `<button class="sm-shot" data-act="screenshot">${icon('image')} ${t('sm.screenshot')}</button>` : ''}
          </div>
          <div class="sm-voice-body">${this.renderVoiceHTML(r.voice)}</div>
        </div>

        <div class="sm-card sm-card-last">
          <div class="sm-card-head"><h3>${icon('chat')} ${t('sm.last_message')}</h3>
            <button class="sm-refresh" data-act="lastmsg">${icon('refresh')}</button>
          </div>
          <div class="sm-last-body">${this.renderLastMessageHTML(r.lastMessage)}</div>
        </div>

        <div class="sm-card sm-card-mutual">
          <div class="sm-card-head"><h3>${icon('users')} ${t('sm.mutual_servers')} <span class="sm-count">${r.mutualGuilds?.length || 0}</span></h3></div>
          <div class="sm-mutual-list">
            ${(r.mutualGuilds || []).map(g => `
              <div class="sm-mutual">
                ${g.icon ? `<img src="${escapeAttr(g.icon)}" alt="">` : `<div class="sm-mutual-fallback">${escapeHtml((g.name||'?').charAt(0))}</div>`}
                <div>
                  <div class="sm-mutual-name">${escapeHtml(g.name)}</div>
                  <div class="sm-mutual-sub">${g.id} · ${escapeHtml((g.sharedBy || []).join(', '))}</div>
                </div>
              </div>`).join('') || `<div class="sm-empty-sm">${t('sm.no_mutuals')}</div>`}
          </div>
        </div>

        <div class="sm-card sm-card-actions">
          <div class="sm-card-head"><h3>${icon('rocket')} ${t('sm.actions')}</h3></div>
          <div class="sm-actions">
            <button class="sm-act" data-act="addfriend" data-id="${u.id}">${icon('user_plus')||icon('users')} ${t('sm.add_friend')}</button>
            <button class="sm-act" data-act="opendm" data-id="${u.id}">${icon('chat')} ${t('sm.open_dm')}</button>
            <button class="sm-act" data-act="copyid" data-copy="${u.id}">${t('sm.copy_id')}</button>
          </div>
        </div>
      </div>
    `;
  }

  renderVoiceHTML(voice) {
    if (!voice || !voice.length) return `<div class="sm-empty-sm">${t('sm.not_in_voice')}</div>`;
    return voice.map(v => `
      <div class="sm-voice" id="sm-voice-card">
        <div class="sm-voice-head">
          <div class="sm-voice-where">
            ${v.guild?.icon ? `<img src="${escapeAttr(v.guild.icon)}" alt="">` : ''}
            <div>
              <div class="sm-voice-server">${escapeHtml(v.guild?.name || '?')}</div>
              <div class="sm-voice-channel">🔊 ${escapeHtml(v.channel?.name || '?')}</div>
            </div>
          </div>
          <div class="sm-voice-state">
            ${v.target.mute ? `<span class="sm-st mute">${t('sm.muted')}</span>` : ''}
            ${v.target.deaf ? `<span class="sm-st deaf">${t('sm.deafened')}</span>` : ''}
            ${v.target.video ? `<span class="sm-st video">${t('sm.video')}</span>` : ''}
            ${v.target.stream ? `<span class="sm-st stream">${t('sm.streaming')}</span>` : ''}
          </div>
        </div>
        <div class="sm-voice-occupants">
          ${(v.occupants || []).map(o => `
            <div class="sm-occ ${o.target ? 'target' : ''} ${o.self ? 'self' : ''}">
              <img src="${escapeAttr(o.avatar)}" alt="">
              <div class="sm-occ-name">${escapeHtml(o.displayName)}</div>
              <div class="sm-occ-icons">
                ${o.mute ? '🔇' : ''}${o.deaf ? '🙉' : ''}${o.video ? '📹' : ''}${o.stream ? '📺' : ''}
              </div>
            </div>`).join('')}
        </div>
        <div class="sm-voice-foot">${t('sm.seen_by')}: ${escapeHtml(v.seenBy)}</div>
      </div>
    `).join('');
  }

  renderLastMessageHTML(m) {
    if (!m) return `<div class="sm-empty-sm">${t('sm.no_last_msg')}</div>`;
    const when = m.message?.ts ? new Date(m.message.ts).toLocaleString() : '';
    return `
      <div class="sm-last">
        <div class="sm-last-where">
          ${m.kind === 'dm' ? '📩 DM' : `🏷 ${escapeHtml(m.guild?.name || '')} / #${escapeHtml(m.channel?.name || '')}`}
          <span class="sm-last-when">${when}</span>
        </div>
        <div class="sm-last-content">${escapeHtml(m.message?.content || '(no text)')}</div>
        ${(m.message?.attachments || []).length ? `<div class="sm-last-att">📎 ${m.message.attachments.length} attachment(s)</div>` : ''}
        <div class="sm-last-foot">${t('sm.seen_by')}: ${escapeHtml(m.seenBy)}</div>
      </div>`;
  }

  bindResultActions() {
    this.contentArea.querySelectorAll('.sm-cand').forEach(b => {
      b.addEventListener('click', () => { this.candidates = null; this.query = b.dataset.id; this.mode = 'id'; this.runSearch(); });
    });
    this.contentArea.querySelectorAll('[data-copy]').forEach(el => {
      el.addEventListener('click', () => {
        navigator.clipboard.writeText(el.dataset.copy).then(() => { showNotification(t('common.copied'), 'success'); sfx.click(); });
      });
    });
    this.contentArea.querySelectorAll('.sm-refresh').forEach(b => {
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'voice') this.refreshVoice();
        if (a === 'lastmsg') this.refreshLastMessage();
      });
    });
    this.contentArea.querySelector('[data-act="screenshot"]')?.addEventListener('click', () => this.takeVoiceScreenshot());
    this.contentArea.querySelectorAll('.sm-act').forEach(b => {
      b.addEventListener('click', async () => {
        const a = b.dataset.act, id = b.dataset.id;
        if (a === 'addfriend') {
          if (!await showConfirm(t('sm.confirm_add_friend'), { confirmText: t('common.confirm') || 'OK', cancelText: t('common.cancel') })) return;
          try {
            const r = await fetch('/api/friends/bulk-add', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ account: this.account || undefined, ids: [id], throttleMs: 1000, max: 1 })
            }).then(x => x.json());
            if (r.success) { showNotification(t('sm.add_started'), 'success'); sfx.ding?.(); }
            else showNotification(r.error || 'Failed', 'error');
          } catch (e) { showNotification(String(e.message || e), 'error'); }
        }
        if (a === 'opendm') {
          showNotification(t('sm.opening_dm'), 'info');
          // Use existing private/DM endpoints
          try {
            await fetch('/api/discord/dm/open', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ account: this.account || undefined, userId: id })
            });
            showNotification(t('sm.dm_opened'), 'success');
          } catch (e) { showNotification(String(e.message || e), 'error'); }
        }
      });
    });
  }

  async runSearch() {
    const inp = this.contentArea.querySelector('#sm-query');
    this.query = (inp?.value || '').trim();
    if (!this.query) { showNotification(t('sm.empty_query'), 'error'); return; }
    this.candidates = null; this.result = null; this.loading = true;
    await this.render();
    sfx.click();

    const params = new URLSearchParams();
    if (this.mode === 'id') params.set('id', this.query);
    else if (this.mode === 'username') params.set('username', this.query);
    else { /* auto */ if (/^\d{15,22}$/.test(this.query)) params.set('id', this.query); else params.set('username', this.query); }
    if (this.account) params.set('account', this.account);
    if (this.allAccounts) params.set('all', '1');

    try {
      const r = await fetch('/api/search/user?' + params.toString()).then(x => x.json());
      this.loading = false;
      if (!r.success) { showNotification(r.error || 'Failed', 'error'); await this.render(); return; }
      if (r.multiple) { this.candidates = r.candidates; await this.render(); return; }
      this.result = r;
      sfx.ding?.();
      await this.render();
      this.startVoicePoll();
    } catch (e) {
      this.loading = false; showNotification(String(e.message || e), 'error'); await this.render();
    }
  }

  startVoicePoll() {
    if (this.poll) clearInterval(this.poll);
    if (!this.result?.user?.id) return;
    this.poll = setInterval(() => this.refreshVoice(), 5000);
  }
  destroy() { if (this.poll) clearInterval(this.poll); this.poll = null; }

  async refreshVoice() {
    if (!this.result?.user?.id) return;
    const params = new URLSearchParams();
    if (this.account) params.set('account', this.account);
    try {
      const r = await fetch(`/api/search/voice/${this.result.user.id}?${params}`).then(x => x.json());
      if (!r.success) return;
      this.result.voice = r.voice;
      const body = this.contentArea.querySelector('.sm-voice-body');
      if (body) body.innerHTML = this.renderVoiceHTML(this.result.voice);
    } catch (_) {}
  }
  async refreshLastMessage() {
    if (!this.result?.user?.id) return;
    const params = new URLSearchParams();
    if (this.account) params.set('account', this.account);
    try {
      const r = await fetch(`/api/search/last-message/${this.result.user.id}?${params}`).then(x => x.json());
      if (!r.success) return;
      this.result.lastMessage = r.messages?.[0] || null;
      const body = this.contentArea.querySelector('.sm-last-body');
      if (body) body.innerHTML = this.renderLastMessageHTML(this.result.lastMessage);
    } catch (_) {}
  }

  takeVoiceScreenshot() {
    const node = this.contentArea.querySelector('.sm-card-voice');
    if (!node) return;
    // Pure-DOM SVG snapshot — works without external libs.
    try {
      const rect = node.getBoundingClientRect();
      const html = node.outerHTML.replace(/<button[\s\S]*?<\/button>/g, '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(rect.width)}" height="${Math.ceil(rect.height)}">
        <foreignObject width="100%" height="100%">
          <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Inter,system-ui;background:#0b0f1a;color:#fff;padding:16px;border-radius:12px;width:${Math.ceil(rect.width)-32}px;">
            ${html.replace(/<svg/g, '<svg').replace(/<img /g, '<img crossorigin="anonymous" ')}
          </div>
        </foreignObject>
      </svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `voice-${this.result?.user?.username || 'user'}.svg`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      sfx.ding?.();
      showNotification(t('sm.screenshot_saved'), 'success');
    } catch (e) { showNotification(String(e.message || e), 'error'); }
  }
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
