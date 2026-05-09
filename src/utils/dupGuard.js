import { t } from './i18n.js';

/**
 * Tiny shared duplication-guard helpers used by the manager components.
 *
 * Each manager keeps its own `Map` of in-flight `${action}:${id}` keys plus
 * a `_globalBusy` boolean. These helpers wrap the bookkeeping AND the
 * per-button "is-busy" visual state so the four call sites all behave
 * identically.
 *
 * Usage:
 *   const map = new Map();
 *   if (!markBusy(map, 'leave', id, btn)) return; // already in flight
 *   try { ...await op... } finally { clearBusy(map, 'leave', id, btn); }
 */
export function markBusy(map, action, id, btnEl) {
  const key = `${action}:${id}`;
  if (map.has(key)) return false;
  map.set(key, true);
  if (btnEl) {
    btnEl.classList.add('is-busy');
    btnEl.dataset.prevHtml = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = `<span class="dm-mini-spin"></span> ${escHtml(t('dm.in_progress') || 'In progress…')}`;
  }
  return true;
}

export function clearBusy(map, action, id, btnEl) {
  map.delete(`${action}:${id}`);
  if (btnEl) {
    btnEl.classList.remove('is-busy');
    btnEl.disabled = false;
    if (btnEl.dataset.prevHtml) {
      btnEl.innerHTML = btnEl.dataset.prevHtml;
      delete btnEl.dataset.prevHtml;
    }
  }
}

export function isBusy(map, action, id) {
  return map.has(`${action}:${id}`);
}

function escHtml(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
