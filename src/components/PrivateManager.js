// Private Manager — multi-account real-time DM viewer with attachments, reactions, replies, image upload.
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification } from '../utils/ui.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];

export class PrivateManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.botsOnly = false;
    this.search = '';
    this.dms = [];
    this.activeDM = null;
    this.messages = [];
    this.currentUserId = null;
    this.es = null;
    this.connState = 'connecting';
    this.sending = false;
    this.unread = new Map();
    this.replyTo = null;          // {id, content, author}
    this.pendingFiles = [];       // {dataUrl, name, contentType, previewUrl}
    this._initialized = false;
  }

  async init() {
    this._initialized = true;
    await this.render();
    this.connectStream();
  }

  async refresh() { await this.render(); }

  // ─── SSE realtime
  connectStream() {
    this.disconnectStream();
    const q = this.account ? `?account=${encodeURIComponent(this.account)}` : '';
    this.connState = 'connecting'; this.updateConnPill();
    try {
      const es = new EventSource('/api/private/stream' + q);
      this.es = es;
      es.onopen = () => { this.connState = 'live'; this.updateConnPill(); };
      es.onerror = () => { this.connState = 'down'; this.updateConnPill(); };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'dm') this.onIncomingDM(data);
          else if (data.type === 'dm_delete') this.onMessageDeleted(data);
        } catch (e) {}
      };
    } catch (e) { this.connState = 'down'; this.updateConnPill(); }
  }
  disconnectStream() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } }

  updateConnPill() {
    const el = document.getElementById('pm-conn');
    if (!el) return;
    el.classList.remove('live', 'down');
    if (this.connState === 'live') el.classList.add('live');
    if (this.connState === 'down') el.classList.add('down');
    el.querySelector('.pm-conn-text').textContent =
      this.connState === 'live' ? t('pm.connected') :
      this.connState === 'down' ? t('pm.disconnected') :
      t('pm.connecting');
  }

  onIncomingDM(data) {
    const idx = this.dms.findIndex(d => d.id === data.channelId);
    if (idx >= 0) {
      const it = this.dms[idx];
      it.preview = data.message.content || (data.message.attachments?.length ? '🖼 ' + t('pm.attachment') : '');
      it.ts = data.message.ts;
      if (!data.fromMe && (!this.activeDM || this.activeDM.id !== data.channelId)) it.unread = (it.unread || 0) + 1;
      this.dms.splice(idx, 1); this.dms.unshift(it);
    } else if (!data.fromMe) {
      this.dms.unshift({
        id: data.channelId, userId: data.userId,
        username: data.username || 'Unknown', displayName: data.username || 'Unknown',
        avatar: data.avatar, bot: false, unread: 1,
        preview: data.message.content || '🖼', ts: data.message.ts
      });
    }
    this.renderList();

    if (this.activeDM && this.activeDM.id === data.channelId) {
      // Dedupe: if the message ID already exists (e.g. we just optimistically pushed
      // it after sending), skip — prevents the "sent twice" duplicate render.
      const existing = this.messages.find(m => m.id === data.message.id);
      if (!existing) {
        this.messages.push({
          id: data.message.id,
          content: data.message.content,
          ts: data.message.ts,
          author: data.message.author || { id: data.userId, username: data.username, avatar: data.avatar },
          attachments: data.message.attachments || [],
          reactions: [],
          replyTo: data.message.replyTo || null
        });
        this.renderChatBody();
      }
      this.markAsRead(data.channelId);
      if (!data.fromMe) sfx.notify();
    } else if (!data.fromMe) {
      sfx.pop();
      this.flashToast(`${t('pm.new_msg')} @${data.username || ''}`, data.channelId);
    }
  }

  // Handle real-time message-deletion events: mark the message as deleted in-place
  // (do NOT remove it). Display in red with the strike-through marker "(محذوف)".
  onMessageDeleted(data) {
    const dm = this.dms.find(d => d.id === data.channelId);
    if (dm && dm.preview && this.activeDM?.id !== data.channelId) {
      // Optional preview marker
    }
    if (this.activeDM && this.activeDM.id === data.channelId) {
      const msg = this.messages.find(m => m.id === data.messageId);
      if (msg) {
        msg.deleted = true;
        msg.deletedAt = data.ts || Date.now();
        this.renderChatBody();
        sfx.pop?.();
      }
    }
  }

  flashToast(text, channelId) {
    const old = document.getElementById('pm-toast');
    if (old) old.remove();
    const div = document.createElement('div');
    div.id = 'pm-toast'; div.className = 'pm-toast';
    div.innerHTML = `${icon('bell')} <span>${this.escHtml(text)}</span>`;
    div.onclick = () => {
      const dm = this.dms.find(d => d.id === channelId);
      if (dm) this.openChat(dm);
      div.remove();
    };
    document.body.appendChild(div);
    setTimeout(() => { try { div.remove(); } catch (e) {} }, 4500);
  }

  // ─── Render
  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page pm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('message')}</span>
            <div>
              <h2 class="mm-title">${t('pm.title')}</h2>
              <p class="mm-subtitle">${t('pm.subtitle')}</p>
            </div>
          </div>
        </div>
        <div class="pm-toolbar" id="pm-toolbar"></div>
        <div class="pm-shell ${this.activeDM ? 'has-active' : ''}" id="pm-shell">
          <div class="pm-list" id="pm-list"><div class="mm-info-row mm-muted">${t('common.loading')}</div></div>
          <div class="pm-chat" id="pm-chat">${this.renderChat()}</div>
        </div>
      </div>
    `;
    const toolbar = this.contentArea.querySelector('#pm-toolbar');
    const picker = await buildAccountPicker({ selectId: 'pm-acct', selected: this.account });
    toolbar.innerHTML = `
      ${picker.html}
      <label class="toggle-pill ${this.botsOnly ? 'on' : ''}" id="pm-bots">
        ${icon('bot')} <span>${t('pm.bots_only')}</span>
        <input type="checkbox" ${this.botsOnly ? 'checked' : ''}>
      </label>
      <input type="text" class="pm-search" id="pm-search" placeholder="${t('pm.search_dm')}" value="${this.escAttr(this.search)}">
      <span class="pm-status" id="pm-conn"><span class="pm-dot"></span><span class="pm-conn-text">${t('pm.connecting')}</span></span>
    `;
    picker.bind(toolbar, (val) => {
      this.account = val; this.activeDM = null; this.messages = [];
      this.connectStream(); this.loadList(); this.renderChatPane();
    });
    toolbar.querySelector('#pm-bots').addEventListener('click', (e) => {
      e.preventDefault(); this.botsOnly = !this.botsOnly;
      toolbar.querySelector('#pm-bots').classList.toggle('on', this.botsOnly);
      this.loadList();
    });
    toolbar.querySelector('#pm-search').addEventListener('input', (e) => {
      this.search = e.target.value || ''; this.renderList();
    });
    this.updateConnPill();
    await this.loadList();
  }

  async loadList() {
    const el = this.contentArea.querySelector('#pm-list');
    if (!el) return;
    el.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const r = await window.electronAPI.privateDMs(this.account, this.botsOnly);
      if (!r.success) { el.innerHTML = `<div class="pm-list-empty">${t('pm.no_accounts')}</div>`; return; }
      this.dms = r.dms || []; this.renderList();
    } catch (e) {
      el.innerHTML = `<div class="pm-list-empty">${this.escHtml(e.message)}</div>`;
    }
  }

  renderList() {
    const el = this.contentArea.querySelector('#pm-list');
    if (!el) return;
    let items = this.dms;
    if (this.search.trim()) {
      const q = this.search.trim().toLowerCase();
      items = items.filter(d =>
        (d.username || '').toLowerCase().includes(q) ||
        (d.displayName || '').toLowerCase().includes(q));
    }
    if (!items.length) { el.innerHTML = `<div class="pm-list-empty">${t('pm.empty')}</div>`; return; }
    el.innerHTML = items.map(d => `
      <div class="pm-list-item ${this.activeDM?.id === d.id ? 'active' : ''}" data-id="${d.id}" onclick="window.privateManager.openChatById('${d.id}')">
        <div class="pm-list-avatar"><img src="${d.avatar}" alt="" onerror="this.src='/discord.png'"></div>
        <div class="pm-list-meta">
          <div class="pm-list-name">
            ${this.escHtml(d.displayName)}
            ${d.bot ? `<span class="pm-bot-tag">${icon('bot')} BOT</span>` : ''}
          </div>
          <div class="pm-list-handle">${this.escHtml(d.preview || ('@' + d.username))}</div>
        </div>
        ${d.unread > 0 ? `<span class="pm-unread-dot" title="${d.unread} ${t('pm.unread')}">${d.unread > 9 ? '9+' : d.unread}</span>` : ''}
      </div>
    `).join('');
  }

  openChatById(id) { const dm = this.dms.find(d => d.id === id); if (dm) this.openChat(dm); }

  async openChat(dm) {
    sfx.click();
    this.activeDM = dm; dm.unread = 0; this.messages = [];
    this.replyTo = null; this.pendingFiles = [];
    this.renderList();
    document.getElementById('pm-shell')?.classList.add('has-active');
    this.renderChatPane();
    try {
      const r = await window.electronAPI.privateMessages(this.account, dm.id);
      if (r.success) {
        this.currentUserId = r.currentUserId;
        this.messages = r.messages || [];
        this.renderChatBody({ forceBottom: true });
        this.markAsRead(dm.id);
      }
    } catch (e) {}
  }

  closeChat() {
    this.activeDM = null; this.messages = [];
    this.replyTo = null; this.pendingFiles = [];
    document.getElementById('pm-shell')?.classList.remove('has-active');
    this.renderChatPane();
  }

  renderChatPane() {
    const el = this.contentArea.querySelector('#pm-chat');
    if (el) el.innerHTML = this.renderChat();
    this.bindComposer();
  }

  renderChat() {
    if (!this.activeDM) {
      return `<div class="pm-chat-empty">${icon('message')} <span>${t('pm.no_chat')}</span></div>`;
    }
    const d = this.activeDM;
    return `
      <div class="pm-chat-head">
        <button class="pm-back" onclick="window.privateManager.closeChat()" title="${t('common.back')}">${icon('arrow_left')}</button>
        <div class="pm-list-avatar"><img src="${d.avatar}" alt="" onerror="this.src='/discord.png'"></div>
        <div>
          <div class="pm-chat-title">${this.escHtml(d.displayName)}${d.bot ? ` <span class="pm-bot-tag">${icon('bot')} BOT</span>` : ''}</div>
          <div class="pm-chat-sub">@${this.escHtml(d.username)}</div>
        </div>
      </div>
      <div class="pm-chat-body" id="pm-chat-body">${this.renderMessages()}</div>
      ${this.replyTo ? `
        <div class="pm-reply-bar">
          <span>${icon('mail')} ${t('pm.replying_to')} <strong>@${this.escHtml(this.replyTo.author?.username || '?')}</strong>: <em>${this.escHtml((this.replyTo.content || '').slice(0, 60))}</em></span>
          <button onclick="window.privateManager.cancelReply()" title="${t('common.cancel')}">${icon('x')}</button>
        </div>
      ` : ''}
      ${this.pendingFiles.length ? `
        <div class="pm-pending-files">
          ${this.pendingFiles.map((f, i) => `
            <div class="pm-pending-file">
              <img src="${f.previewUrl || f.dataUrl}">
              <button onclick="window.privateManager.removePending(${i})">${icon('x')}</button>
              <span>${this.escHtml(f.name)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="pm-composer">
        <button class="pm-attach-btn" id="pm-attach" title="${t('pm.attach')}">${icon('image')}</button>
        <input type="file" id="pm-file" accept="image/*,video/*" multiple style="display:none">
        <textarea id="pm-input" rows="1" placeholder="${t('pm.type_msg')}"></textarea>
        <button id="pm-send" onclick="window.privateManager.send()">${icon('send')}</button>
      </div>
    `;
  }

  bindComposer() {
    const fileBtn = this.contentArea.querySelector('#pm-attach');
    const fileInput = this.contentArea.querySelector('#pm-file');
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const f of files) {
          if (f.size > 8 * 1024 * 1024) { showNotification(t('pm.too_big')); continue; }
          const dataUrl = await this.fileToDataUrl(f);
          this.pendingFiles.push({ dataUrl, name: f.name, contentType: f.type, previewUrl: dataUrl });
        }
        e.target.value = '';
        this.renderChatPane();
      });
    }
    const ta = this.contentArea.querySelector('#pm-input');
    if (ta) {
      ta.addEventListener('keydown', (e) => {
        // Let the @ picker handle nav keys when it's open
        if (this._mp && this._mp.handleKey(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      });
      ta.addEventListener('input', () => this.updateMentionPicker());
      ta.addEventListener('blur', () => setTimeout(() => this.closeMentionPicker(), 150));
    }
  }

  // ── @ mention autocomplete (Discord-style) ──
  updateMentionPicker() {
    const ta = this.contentArea.querySelector('#pm-input');
    if (!ta) return;
    const text = ta.value;
    const pos = ta.selectionStart || 0;
    // Find the closest "@" in the current word (no spaces between cursor and @)
    const before = text.slice(0, pos);
    const m = before.match(/(?:^|\s)@([\p{L}\p{N}_.\-]{0,32})$/u);
    if (!m) return this.closeMentionPicker();
    const query = m[1].toLowerCase();
    const start = pos - m[1].length - 1; // index of "@"
    // Build candidate list from DMs (most relevant) + recent message authors
    const seen = new Map();
    for (const d of this.dms || []) {
      const u = (d.username || '').toLowerCase();
      const dn = (d.displayName || '').toLowerCase();
      if (!query || u.startsWith(query) || dn.includes(query) || u.includes(query)) {
        seen.set(d.id, { id: d.id, username: d.username, displayName: d.displayName, avatar: d.avatar });
      }
      if (seen.size >= 8) break;
    }
    if (this.activeDM && !seen.has(this.activeDM.id)) {
      const u = (this.activeDM.username || '').toLowerCase();
      if (!query || u.includes(query)) seen.set(this.activeDM.id, this.activeDM);
    }
    for (const msg of (this.messages || []).slice(-40)) {
      const a = msg.author; if (!a || !a.id) continue;
      const u = (a.username || '').toLowerCase();
      if (seen.size >= 8) break;
      if (!query || u.startsWith(query) || u.includes(query)) {
        if (!seen.has(a.id)) seen.set(a.id, { id: a.id, username: a.username, displayName: a.username, avatar: a.avatar });
      }
    }
    const list = Array.from(seen.values());
    if (!list.length) return this.closeMentionPicker();
    this.openMentionPicker(list, start, ta);
  }

  openMentionPicker(items, atStart, ta) {
    let host = document.getElementById('pm-mention-picker');
    if (!host) {
      host = document.createElement('div');
      host.id = 'pm-mention-picker';
      host.className = 'mp-picker';
      document.body.appendChild(host);
    }
    const idx = (this._mp && Math.min(this._mp.idx, items.length - 1)) || 0;
    host.innerHTML = `
      <div class="mp-picker-head">${t('pm.mention') || 'Mention a user'}</div>
      ${items.map((u, i) => `
        <div class="mp-row ${i === idx ? 'is-active' : ''}" data-idx="${i}">
          <img class="mp-avatar" src="${u.avatar || '/discord.png'}" onerror="this.src='/discord.png'">
          <div class="mp-name">${this.escHtml(u.displayName || u.username)}</div>
          <div class="mp-handle">@${this.escHtml(u.username)}</div>
        </div>
      `).join('')}
    `;
    // Position above the textarea
    const r = ta.getBoundingClientRect();
    host.style.left = `${r.left}px`;
    host.style.top  = `${r.top - 8}px`;
    host.style.transform = 'translateY(-100%)';
    host.classList.add('is-open');
    host.querySelectorAll('.mp-row').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const i = Number(el.dataset.idx);
        this.insertMention(items[i], atStart, ta);
      });
    });
    this._mp = {
      items, idx, atStart, ta,
      handleKey: (e) => {
        if (!host.classList.contains('is-open')) return false;
        if (e.key === 'ArrowDown') { this._mp.idx = (this._mp.idx + 1) % items.length; this._mp.refresh(); e.preventDefault(); return true; }
        if (e.key === 'ArrowUp')   { this._mp.idx = (this._mp.idx - 1 + items.length) % items.length; this._mp.refresh(); e.preventDefault(); return true; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.insertMention(items[this._mp.idx], atStart, ta); return true; }
        if (e.key === 'Escape') { this.closeMentionPicker(); return true; }
        return false;
      },
      refresh: () => {
        host.querySelectorAll('.mp-row').forEach((el, i) => el.classList.toggle('is-active', i === this._mp.idx));
      }
    };
  }

  closeMentionPicker() {
    const host = document.getElementById('pm-mention-picker');
    if (host) host.classList.remove('is-open');
    this._mp = null;
  }

  insertMention(user, atStart, ta) {
    const before = ta.value.slice(0, atStart);
    const afterStart = ta.selectionStart || atStart;
    const after = ta.value.slice(afterStart);
    const insert = `<@${user.id}> `;
    ta.value = before + insert + after;
    const newPos = (before + insert).length;
    ta.setSelectionRange(newPos, newPos);
    ta.focus();
    this.closeMentionPicker();
  }

  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  removePending(i) { this.pendingFiles.splice(i, 1); this.renderChatPane(); }
  cancelReply() { this.replyTo = null; this.renderChatPane(); }
  startReply(messageId) {
    const m = this.messages.find(x => x.id === messageId);
    if (m) { sfx.click(); this.replyTo = m; this.renderChatPane(); document.getElementById('pm-input')?.focus(); }
  }
  async react(messageId, emoji) {
    sfx.pop();
    try {
      const m = this.messages.find(x => x.id === messageId);
      const has = m?.reactions?.find(r => r.emoji === emoji && r.me);
      const r = await fetch('/api/private/react', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: this.account, channelId: this.activeDM.id, messageId, emoji, remove: !!has })
      }).then(x => x.json());
      if (r.success && m) {
        m.reactions = m.reactions || [];
        const ex = m.reactions.find(r => r.emoji === emoji);
        if (ex) {
          if (has) { ex.count = Math.max(0, ex.count - 1); ex.me = false; if (ex.count === 0) m.reactions = m.reactions.filter(r => r !== ex); }
          else { ex.count++; ex.me = true; }
        } else if (!has) {
          m.reactions.push({ emoji, name: emoji, id: null, count: 1, me: true });
        }
        this.renderChatBody();
      }
    } catch (e) { showNotification(t('pm.react_failed')); }
  }

  renderChatBody(opts = {}) {
    const el = this.contentArea.querySelector('#pm-chat-body');
    if (!el) return;
    const forceBottom = !!opts.forceBottom;
    const wasNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 200;
    el.innerHTML = this.renderMessages();
    if (forceBottom || wasNearBottom) {
      // Use rAF so layout settles before we scroll
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }

  renderMessages() {
    if (!this.messages.length) {
      return `<div class="pm-chat-empty-msgs">${t('pm.empty_msg')}</div>`;
    }
    // Ensure ascending order (oldest first → newest last) so newest appears at bottom.
    const sorted = this.messages.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    this.messages = sorted;
    const oldest = sorted[0];
    const loadMore = oldest ? `<button class="pm-load-more" onclick="window.privateManager.loadOlder('${oldest.id}')">${t('pm.load_more')}</button>` : '';
    const byId = new Map(sorted.map(m => [m.id, m]));
    let lastDayKey = '';
    const parts = [];
    for (const m of sorted) {
      const dayKey = this.dayKey(m.ts);
      if (dayKey !== lastDayKey) {
        parts.push(`<div class="pm-day-sep">${this.fmtDay(m.ts)}</div>`);
        lastDayKey = dayKey;
      }
      parts.push(this.messageRow(m, byId.get(m.replyTo)));
    }
    return loadMore + parts.join('');
  }

  messageRow(m, replied) {
    const me = m.author?.id === this.currentUserId;
    const atts = (m.attachments || []).map(a => {
      const isImg = (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url);
      const isVid = (a.contentType || '').startsWith('video/') || /\.(mp4|mov|webm)(\?|$)/i.test(a.url);
      if (isImg) return `<a href="${a.url}" target="_blank"><img src="${a.url}" class="pm-att-img" loading="lazy"></a>`;
      if (isVid) return `<video src="${a.url}" controls class="pm-att-vid"></video>`;
      return `<a href="${a.url}" target="_blank" class="pm-att-link">${icon('file_text')} ${this.escHtml(a.name)}</a>`;
    }).join('');
    const reactions = (m.reactions || []).map(r => `
      <button class="pm-reaction ${r.me ? 'me' : ''}" onclick="window.privateManager.react('${m.id}', ${JSON.stringify(r.emoji)})">
        ${this.escHtml(r.name || r.emoji)} <span>${r.count}</span>
      </button>
    `).join('');
    const replyHtml = replied ? `
      <div class="pm-reply-quote">
        ${icon('mail')} <strong>@${this.escHtml(replied.author?.username || '?')}</strong>:
        <em>${this.formatContent((replied.content || '').slice(0, 80))}</em>
      </div>
    ` : '';
    const delMark = `<span class="pm-deleted-mark">(${t('pm.deleted')})</span>`;
    const tip = m.ts ? new Date(m.ts).toLocaleString() : '';
    const checkMark = me ? `<span class="pm-msg-check">✓</span>` : '';
    return `
      <div class="pm-msg-row ${me ? 'me' : 'them'} ${m.deleted ? 'deleted' : ''}" data-id="${m.id}">
        ${m.author?.avatar && !me ? `<img class="pm-msg-avatar" src="${m.author.avatar}" onerror="this.style.display='none'">` : ''}
        <div class="pm-msg-stack">
          ${replyHtml}
          ${m.content ? `<div class="pm-msg-bubble ${m.deleted ? 'deleted' : ''}" title="${this.escAttr(tip)}">${this.formatContent(m.content)} ${m.deleted ? delMark : ''}</div>` : (m.deleted ? `<div class="pm-msg-bubble deleted">${delMark}</div>` : '')}
          ${atts ? `<div class="pm-msg-atts ${m.deleted ? 'deleted' : ''}">${atts}</div>` : ''}
          ${reactions ? `<div class="pm-msg-reactions">${reactions}</div>` : ''}
          <div class="pm-msg-row-foot">
            <span class="pm-msg-time" title="${this.escAttr(tip)}">${this.fmtTime(m.ts)}${checkMark}</span>
            <div class="pm-msg-actions">
              <button class="pm-msg-act" onclick="window.privateManager.startReply('${m.id}')" title="${t('pm.reply')}">${icon('mail')}</button>
              <div class="pm-msg-react-bar">
                ${QUICK_REACTIONS.map(e => `<button onclick="window.privateManager.react('${m.id}', ${JSON.stringify(e)})">${e}</button>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  dayKey(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  fmtDay(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(); yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t('pm.today') || 'Today';
    if (d.toDateString() === yest.toDateString()) return t('pm.yesterday') || 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  async loadOlder(beforeId) {
    if (!this.activeDM) return;
    try {
      const r = await window.electronAPI.privateMessages(this.account, this.activeDM.id, beforeId);
      if (r.success && (r.messages || []).length) {
        const body = this.contentArea.querySelector('#pm-chat-body');
        const prevH = body?.scrollHeight || 0;
        this.messages = [...r.messages, ...this.messages];
        this.renderChatBody();
        if (body) body.scrollTop = body.scrollHeight - prevH;
      }
    } catch (e) {}
  }

  async send() {
    if (this.sending || !this.activeDM) return;
    const input = document.getElementById('pm-input');
    const text = (input?.value || '').trim();
    if (!text && !this.pendingFiles.length) return;
    this.sending = true;
    const sendBtn = document.getElementById('pm-send');
    if (sendBtn) sendBtn.disabled = true;
    sfx.click();
    try {
      const payload = {
        account: this.account, channelId: this.activeDM.id,
        content: text || '',
        replyTo: this.replyTo?.id || null,
        files: this.pendingFiles.map(f => ({ dataUrl: f.dataUrl, name: f.name }))
      };
      const r = await fetch('/api/private/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }).then(x => x.json());
      if (r.success) {
        // Only push if not already added by SSE (dedupe by id)
        if (r.id && !this.messages.find(m => m.id === r.id)) {
          this.messages.push({
            id: r.id, content: text, ts: r.ts || Date.now(),
            author: { id: this.currentUserId, username: t('pm.you') },
            attachments: this.pendingFiles.map(f => ({ url: f.previewUrl, name: f.name, contentType: f.contentType })),
            reactions: [], replyTo: this.replyTo?.id || null
          });
        }
        if (input) input.value = '';
        this.replyTo = null; this.pendingFiles = [];
        this.renderChatPane();
        // After re-rendering composer, scroll the body to bottom so the new message is visible
        this.renderChatBody({ forceBottom: true });
        sfx.success();
      } else {
        showNotification(`${t('pm.send_failed')}: ${r.error || ''}`); sfx.fail();
      }
    } catch (e) {
      showNotification(`${t('pm.send_failed')}: ${e.message}`); sfx.fail();
    } finally {
      this.sending = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  async markAsRead(channelId) {
    try { await window.electronAPI.privateMarkRead(this.account, channelId); } catch (e) {}
  }

  fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }

  // Convert raw Discord content (with `<@id>`, `<#id>`, `<:emoji:id>`, custom
  // animated emojis, channel mentions, etc.) into safe HTML with styled pills.
  formatContent(text = '') {
    if (!text) return '';
    // 1) Escape first so we never inject raw HTML.
    let html = this.escHtml(text);
    const meId = String(this.currentUserId || '');
    // Index of known users we can resolve to a display name
    const lookup = (id) => {
      // Self
      if (id === meId) return 'you';
      // Active DM partner
      if (this.activeDM && this.activeDM.id === id) return this.activeDM.username || this.activeDM.displayName;
      // Any DM in our list
      const dm = (this.dms || []).find(d => d.id === id);
      if (dm) return dm.username || dm.displayName;
      // Author of any cached message
      const msg = (this.messages || []).find(m => m.author?.id === id);
      if (msg) return msg.author.username;
      return null;
    };
    // <@!id> / <@id> user mention
    html = html.replace(/&lt;@!?(\d{15,21})&gt;/g, (_, id) => {
      const name = lookup(id) || id;
      const cls = id === meId ? 'dc-mention is-self' : 'dc-mention';
      return `<span class="${cls}" data-uid="${id}" title="ID: ${id}">@${this.escHtml(name)}</span>`;
    });
    // <@&id> role mention
    html = html.replace(/&lt;@&amp;(\d{15,21})&gt;/g, (_, id) =>
      `<span class="dc-mention" title="Role ${id}">@role</span>`);
    // <#id> channel mention
    html = html.replace(/&lt;#(\d{15,21})&gt;/g, (_, id) =>
      `<span class="dc-channel" title="Channel ${id}">#channel</span>`);
    // <:name:id> / <a:name:id> custom emoji
    html = html.replace(/&lt;(a?):([A-Za-z0-9_~]+):(\d{15,21})&gt;/g, (_, anim, name, id) => {
      const ext = anim === 'a' ? 'gif' : 'png';
      return `<img class="dc-emoji" alt=":${name}:" title=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${ext}?size=44">`;
    });
    return html;
  }
}
