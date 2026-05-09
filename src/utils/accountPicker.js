// Reusable account dropdown for any manager that wants to be multi-account aware.
// Usage:
//   const pick = await mountAccountPicker({
//     selectId: 'dm-acct',
//     selected: this.account,
//     onChange: (name) => { this.account = name; this.refresh(); }
//   });
//   pick.html  -> HTML to inject
//   pick.bind(rootEl) -> wire up the change listener after innerHTML write

import { listClientsList } from './discord.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

export async function buildAccountPicker({ selectId, selected }) {
  const { clients, active } = await listClientsList();
  const value = selected || ''; // empty = "use active account"
  const opts = [
    `<option value="">${t('common.use_active')}${active ? ` (${active})` : ''}</option>`,
    ...clients.map(c => {
      const sel = c.name === value ? ' selected' : '';
      const tag = c.active ? ' ●' : '';
      return `<option value="${escapeAttr(c.name)}"${sel}>${escapeHtml(c.name)}${tag}</option>`;
    }),
  ].join('');

  return {
    clients,
    active,
    html: `
      <label class="acct-picker">
        <span class="acct-picker-icon">${icon('user')}</span>
        <span class="acct-picker-label">${t('common.account')}:</span>
        <select id="${selectId}" class="acct-picker-select">${opts}</select>
      </label>
    `,
    bind(root, onChange) {
      const sel = (root || document).querySelector(`#${selectId}`);
      if (!sel) return;
      sel.addEventListener('change', (e) => onChange(e.target.value || null));
    },
  };
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s = '') { return escapeHtml(s); }
