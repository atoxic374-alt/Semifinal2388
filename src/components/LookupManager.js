// Server Lookup — inspect any guild by ID (joined or public preview).
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';

export class LookupManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.account = null;
    this.serverId = '';
    this.result = null;
    this.loading = false;
  }

  async init() { await this.render(); }
  async refresh() { await this.render(); }

  async render() {
    this.contentArea.innerHTML = `
      <div class="mm-page">
        <div class="mm-header">
          <div class="mm-title-row">
            <span class="mm-icon">${icon('search')}</span>
            <div>
              <h2 class="mm-title">${t('lk.title')}</h2>
              <p class="mm-subtitle">${t('lk.subtitle')}</p>
            </div>
          </div>
          <div class="mm-tabs" id="lk-toolbar"></div>
        </div>
        <div class="mm-body">
          <div class="lk-form">
            <input type="text" id="lk-input" placeholder="${t('lk.input_ph')}" value="${this.escAttr(this.serverId)}">
            <button onclick="window.lookupManager.lookup()">${icon('search')} ${t('lk.lookup')}</button>
          </div>
          <div id="lk-result">${this.renderResult()}</div>
        </div>
      </div>
    `;

    const toolbar = this.contentArea.querySelector('#lk-toolbar');
    const picker = await buildAccountPicker({ selectId: 'lk-acct', selected: this.account });
    toolbar.innerHTML = picker.html;
    picker.bind(toolbar, (val) => { this.account = val; });

    const input = this.contentArea.querySelector('#lk-input');
    input?.addEventListener('input', (e) => { this.serverId = e.target.value; });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.lookup(); });
  }

  async lookup() {
    if (this.loading) return;
    const id = (this.serverId || '').trim();
    if (!id) return;
    this.loading = true;
    const out = this.contentArea.querySelector('#lk-result');
    if (out) out.innerHTML = `<div class="mm-info-row mm-muted">${t('common.loading')}</div>`;
    try {
      const r = await window.electronAPI.lookupServer(id, this.account);
      if (!r.success) {
        this.result = null;
        if (out) out.innerHTML = `<div class="mm-info-row mm-muted">${t('lk.fail')}: ${this.escHtml(r.error || '')}</div>`;
        return;
      }
      this.result = r;
      if (out) out.innerHTML = this.renderResult();
    } catch (e) {
      if (out) out.innerHTML = `<div class="mm-info-row mm-muted">${t('lk.fail')}: ${this.escHtml(e.message)}</div>`;
    } finally { this.loading = false; }
  }

  copyId(id) { copyToClipboard(id); }

  renderResult() {
    if (!this.result) return `<div class="mm-info-row mm-muted">${t('lk.empty')}</div>`;
    const { joined, server } = this.result;
    const s = server;
    const initial = (s.name || '?').charAt(0).toUpperCase();
    const features = (s.features || []).slice(0, 24);
    const flags = [];
    if (s.partnered) flags.push(['partner', t('lk.partnered')]);
    if (s.verified)  flags.push(['verified', t('lk.verified')]);
    if (s.community) flags.push(['community', t('lk.community')]);

    // Boost progress bar
    const boostsPct = (s.boostProgress != null) ? Math.round(s.boostProgress * 100) : null;

    return `
      <div class="lk-result">
        <div class="lk-banner">${s.banner ? `<img src="${s.banner}" alt="">` : ''}</div>
        <div class="lk-result-head">
          <div class="lk-icon">${s.icon ? `<img src="${s.icon}" alt="">` : this.escHtml(initial)}</div>
          <div class="lk-headmeta">
            <div class="lk-name">
              ${this.escHtml(s.name)}
              <span class="lk-pill ${joined ? 'yes' : 'no'}">${icon(joined ? 'check' : 'circle_dot')} ${joined ? t('lk.joined_yes') : t('lk.joined_no')}</span>
              ${flags.map(([k, label]) => `<span class="lk-flag lk-flag-${k}">${this.escHtml(label)}</span>`).join('')}
            </div>
            <div class="lk-id">
              <span class="lk-id-text">${s.id}</span>
              <a href="#" class="lk-id-copy" onclick="window.lookupManager.copyId('${s.id}');return false;">${icon('copy') || ''} ${t('lk.copy')}</a>
              ${s.vanityCode ? `<span class="lk-vanity">discord.gg/${this.escHtml(s.vanityCode)}${s.vanityUses != null ? ` · ${this.fmtNum(s.vanityUses)} ${t('lk.uses') || 'uses'}` : ''}</span>` : ''}
            </div>
            ${s.description ? `<div class="lk-desc">${this.escHtml(s.description)}</div>` : ''}
          </div>
        </div>

        <div class="lk-grid">
          ${this.stat(t('lk.members'), this.renderMembersStat(s))}
          ${s.maximum ? this.stat(t('lk.max') || 'Max', this.fmtNum(s.maximum)) : ''}
          ${s.createdAt ? this.stat(t('lk.created'), this.fmtDateRel(s.createdAt)) : ''}
          ${s.ownerName ? this.stat(t('lk.owner'), `<span class="lk-owner-pill">${s.ownerAvatar ? `<img src="${s.ownerAvatar}" alt="">` : ''}<span>${this.escHtml(s.ownerName)}${s.isOwner ? ` · ${t('lk.you') || 'you'}` : ''}</span></span>`) : ''}
          ${s.verificationLevel ? this.stat(t('lk.verification') || 'Verification', this.escHtml(s.verificationLevel)) : ''}
          ${s.explicitFilter ? this.stat(t('lk.filter') || 'Content filter', this.escHtml(this.short(s.explicitFilter))) : ''}
          ${s.preferredLocale ? this.stat(t('lk.locale') || 'Locale', this.escHtml(s.preferredLocale)) : ''}
          ${s.mfaLevel ? this.stat(t('lk.mfa') || '2FA', this.escHtml(s.mfaLevel)) : ''}
        </div>

        ${joined ? `
          <div class="lk-section-title">${t('lk.channels_breakdown') || 'Channels'}</div>
          <div class="lk-channels">
            ${this.chTile('hash',     t('lk.text_channels'),  s.totalText,  s.visibleText != null ? `${s.visibleText} ${t('lk.visible')}` : '')}
            ${this.chTile('volume',   t('lk.voice_channels'), s.totalVoice, '')}
            ${s.totalCats   ? this.chTile('folder',  t('lk.categories') || 'Categories', s.totalCats,   '') : ''}
            ${s.totalAnn    ? this.chTile('megaphone', t('lk.announcements') || 'Announcement', s.totalAnn, '') : ''}
            ${s.totalStage  ? this.chTile('mic',     t('lk.stage') || 'Stage', s.totalStage, '') : ''}
            ${s.totalForum  ? this.chTile('list',    t('lk.forum') || 'Forum', s.totalForum, '') : ''}
          </div>
        ` : ''}

        ${joined && (s.boosts != null) ? `
          <div class="lk-section-title">${t('lk.boost') || 'Server Boost'}</div>
          <div class="lk-boost">
            <div class="lk-boost-head">
              <span class="lk-boost-tier">Tier ${s.tier || 0}</span>
              <span class="lk-boost-count">💎 ${s.boosts} ${t('lk.boosts')}${s.nextTierAt ? ` / ${s.nextTierAt}` : ''}</span>
            </div>
            ${boostsPct != null ? `<div class="lk-boost-bar"><div class="lk-boost-fill" style="width:${boostsPct}%"></div></div>` : ''}
            ${s.nextTierAt && s.boosts < s.nextTierAt
              ? `<div class="lk-boost-note">${(s.nextTierAt - s.boosts)} ${t('lk.boosts_to_next') || 'boost(s) to next tier'}</div>`
              : (s.tier >= 3 ? `<div class="lk-boost-note">${t('lk.max_tier') || 'Max tier reached!'}</div>` : '')}
          </div>
        ` : ''}

        ${joined && s.myRolesList?.length ? `
          <div class="lk-section-title">${t('lk.your_membership') || 'Your membership'}</div>
          <div class="lk-mymember">
            ${s.myNickname ? `<div class="lk-myrow"><span class="lk-mylabel">${t('lk.nickname') || 'Nickname'}</span><span>${this.escHtml(s.myNickname)}</span></div>` : ''}
            ${s.myJoinedAt ? `<div class="lk-myrow"><span class="lk-mylabel">${t('lk.your_join')}</span><span>${this.fmtDateRel(s.myJoinedAt)}</span></div>` : ''}
            <div class="lk-myrow"><span class="lk-mylabel">${t('lk.your_roles')} (${s.myRolesList.length})</span>
              <div class="lk-rolechips">
                ${s.myRolesList.slice(0, 12).map(r => `<span class="lk-rolechip" style="${r.color ? `color:${r.color};border-color:${r.color}55;background:${r.color}1a` : ''}">${this.escHtml(r.name)}</span>`).join('')}
              </div>
            </div>
            ${s.myPermissions?.length ? `<div class="lk-myrow"><span class="lk-mylabel">${t('lk.your_perms') || 'Key permissions'}</span>
              <div class="lk-rolechips">${s.myPermissions.slice(0,8).map(p => `<span class="lk-permchip">${this.escHtml(this.short(p))}</span>`).join('')}</div>
            </div>` : ''}
          </div>
        ` : ''}

        ${joined && s.topRoles?.length ? `
          <div class="lk-section-title">${t('lk.top_roles') || 'Top roles'} (${s.totalRoles || s.topRoles.length})</div>
          <div class="lk-rolechips lk-rolechips-pad">
            ${s.topRoles.map(r => `<span class="lk-rolechip" style="${r.color ? `color:${r.color};border-color:${r.color}55;background:${r.color}1a` : ''}">${this.escHtml(r.name)}${r.members != null ? ` <span class="lk-rolemem">${this.fmtNum(r.members)}</span>` : ''}</span>`).join('')}
          </div>
        ` : ''}

        ${joined && (s.afkChannelName || s.systemChannelName || s.rulesChannelName || s.publicUpdatesChannelName) ? `
          <div class="lk-section-title">${t('lk.special_channels') || 'Special channels'}</div>
          <div class="lk-special">
            ${s.systemChannelName       ? `<div><span>${t('lk.system_ch')   || 'System'}</span><b>#${this.escHtml(s.systemChannelName)}</b></div>` : ''}
            ${s.rulesChannelName        ? `<div><span>${t('lk.rules_ch')    || 'Rules'}</span><b>#${this.escHtml(s.rulesChannelName)}</b></div>` : ''}
            ${s.publicUpdatesChannelName? `<div><span>${t('lk.updates_ch')  || 'Mod updates'}</span><b>#${this.escHtml(s.publicUpdatesChannelName)}</b></div>` : ''}
            ${s.afkChannelName          ? `<div><span>${t('lk.afk_ch')      || 'AFK'}</span><b>🔇 ${this.escHtml(s.afkChannelName)}${s.afkTimeout ? ` · ${Math.round(s.afkTimeout/60)}m` : ''}</b></div>` : ''}
          </div>
        ` : ''}

        ${(s.emojiCount != null || s.stickerCount != null) ? `
          <div class="lk-section-title">${t('lk.emojis') || 'Emojis & stickers'}</div>
          <div class="lk-grid">
            ${s.emojiCount    != null ? this.stat(t('lk.emojis_total')   || 'Emojis',    `${s.emojiCount}${s.animatedEmojis != null ? ` · ${s.animatedEmojis} ${t('lk.animated') || 'animated'}` : ''}`) : ''}
            ${s.stickerCount  != null ? this.stat(t('lk.stickers_total') || 'Stickers',  this.fmtNum(s.stickerCount)) : ''}
          </div>
        ` : ''}

        ${features.length ? `
          <div class="lk-section-title">${t('lk.features')}</div>
          <div class="lk-features">
            ${features.map(f => `<span class="lk-feature">${this.escHtml(this.short(f))}</span>`).join('')}
          </div>` : ''
        }
      </div>
    `;
  }

  renderMembersStat(s) {
    const total  = this.fmtNum(s.members || 0);
    const online = (s.online != null) ? `<span class="lk-online-dot"></span>${this.fmtNum(s.online)} ${t('lk.online')}` : '';
    return `${total}${online ? `<div class="lk-substat">${online}</div>` : ''}`;
  }
  chTile(ic, label, n, sub) {
    return `<div class="lk-ch-tile"><h4>${icon(ic)} ${label}</h4><div class="lk-stat-value">${n ?? 0}${sub ? ` <span class="lk-substat">(${sub})</span>` : ''}</div></div>`;
  }
  short(s) { return String(s).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
  fmtDateRel(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const days = Math.floor((Date.now() - ts) / (1000*60*60*24));
    let rel = '';
    if (days < 30) rel = ` (${days}d ago)`;
    else if (days < 365) rel = ` (${Math.floor(days/30)}mo ago)`;
    else rel = ` (${Math.floor(days/365)}y ago)`;
    return `${d.toLocaleDateString()}${rel}`;
  }

  stat(label, value) {
    return `<div class="lk-stat"><div class="lk-stat-label">${label}</div><div class="lk-stat-value">${value}</div></div>`;
  }

  fmtNum(n) {
    if (!n && n !== 0) return '—';
    if (n > 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n > 1000)    return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }
  escHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  escAttr(s = '') { return this.escHtml(s); }
}
