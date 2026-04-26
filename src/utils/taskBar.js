// Global background-task progress bar mounted at the bottom of the screen.
// Listens to /api/features/stream for {type:'task', task:{...}} events and renders
// an aggregated progress bar + an expandable panel of all currently-running tasks.
// One running task per account is enforced server-side; multiple accounts can run in parallel.

import { t } from './i18n.js';
import { icon } from './icons.js';
import { sfx } from './sounds.js';

const tasksMap = new Map();   // id -> task summary
let bar, fill, label, count, panel, toggleBtn, es, mounted = false;

function activeTasks() { return Array.from(tasksMap.values()).filter(t => t.status === 'running'); }

function fmtPct(t) {
  if (!t.total) return 0;
  return Math.min(100, Math.round((t.current / t.total) * 100));
}

function aggregatePct() {
  const act = activeTasks();
  if (!act.length) return 0;
  let cur = 0, tot = 0;
  for (const ts of act) { cur += ts.current || 0; tot += ts.total || 0; }
  if (!tot) return 5;
  return Math.min(100, Math.round((cur / tot) * 100));
}

function show()  { bar?.classList.add('visible'); }
function hide()  { bar?.classList.remove('visible'); panel?.classList.remove('open'); }

function renderBar() {
  if (!bar) return;
  const act = activeTasks();
  if (!act.length) { hide(); return; }
  show();
  const pct = aggregatePct();
  fill.style.width = pct + '%';
  count.textContent = act.length;
  // Choose first task as primary headline
  const primary = act[0];
  label.innerHTML = `
    <span class="tb-spinner"></span>
    <span class="tb-name">${escapeHtml(primary.label || primary.type)}</span>
    <span class="tb-acct">${escapeHtml(primary.account || '')}</span>
    <span class="tb-pct">${pct}%</span>
  `;
  if (panel?.classList.contains('open')) renderPanel();
}

function renderPanel() {
  if (!panel) return;
  const all = Array.from(tasksMap.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (!all.length) { panel.innerHTML = `<div class="tb-empty">${t('tb.no_tasks')}</div>`; return; }
  panel.innerHTML = `
    <div class="tb-panel-head">
      <span>${icon('rocket')} ${t('tb.title')}</span>
      <button class="tb-clear" type="button">${icon('trash')} ${t('tb.clear_finished')}</button>
    </div>
    <div class="tb-list">
      ${all.slice(0, 30).map(ts => {
        const pct = fmtPct(ts);
        const cls = ts.status;
        return `
          <div class="tb-item ${cls}" data-id="${ts.id}">
            <div class="tb-item-head">
              <span class="tb-dot tb-dot-${cls}"></span>
              <span class="tb-item-name">${escapeHtml(ts.label || ts.type)}</span>
              <span class="tb-item-acct">${escapeHtml(ts.account || '')}</span>
              <span class="tb-item-status">${t('tb.status_' + cls) || cls}</span>
              ${ts.status === 'running' ? `<button class="tb-cancel" data-id="${ts.id}">${t('tb.cancel')}</button>` : ''}
            </div>
            <div class="tb-item-bar"><div class="tb-item-fill" style="width:${pct}%"></div></div>
            <div class="tb-item-meta">
              <span>${ts.current || 0}/${ts.total || 0}</span>
              <span class="tb-ok">${t('tb.ok')}: ${ts.okCount || 0}</span>
              <span class="tb-fail">${t('tb.fail')}: ${ts.failCount || 0}</span>
              ${ts.error ? `<span class="tb-err">${escapeHtml(ts.error)}</span>` : ''}
            </div>
            ${ts.lastItem ? `
              <div class="tb-last ${ts.lastItem.ok ? 'ok' : 'fail'}">
                ${ts.lastItem.ok ? '✓' : '✗'}
                ${escapeHtml(ts.lastItem.username || ts.lastItem.id || '')}
                ${ts.lastItem.error ? `<span class="tb-last-err">— ${escapeHtml(ts.lastItem.error)}</span>` : ''}
              </div>
            ` : ''}
          </div>`;
      }).join('')}
    </div>
  `;
  panel.querySelectorAll('.tb-cancel').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      try { await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' }); sfx.click(); } catch (_) {}
    });
  });
  panel.querySelector('.tb-clear')?.addEventListener('click', async () => {
    const finished = Array.from(tasksMap.values()).filter(x => x.status !== 'running');
    for (const f of finished) {
      try { await fetch(`/api/tasks/${f.id}`, { method: 'DELETE' }); } catch (_) {}
      tasksMap.delete(f.id);
    }
    renderBar();
  });
}

function onTask(task) {
  if (!task) return;
  const prev = tasksMap.get(task.id);
  tasksMap.set(task.id, { ...(prev || {}), ...task });
  // Sound when a task finishes
  if (prev && prev.status === 'running' && task.status !== 'running') {
    if (task.status === 'done')      sfx.ding?.();
    else if (task.status === 'failed') sfx.err?.();
  }
  renderBar();
}

function connectStream() {
  if (es) try { es.close(); } catch (_) {}
  try {
    es = new EventSource('/api/features/stream');
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === 'task' && d.task) onTask(d.task);
      } catch (_) {}
    };
    es.onerror = () => { /* auto-reconnects */ };
  } catch (_) {}
}

async function bootstrap() {
  try {
    const r = await fetch('/api/tasks').then(x => x.json());
    if (r.success && Array.isArray(r.tasks)) for (const ts of r.tasks) tasksMap.set(ts.id, ts);
    renderBar();
  } catch (_) {}
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountTaskBar() {
  if (mounted) return;
  mounted = true;
  bar = document.createElement('div');
  bar.id = 'taskBar';
  bar.className = 'task-bar';
  bar.innerHTML = `
    <div class="tb-row">
      <div class="tb-label" id="tb-label"></div>
      <div class="tb-controls">
        <span class="tb-count" id="tb-count">0</span>
        <button class="tb-toggle" id="tb-toggle" type="button" title="Show all tasks">▴</button>
      </div>
    </div>
    <div class="tb-progress"><div class="tb-fill" id="tb-fill"></div></div>
    <div class="tb-panel" id="tb-panel"></div>
  `;
  document.body.appendChild(bar);

  fill      = bar.querySelector('#tb-fill');
  label     = bar.querySelector('#tb-label');
  count     = bar.querySelector('#tb-count');
  panel     = bar.querySelector('#tb-panel');
  toggleBtn = bar.querySelector('#tb-toggle');

  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('open');
    toggleBtn.textContent = panel.classList.contains('open') ? '▾' : '▴';
    if (panel.classList.contains('open')) renderPanel();
  });

  bootstrap();
  connectStream();
}
