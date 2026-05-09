import { t } from './i18n.js';
import * as AF from './activityFeed.js';

const SVG = {
  pending: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15.5" y2="14"/></svg>',
  spin:    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/></svg>',
  ok:      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  fail:    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  info:    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  warn:    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function escHtml(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
function timeStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Open an animated operation log overlay.
 *
 *   const log = openOperationLog({ title: 'Deleting messages', context: '@user' });
 *   log.start('k1', { title: '…', context: '…' });
 *   log.success('k1', { detail: '…' });
 *   log.fail('k1', { error: '…' });
 *   log.info({ title: '…', context: '…' });
 *   log.setTotal(50); log.tick();   // simple counters
 *   log.summary({ ok: 48, fail: 2, total: 50 });
 *   log.close({ delay: 1500 });
 *
 * Behavioural notes:
 *  - Cancellable via `onCancel(fn)`. Returns user intent to caller.
 *  - Auto-scrolls only when already pinned to the bottom (keeps users
 *    free to scroll back through history mid-run).
 *  - Caps DOM at 400 entries to keep long bulk runs snappy.
 */
export function openOperationLog({
  title = 'Operation',
  context = '',
  total = null,
  cancellable = true,
  variant = 'modal', // 'modal' | 'panel'
} = {}) {
  // Reuse a single host so two consecutive ops don't stack overlays
  document.querySelectorAll('.op-log-overlay[data-autoclose-pending="0"]').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = `op-log-overlay op-log-${variant}`;
  overlay.dataset.autoclosePending = '0';
  overlay.innerHTML = `
    <div class="op-log-card" role="dialog" aria-live="polite">
      <div class="op-log-head">
        <div class="op-log-titles">
          <div class="op-log-title">${escHtml(title)}</div>
          <div class="op-log-context">${escHtml(context)}</div>
        </div>
        <div class="op-log-counters">
          <span class="op-log-count op-log-count-ok"   title="${escHtml(t('oplog.success') || 'Success')}">  <span class="op-log-dot ok"></span><span data-c="ok">0</span></span>
          <span class="op-log-count op-log-count-fail" title="${escHtml(t('oplog.failed')  || 'Failed')}">  <span class="op-log-dot fail"></span><span data-c="fail">0</span></span>
          <span class="op-log-count op-log-count-tot"  title="${escHtml(t('oplog.total')   || 'Total')}">  <span class="op-log-dot tot"></span><span data-c="done">0</span>/<span data-c="total">${total ?? '—'}</span></span>
        </div>
      </div>
      <div class="op-log-bar">
        <div class="op-log-bar-fill ${total ? '' : 'indeterminate'}" style="width:${total ? '0%' : '40%'}"></div>
      </div>
      <div class="op-log-list" role="log" aria-relevant="additions"></div>
      <div class="op-log-foot">
        <div class="op-log-summary" data-summary></div>
        <div class="op-log-actions">
          ${cancellable ? `<button type="button" class="op-log-btn op-log-btn-cancel" data-act="cancel">${escHtml(t('oplog.cancel') || 'Cancel')}</button>` : ''}
          <button type="button" class="op-log-btn op-log-btn-close hidden" data-act="close">${escHtml(t('oplog.close') || 'Close')}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const list = $('.op-log-list');
  const cOk = $('[data-c="ok"]');
  const cFail = $('[data-c="fail"]');
  const cDone = $('[data-c="done"]');
  const cTotal = $('[data-c="total"]');
  const bar = $('.op-log-bar-fill');
  const summary = $('[data-summary]');
  const btnCancel = $('[data-act="cancel"]');
  const btnClose = $('[data-act="close"]');

  let totals = { ok: 0, fail: 0, total };
  let cancelled = false;
  const cancelHandlers = [];
  const rowsByKey = new Map();

  // Register this operation session in the activity feed
  const afId = AF.openSession({ title, context, total });

  function shouldStickBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  }
  function scrollIfPinned() {
    if (shouldStickBottom()) list.scrollTop = list.scrollHeight;
  }
  function recomputeBar() {
    const done = totals.ok + totals.fail;
    cDone.textContent = String(done);
    if (totals.total) {
      cTotal.textContent = String(totals.total);
      const pct = Math.min(100, (done / totals.total) * 100);
      bar.classList.remove('indeterminate');
      bar.style.width = `${pct}%`;
    }
  }
  function trim() {
    while (list.children.length > 400) list.firstChild.remove();
  }
  function makeRow(state, payload) {
    const row = document.createElement('div');
    row.className = `op-log-row op-log-row-${state}`;
    row.innerHTML = `
      <span class="op-log-row-icon">${SVG[state] || SVG.info}</span>
      <div class="op-log-row-body">
        <div class="op-log-row-title"></div>
        <div class="op-log-row-meta"></div>
      </div>
      <span class="op-log-row-time">${timeStr()}</span>
    `;
    row.querySelector('.op-log-row-title').textContent = String(payload.title || '');
    const metaParts = [];
    if (payload.context) metaParts.push(payload.context);
    if (payload.detail)  metaParts.push(payload.detail);
    if (payload.error)   metaParts.push(payload.error);
    row.querySelector('.op-log-row-meta').textContent = metaParts.join(' · ');
    return row;
  }
  function addRow(state, payload, key) {
    const row = makeRow(state, payload);
    if (key) {
      row.dataset.key = key;
      rowsByKey.set(key, row);
    }
    const pinned = shouldStickBottom();
    list.appendChild(row);
    trim();
    if (pinned) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    return row;
  }
  function updateRow(key, state, patch = {}) {
    const row = rowsByKey.get(key);
    if (!row) return addRow(state, patch, key);
    row.className = `op-log-row op-log-row-${state} is-updated`;
    row.querySelector('.op-log-row-icon').innerHTML = SVG[state] || SVG.info;
    if (patch.title) row.querySelector('.op-log-row-title').textContent = String(patch.title);
    const metaEl = row.querySelector('.op-log-row-meta');
    const existing = (metaEl.textContent || '').split(' · ').filter(Boolean);
    const fresh = [];
    if (patch.context) fresh.push(patch.context);
    if (patch.detail)  fresh.push(patch.detail);
    if (patch.error)   fresh.push(patch.error);
    if (fresh.length) metaEl.textContent = fresh.join(' · ');
    else if (!existing.length) metaEl.textContent = '';
    row.querySelector('.op-log-row-time').textContent = timeStr();
    // Restart the slide-pulse animation
    row.classList.remove('is-updated');
    void row.offsetWidth;
    row.classList.add('is-updated');
    scrollIfPinned();
    return row;
  }

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (cancelled) return;
      cancelled = true;
      btnCancel.disabled = true;
      btnCancel.textContent = t('oplog.cancelling') || 'Cancelling…';
      api.info({ title: t('oplog.cancel_requested') || 'Cancellation requested' });
      cancelHandlers.forEach(fn => { try { fn(); } catch (_) {} });
    });
  }
  if (btnClose) {
    btnClose.addEventListener('click', () => api.destroy());
  }

  const api = {
    isCancelled: () => cancelled,
    onCancel(fn) { if (typeof fn === 'function') cancelHandlers.push(fn); },
    setTotal(n) { totals.total = n; recomputeBar(); AF.setSessionTotal(afId, n); },
    setContext(s) { $('.op-log-context').textContent = String(s || ''); },
    setTitle(s) { $('.op-log-title').textContent = String(s || ''); },
    /** Begin a step (shows spinner, no counter change yet). */
    start(key, payload = {}) {
      AF.logEvent(afId, 'spin', { ...payload, key });
      return addRow('spin', payload, key);
    },
    /** Mark a step succeeded; bumps the OK counter. */
    success(key, payload = {}) {
      totals.ok++; cOk.textContent = String(totals.ok);
      recomputeBar();
      AF.logEvent(afId, 'ok', { ...payload, key });
      return updateRow(key, 'ok', payload);
    },
    /** Mark a step failed; bumps the FAIL counter. */
    fail(key, payload = {}) {
      totals.fail++; cFail.textContent = String(totals.fail);
      recomputeBar();
      AF.logEvent(afId, 'fail', { ...payload, key });
      return updateRow(key, 'fail', payload);
    },
    /** Ad-hoc info/warn rows that don't tie to counters. */
    info(payload = {}) { AF.logEvent(afId, 'info', payload); return addRow('info', payload); },
    warn(payload = {}) { AF.logEvent(afId, 'warn', payload); return addRow('warn', payload); },
    /** Quick fire-and-forget shortcut for one-shot ops (start+resolve in 1 row). */
    one(state, payload = {}) {
      if (state === 'ok')   { totals.ok++;   cOk.textContent   = String(totals.ok);   recomputeBar(); AF.logEvent(afId, 'ok',   payload); return addRow('ok',   payload); }
      if (state === 'fail') { totals.fail++; cFail.textContent = String(totals.fail); recomputeBar(); AF.logEvent(afId, 'fail', payload); return addRow('fail', payload); }
      AF.logEvent(afId, state, payload);
      return addRow(state, payload);
    },
    /** Render the final summary banner; locks counters and shows Close. */
    summary(s = {}) {
      const ok = s.ok ?? totals.ok;
      const fail = s.fail ?? totals.fail;
      const total = s.total ?? totals.total ?? (ok + fail);
      bar.classList.remove('indeterminate');
      bar.style.width = total ? `${Math.min(100, ((ok + fail) / total) * 100)}%` : '100%';
      const status = fail === 0
        ? (t('oplog.summary_all_ok') || 'All operations succeeded')
        : (ok === 0
            ? (t('oplog.summary_all_fail') || 'All operations failed')
            : (t('oplog.summary_partial') || 'Completed with some failures'));
      summary.innerHTML = `
        <span class="op-log-sum-ico ${fail === 0 ? 'ok' : ok === 0 ? 'fail' : 'warn'}">${SVG[fail === 0 ? 'ok' : ok === 0 ? 'fail' : 'warn']}</span>
        <span class="op-log-sum-text">
          <strong>${escHtml(status)}</strong>
          <span class="op-log-sum-counts">${ok} ${escHtml(t('oplog.succeeded_short') || 'OK')} · ${fail} ${escHtml(t('oplog.failed_short') || 'fail')} · ${total} ${escHtml(t('oplog.total_short') || 'total')}</span>
        </span>
      `;
      if (btnCancel) btnCancel.classList.add('hidden');
      if (btnClose) btnClose.classList.remove('hidden');
      overlay.classList.add('is-finished');
      overlay.classList.toggle('is-success', fail === 0 && ok > 0);
      overlay.classList.toggle('is-failure', ok === 0 && fail > 0);
      overlay.classList.toggle('is-mixed', ok > 0 && fail > 0);
      AF.finishSession(afId, { ok, fail, total });
    },
    /** Soft auto-close after `delay` ms; user can still click Close earlier. */
    close({ delay = 0 } = {}) {
      overlay.dataset.autoclosePending = '1';
      if (delay <= 0) return api.destroy();
      setTimeout(() => api.destroy(), delay);
    },
    destroy() {
      overlay.classList.add('is-leaving');
      setTimeout(() => overlay.remove(), 220);
    },
    el: overlay,
  };

  // entrance animation
  requestAnimationFrame(() => overlay.classList.add('is-open'));
  return api;
}
