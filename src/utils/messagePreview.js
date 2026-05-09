/**
 * messagePreview.js — v4
 *
 * showMessagePreview()      Single-channel: preview messages → inline deletion
 *                           with per-row status (spinner → ✓ / ✗).
 *
 * showBulkMessagePreview()  Multi-channel: confirm list → process each channel
 *                           sequentially with per-channel status badges.
 *
 * Both use AdaptiveThrottle — starts at ~350 ms, speeds up on streaks of
 * successes, backs off on rate-limits, recovers gradually.
 */

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Adaptive throttle ─────────────────────────────────────────────────────────
class _Throttle {
  constructor(start = 350, min = 110, max = 900) {
    this.d = start; this.min = min; this.max = max;
    this._streak = 0; this._cd = 0;
  }
  async wait() {
    const cd = this._cd - Date.now();
    if (cd > 0) await _sleep(cd);
    await _sleep(this.d + Math.floor(Math.random() * 80));
  }
  ok()         { if (++this._streak % 3 === 0) this.d = Math.max(this.min, this.d * 0.88); }
  rl(ms = 4000){ this._streak = 0; this._cd = Date.now() + ms; this.d = Math.min(this.max, this.d * 1.8); }
  err()        { this._streak = 0; this.d = Math.min(this.max, this.d * 1.15); }
  label()      {
    if (this.d <= 130) return '⚡ Fast';
    if (this.d <= 260) return '🟢 Normal';
    if (this.d <= 520) return '🟡 Slow';
    return '🔴 Very slow';
  }
}

// ── HTML / escape helpers ─────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _avUrl(uid, hash) {
  if (!hash || !uid) return '/discord.png';
  return `https://cdn.discordapp.com/avatars/${uid}/${hash}.webp?size=32`;
}
function _fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  } catch { return ''; }
}
function _msgHtml(msg) {
  const av      = _avUrl(msg.author?.id, msg.author?.avatar);
  const name    = _esc(msg.author?.globalName || msg.author?.username || 'Unknown');
  const nameLow = (msg.author?.globalName || msg.author?.username || '').toLowerCase();
  const time    = _fmtTime(msg.timestamp);
  const content = msg.content || '';
  const extras  = [];
  if (msg.attachments?.length)    extras.push(`📎 ${msg.attachments.length} attachment${msg.attachments.length>1?'s':''}`);
  if (msg.sticker_items?.length)  extras.push('🎨 sticker');
  if (!content && msg.embeds?.length) extras.push('🔗 embed');

  return `
    <div class="msgpv-item" data-id="${_esc(msg.id)}"
         data-search="${_esc((nameLow + ' ' + content.toLowerCase()).slice(0,400))}">
      <img class="msgpv-av" src="${_esc(av)}" onerror="this.src='/discord.png'" alt="">
      <div class="msgpv-body">
        <div class="msgpv-meta">
          <span class="msgpv-author">${name}</span>
          <span class="msgpv-time">${time}</span>
        </div>
        ${content ? `<div class="msgpv-content">${_esc(content)}</div>` : ''}
        ${extras.length ? `<div class="msgpv-extras">${extras.map(_esc).join(' · ')}</div>` : ''}
      </div>
      <div class="msgpv-row-st"></div>
    </div>`;
}

// ── Per-row status icons ──────────────────────────────────────────────────────
const _SPIN = `<svg class="msgpv-st-spin" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="42" stroke-dashoffset="14" stroke-linecap="round"/></svg>`;
const _DONE = `<svg class="msgpv-st-done" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const _FAIL = `<svg class="msgpv-st-fail" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function _setRowStatus(listEl, msgId, status) {
  const row = listEl.querySelector(`.msgpv-item[data-id="${CSS.escape(msgId)}"]`);
  if (!row) return;
  const zone = row.querySelector('.msgpv-row-st');
  if (!zone) return;
  row.classList.remove('is-deleting','is-done','is-failed');
  if (status === 'loading') {
    row.classList.add('is-deleting'); zone.innerHTML = _SPIN;
    row.scrollIntoView({ block:'nearest', behavior:'smooth' });
  } else if (status === 'done')   { row.classList.add('is-done');   zone.innerHTML = _DONE; }
  else if (status === 'failed')   { row.classList.add('is-failed'); zone.innerHTML = _FAIL; }
}

