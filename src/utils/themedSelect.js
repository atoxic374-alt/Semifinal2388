// Replaces native <select> elements with a fully-themed, animated dropdown.
// Native selects use the OS popup which never matches our theme. This module
// renders a button + custom popover and forwards changes to the original
// <select> so all existing JS (including .value, change events, form code)
// keeps working.
//
// Skip a select by adding `data-raw` or the `raw` class.

const MOUNTED = new WeakSet();

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function rebuildOptions(host, sel) {
  const list = host.querySelector('.ts-list');
  list.innerHTML = '';
  Array.from(sel.options).forEach((opt, i) => {
    const li = document.createElement('div');
    li.className = 'ts-opt' + (opt.disabled ? ' is-disabled' : '') + (i === sel.selectedIndex ? ' is-selected' : '');
    li.dataset.value = opt.value;
    li.dataset.index = String(i);
    li.innerHTML = `
      <span class="ts-opt-label">${escapeHtml(opt.textContent || opt.label || opt.value)}</span>
      <span class="ts-opt-check">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    `;
    list.appendChild(li);
  });
  refreshLabel(host, sel);
}

function refreshLabel(host, sel) {
  const label = host.querySelector('.ts-label');
  const opt = sel.options[sel.selectedIndex];
  label.textContent = opt ? (opt.textContent || opt.label || opt.value || '—') : '—';
  host.classList.toggle('is-disabled', sel.disabled);
}

function wrap(sel) {
  if (MOUNTED.has(sel)) return;
  if (sel.dataset.raw !== undefined || sel.classList.contains('raw')) return;
  if (sel.multiple || sel.size > 1) return;
  // Don't wrap selects that live inside hidden offscreen containers used as
  // option templates (their parent form needs to manipulate them directly).
  if (sel.closest('[data-no-themed-select]')) return;

  const host = document.createElement('div');
  host.className = 'ts-host';
  if (sel.classList.contains('acct-picker-select')) host.classList.add('ts-acct');
  host.innerHTML = `
    <button type="button" class="ts-btn" tabindex="0">
      <span class="ts-label">—</span>
      <span class="ts-caret" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </button>
    <div class="ts-pop" role="listbox">
      <div class="ts-list"></div>
    </div>
  `;

  // Mirror class names so external CSS keeps targeting our select.
  // Insert host before the original select, then hide the select.
  sel.parentNode.insertBefore(host, sel);
  sel.classList.add('ts-orig');
  sel.style.position = 'absolute';
  sel.style.opacity = '0';
  sel.style.pointerEvents = 'none';
  sel.style.width = '1px';
  sel.style.height = '1px';
  // Move the original inside the host so it stays scoped.
  host.appendChild(sel);

  MOUNTED.add(sel);
  rebuildOptions(host, sel);

  const btn = host.querySelector('.ts-btn');
  const pop = host.querySelector('.ts-pop');
  const list = host.querySelector('.ts-list');

  function open() {
    if (host.classList.contains('is-open') || sel.disabled) return;
    document.querySelectorAll('.ts-host.is-open').forEach(h => { if (h !== host) h.classList.remove('is-open'); });
    host.classList.add('is-open');
    // Position-aware: flip up if no room
    requestAnimationFrame(() => {
      const r = btn.getBoundingClientRect();
      const popH = pop.scrollHeight || 220;
      const room = window.innerHeight - r.bottom;
      host.classList.toggle('drop-up', room < popH + 12 && r.top > popH + 12);
      const cur = list.querySelector('.ts-opt.is-selected');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    });
  }
  function close() { host.classList.remove('is-open'); }
  function toggle() { host.classList.contains('is-open') ? close() : open(); }

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('.ts-opt');
    if (!opt || opt.classList.contains('is-disabled')) return;
    sel.selectedIndex = Number(opt.dataset.index);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    list.querySelectorAll('.ts-opt.is-selected').forEach(o => o.classList.remove('is-selected'));
    opt.classList.add('is-selected');
    refreshLabel(host, sel);
    close();
  });
  document.addEventListener('click', (e) => { if (!host.contains(e.target)) close(); });
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);

  // Watch for option changes / value updates from external code.
  const mo = new MutationObserver(() => rebuildOptions(host, sel));
  mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value'] });
  // Also catch programmatic .value = ... assignments
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (origDescriptor && !sel._tsValuePatched) {
    Object.defineProperty(sel, 'value', {
      get() { return origDescriptor.get.call(this); },
      set(v) {
        origDescriptor.set.call(this, v);
        refreshLabel(host, sel);
        list.querySelectorAll('.ts-opt.is-selected').forEach(o => o.classList.remove('is-selected'));
        const i = sel.selectedIndex;
        const li = list.querySelector(`.ts-opt[data-index="${i}"]`);
        if (li) li.classList.add('is-selected');
      },
      configurable: true
    });
    sel._tsValuePatched = true;
  }
}

function scan(root = document) {
  root.querySelectorAll('select').forEach(wrap);
}

export function mountThemedSelect() {
  scan();
  // Watch the whole document for newly inserted <select> elements.
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (!(n instanceof Element)) return;
        if (n.tagName === 'SELECT') wrap(n);
        else n.querySelectorAll && n.querySelectorAll('select').forEach(wrap);
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