// ── Shared delete-one helper ──────────────────────────────────────────────────
async function _deleteOne(channelId, msgId, isGroup, throttle, onStatus) {
  await throttle.wait();
  const tryDel = () => isGroup
    ? window.electronAPI.deleteGroupMessage(channelId, msgId)
    : window.electronAPI.deleteDMMessage(channelId, msgId);

  try {
    await tryDel();
    throttle.ok();
    return true;
  } catch (err) {
    const s = String(err?.message || err);
    if (s.includes('429') || /rate.?limit/i.test(s)) {
      const m   = s.match(/retry.?after[:\s]+(\d+(?:\.\d+)?)/i);
      const rms = m ? Math.min(15000, Math.ceil(parseFloat(m[1])*1000)+500) : 4000;
      throttle.rl(rms);
      if (onStatus) onStatus(`Rate limited — waiting ${(rms/1000).toFixed(1)}s…`);
      await _sleep(rms);
      if (onStatus) onStatus('Deleting…');
      try { await tryDel(); throttle.ok(); return true; } catch { /* fall through */ }
    }
    throttle.err();
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// showMessagePreview  —  single channel
// ─────────────────────────────────────────────────────────────────────────────
export async function showMessagePreview({
  channelId,
  displayName = '',
  username    = '',
  avatar      = '',
  isGroup     = false,
  oldestFirst = false,
}) {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay msgpv-overlay';
    overlay.style.cssText = 'animation:fadeIn 0.18s ease-out;z-index:9500';

    const title = displayName || username || (isGroup ? 'Group' : 'DM');
    overlay.innerHTML = `
      <div class="modal-content msgpv-modal">
        <div class="msgpv-header">
          <img class="msgpv-header-av" src="${_esc(avatar||'/discord.png')}"
               onerror="this.src='/discord.png'" alt="">
          <div class="msgpv-header-info">
            <span class="msgpv-header-name">${_esc(title)}</span>
            ${username && displayName ? `<span class="msgpv-header-handle">@${_esc(username)}</span>` : ''}
          </div>
          <span class="msgpv-badge" id="msgpv-badge">…</span>
        </div>

        <div class="msgpv-search-wrap" id="msgpv-search-wrap" style="display:none">
          <svg class="msgpv-search-icon" viewBox="0 0 24 24" width="14" height="14"
               fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input class="msgpv-search" id="msgpv-search" type="text"
                 placeholder="Search messages…" autocomplete="off">
          <span class="msgpv-search-count" id="msgpv-search-count"></span>
        </div>

        <div class="msgpv-statusbar">
          <span class="msgpv-spinner" id="msgpv-spinner"></span>
          <span class="msgpv-statustxt" id="msgpv-status">Collecting messages…</span>
          <span class="msgpv-speed" id="msgpv-speed" style="display:none"></span>
        </div>

        <div class="msgpv-list" id="msgpv-list"></div>

        <div class="msgpv-footer">
          <span class="msgpv-footer-label" id="msgpv-count">—</span>
          <div class="msgpv-footer-btns">
            <button class="secondary msgpv-cancel" id="msgpv-cancel">Cancel</button>
            <button class="msgpv-delete" id="msgpv-delete" disabled>Delete</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const modal      = overlay.querySelector('.msgpv-modal');
    const listEl     = overlay.querySelector('#msgpv-list');
    const statusEl   = overlay.querySelector('#msgpv-status');
    const badgeEl    = overlay.querySelector('#msgpv-badge');
    const countEl    = overlay.querySelector('#msgpv-count');
    const speedEl    = overlay.querySelector('#msgpv-speed');
    const delBtn     = overlay.querySelector('#msgpv-delete');
    const cancelBtn  = overlay.querySelector('#msgpv-cancel');
    const spinEl     = overlay.querySelector('#msgpv-spinner');
    const searchWrap = overlay.querySelector('#msgpv-search-wrap');
    const searchIn   = overlay.querySelector('#msgpv-search');
    const searchCnt  = overlay.querySelector('#msgpv-search-count');

    let phase      = 'collecting';
    let shouldStop = false;
    const deletable = [];

    const dismiss = (r) => {
      modal.style.animation   = 'slideOut 0.15s ease-in forwards';
      overlay.style.animation = 'fadeOut 0.15s ease-in forwards';
      setTimeout(() => { overlay.remove(); resolve(r); }, 140);
    };

    // Search
    searchIn.addEventListener('input', () => {
      const q = searchIn.value.trim().toLowerCase();
      let vis = 0;
      listEl.querySelectorAll('.msgpv-item').forEach(row => {
        const show = !q || (row.dataset.search||'').includes(q);
        row.style.display = show ? '' : 'none';
        if (show) vis++;
      });
      searchCnt.textContent = q ? `${vis} result${vis!==1?'s':''}` : '';
    });

    // Cancel / Stop
    cancelBtn.addEventListener('click', () => {
      if (phase === 'deleting') {
        shouldStop = true;
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Stopping…';
      } else {
        dismiss({ confirmed:false, deleted:0, failed:0, cancelled:true });
      }
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay && phase !== 'deleting')
        dismiss({ confirmed:false, deleted:0, failed:0, cancelled:true });
    });

    // ── Phase 1: Collect ──────────────────────────────────────────────────────
    let lastId = null, hasMore = true, currentUserId = null;

    while (hasMore && phase === 'collecting') {
      let res;
      try {
        res = isGroup
          ? await window.electronAPI.getGroupMessages(channelId, lastId)
          : await window.electronAPI.getDMMessages(channelId, lastId);
      } catch { statusEl.textContent = 'Error fetching messages.'; break; }

      if (!res?.success || !res.messages?.length) { hasMore = false; break; }
      if (!currentUserId && res.currentUserId) currentUserId = res.currentUserId;

      const page = res.messages;
      const batch = [];
      for (const msg of page) {
        if (isGroup) { if (msg.author?.id !== currentUserId) continue; }
        else         { if (!msg.isDeletable) continue; }
        batch.push(msg);
        deletable.push(msg);
      }
      // Reverse page → prepend → chronological top→bottom
      if (batch.length) listEl.insertAdjacentHTML('afterbegin', [...batch].reverse().map(_msgHtml).join(''));

      const n = deletable.length;
      badgeEl.textContent  = String(n);
      statusEl.textContent = `Collecting… ${n} found`;
      countEl.textContent  = `${n} message${n!==1?'s':''} found`;

      hasMore = page.length === 100;
      lastId  = page[page.length-1].id;
      await _sleep(120);
    }

    if (phase !== 'collecting') return;

    // ── Phase 1 done → Preview ────────────────────────────────────────────────
    phase = 'preview';
    spinEl.remove();
    const n = deletable.length;
    badgeEl.textContent = String(n);

    if (!n) {
      statusEl.textContent = 'No deletable messages found.';
      countEl.textContent  = 'Nothing to delete';
      listEl.innerHTML     = '<div class="msgpv-empty-state">No messages to delete in this conversation.</div>';
      delBtn.textContent   = 'Nothing to delete';
    } else {
      statusEl.textContent     = `Found ${n} deletable message${n!==1?'s':''}`;
      countEl.textContent      = `${n} message${n!==1?'s':''} will be deleted`;
      delBtn.textContent       = `Delete ${n}`;
      delBtn.disabled          = false;
      searchWrap.style.display = '';
      listEl.scrollTop         = listEl.scrollHeight;
    }

    // ── Phase 2: Delete ───────────────────────────────────────────────────────
    delBtn.addEventListener('click', async () => {
      if (phase !== 'preview' || !deletable.length) return;
      phase = 'deleting';

      delBtn.disabled       = true;
      delBtn.textContent    = 'Deleting…';
      searchIn.disabled     = true;
      cancelBtn.textContent = 'Stop';
      statusEl.textContent  = 'Deleting messages…';
      speedEl.style.display = '';

      const toDelete = oldestFirst ? [...deletable].reverse() : [...deletable];
      let deleted = 0, failed = 0;
      const thr = new _Throttle();

      const onStatus = (txt) => { statusEl.textContent = txt; };

      for (const msg of toDelete) {
        if (shouldStop) break;

        _setRowStatus(listEl, msg.id, 'loading');
        countEl.textContent = `Deleting ${deleted+failed+1} / ${toDelete.length}`;
        speedEl.textContent = thr.label();

        const ok = await _deleteOne(channelId, msg.id, isGroup, thr, onStatus);
        if (ok) { deleted++; _setRowStatus(listEl, msg.id, 'done'); }
        else    { failed++;  _setRowStatus(listEl, msg.id, 'failed'); }

        countEl.textContent = `${deleted} deleted${failed?` · ${failed} failed`:''}`;
        speedEl.textContent = thr.label();
      }

      // Done
      phase = 'done';
      const stopped = shouldStop && (deleted+failed < toDelete.length);
      const parts = [`${deleted} deleted`];
      if (failed)  parts.push(`${failed} failed`);
      if (stopped) parts.push('stopped early');
      statusEl.textContent    = parts.join(' · ');
      speedEl.style.display   = 'none';
      badgeEl.textContent     = String(deleted);
      delBtn.textContent      = 'Done';
      cancelBtn.style.display = 'none';

      const finish = () => dismiss({ confirmed:true, deleted, failed, cancelled:stopped });
      delBtn.addEventListener('click', finish);
      setTimeout(finish, 1800);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// showBulkMessagePreview  —  multiple channels, sequential
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{id, displayName, username, avatar}>} items
 * @param {boolean} isGroup
 */
export async function showBulkMessagePreview({ items, isGroup = false }) {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay msgpv-overlay';
    overlay.style.cssText = 'animation:fadeIn 0.18s ease-out;z-index:9500';

    const rowsHtml = items.map(it => `
      <div class="bulk-item" data-id="${_esc(it.id)}">
        <img class="bulk-av" src="${_esc(it.avatar||'/discord.png')}"
             onerror="this.src='/discord.png'" alt="">
        <div class="bulk-info">
          <span class="bulk-name">${_esc(it.displayName||it.username||it.id)}</span>
          ${it.username ? `<span class="bulk-handle">@${_esc(it.username)}</span>` : ''}
        </div>
        <div class="bulk-stat waiting">Waiting</div>
      </div>`).join('');

    overlay.innerHTML = `
      <div class="modal-content bulk-modal">
        <div class="bulk-header">
          <div class="bulk-header-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </div>
          <div>
            <p class="bulk-header-title">Delete messages from ${items.length} channel${items.length!==1?'s':''}</p>
            <p class="bulk-header-sub" id="bulk-sub">Review the channels below, then confirm.</p>
          </div>
        </div>

        <div class="bulk-list" id="bulk-list">${rowsHtml}</div>

        <div class="bulk-statusbar" id="bulk-statusbar" style="display:none">
          <span class="msgpv-spinner" id="bulk-spin"></span>
          <span id="bulk-statustext">Starting…</span>
          <span class="msgpv-speed" id="bulk-speed"></span>
        </div>

        <div class="msgpv-footer">
          <span class="msgpv-footer-label" id="bulk-count">${items.length} channel${items.length!==1?'s':''} selected</span>
          <div class="msgpv-footer-btns">
            <button class="secondary msgpv-cancel" id="bulk-cancel">Cancel</button>
            <button class="msgpv-delete" id="bulk-confirm">Delete All</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const modal       = overlay.querySelector('.bulk-modal');
    const listEl      = overlay.querySelector('#bulk-list');
    const countEl     = overlay.querySelector('#bulk-count');
    const subEl       = overlay.querySelector('#bulk-sub');
    const statusbar   = overlay.querySelector('#bulk-statusbar');
    const statusEl    = overlay.querySelector('#bulk-statustext');
    const spinEl      = overlay.querySelector('#bulk-spin');
    const speedEl     = overlay.querySelector('#bulk-speed');
    const cancelBtn   = overlay.querySelector('#bulk-cancel');
    const confirmBtn  = overlay.querySelector('#bulk-confirm');

    let phase = 'confirm';
    let shouldStop = false;

    const dismiss = (r) => {
      modal.style.animation   = 'slideOut 0.15s ease-in forwards';
      overlay.style.animation = 'fadeOut 0.15s ease-in forwards';
      setTimeout(() => { overlay.remove(); resolve(r); }, 140);
    };

    // Update a channel row's status badge
    const setChStat = (id, cls, html) => {
      const row  = listEl.querySelector(`.bulk-item[data-id="${CSS.escape(id)}"]`);
      if (!row) return;
      const stat = row.querySelector('.bulk-stat');
      if (!stat) return;
      stat.className = `bulk-stat ${cls}`;
      stat.innerHTML = html;
    };

    cancelBtn.addEventListener('click', () => {
      if (phase === 'processing') {
        shouldStop = true;
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Stopping…';
      } else {
        dismiss({ deleted:0, failed:0, cancelled:true });
      }
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay && phase !== 'processing')
        dismiss({ deleted:0, failed:0, cancelled:true });
    });

    // ── Confirm → Process ─────────────────────────────────────────────────────
    confirmBtn.addEventListener('click', async () => {
      if (phase !== 'confirm') return;
      phase = 'processing';

      confirmBtn.disabled   = true;
      confirmBtn.textContent = 'Running…';
      cancelBtn.textContent  = 'Stop';
      subEl.textContent      = 'Processing channels…';
      statusbar.style.display = '';

      let totalDeleted = 0, totalFailed = 0, chDone = 0;
      const thr = new _Throttle();

      const onStatus = (txt) => { statusEl.textContent = txt; };

      for (let i = 0; i < items.length; i++) {
        if (shouldStop) break;
        const it = items[i];

        setChStat(it.id, 'collecting',
          `${_SPIN.replace('class="msgpv-st-spin"','class="bulk-spin-icon"')} Collecting…`);
        countEl.textContent  = `Channel ${i+1} / ${items.length}`;
        statusEl.textContent = `Collecting messages in ${it.displayName || it.id}…`;

        // Collect all deletable messages for this channel
        const deletable    = [];
        let   lastId       = null;
        let   hasMore      = true;
        let   curUserId    = null;

        while (hasMore && !shouldStop) {
          let res;
          try {
            res = isGroup
              ? await window.electronAPI.getGroupMessages(it.id, lastId)
              : await window.electronAPI.getDMMessages(it.id, lastId);
          } catch { hasMore = false; break; }

          if (!res?.success || !res.messages?.length) { hasMore = false; break; }
          if (!curUserId && res.currentUserId) curUserId = res.currentUserId;

          for (const msg of res.messages) {
            if (isGroup) { if (msg.author?.id !== curUserId) continue; }
            else         { if (!msg.isDeletable) continue; }
            deletable.push(msg);
          }
          setChStat(it.id, 'collecting',
            `${_SPIN.replace('class="msgpv-st-spin"','class="bulk-spin-icon"')} ${deletable.length} found`);

          hasMore = res.messages.length === 100;
          lastId  = res.messages[res.messages.length-1].id;
          await _sleep(120);
        }

        if (shouldStop) { setChStat(it.id, 'failed', `${_FAIL} Stopped`); break; }

        if (!deletable.length) {
          setChStat(it.id, 'empty', 'No messages');
          chDone++;
          continue;
        }

        // Delete all messages for this channel
        setChStat(it.id, 'deleting',
          `${_SPIN.replace('class="msgpv-st-spin"','class="bulk-spin-icon"')} 0 / ${deletable.length}`);

        let chDeleted = 0, chFailed = 0;
        for (const msg of deletable) {
          if (shouldStop) break;
          const ok = await _deleteOne(it.id, msg.id, isGroup, thr, onStatus);
          if (ok) { chDeleted++; totalDeleted++; }
          else    { chFailed++;  totalFailed++; }

          setChStat(it.id, 'deleting',
            `${_SPIN.replace('class="msgpv-st-spin"','class="bulk-spin-icon"')} ${chDeleted} / ${deletable.length}`);
          speedEl.textContent = thr.label();
        }

        if (shouldStop && chDeleted + chFailed < deletable.length) {
          setChStat(it.id, 'failed',
            `${_FAIL} Stopped — ${chDeleted} deleted`);
          break;
        }

        if (chFailed && !chDeleted)
          setChStat(it.id, 'failed', `${_FAIL} All failed`);
        else if (chFailed)
          setChStat(it.id, 'done', `${_DONE} ${chDeleted} deleted · ${chFailed} failed`);
        else
          setChStat(it.id, 'done', `${_DONE} ${chDeleted} deleted`);

        chDone++;
      }

      // ── All done ─────────────────────────────────────────────────────────────
      phase = 'done';
      const stopped = shouldStop;
      spinEl.remove();

      const parts = [`${totalDeleted} deleted`];
      if (totalFailed) parts.push(`${totalFailed} failed`);
      if (stopped)     parts.push('stopped early');
      statusEl.textContent     = parts.join(' · ');
      speedEl.style.display    = 'none';
      countEl.textContent      = `Done — ${chDone} / ${items.length} channels`;
      confirmBtn.textContent   = 'Done';
      confirmBtn.disabled      = false;
      cancelBtn.style.display  = 'none';

      const finish = () => dismiss({ deleted:totalDeleted, failed:totalFailed, cancelled:stopped });
      confirmBtn.addEventListener('click', finish);
      setTimeout(finish, 2000);
    });
  });
}
