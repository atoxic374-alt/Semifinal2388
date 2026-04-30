// BotsManager — auto-create real Discord bots from a selfbot user account.
// Generator tab: pick account + name pattern + count + cooldown + avatar/banner + captcha config.
// Library tab: lists all created bots, copy single token, export "All tokens".
import { buildAccountPicker } from '../utils/accountPicker.js';
import { showNotification, showConfirm } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { t } from '../utils/i18n.js';
import { icon } from '../utils/icons.js';
import { sfx } from '../utils/sounds.js';

export class BotsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.tab = 'gen';        // 'gen' | 'lib'
    this.account = null;
    this.bots = [];
    this.sections = { created: [], synced: [], teamBots: [] };
    this.teams = [];
    this.capacity = [];
    this.task = { state: 'idle' };
    this.config = { has2captcha: false };
    this.sse = null;
    this.form = {
      count: 5,
      namePattern: 'Bot {n}',
      cooldownSec: 120,
      avatarDataUrl: null,
      bannerDataUrl: null,
      captchaKey: '',
      accountPassword: ''
    };
    this._captchaSaveTimer = null;
    this._captchaHealthTimer = null;
    this._captchaHealth = null;
    this._inited = false;
  }

  async init() {
    await this.refreshAll();
    if (!this._inited) {
      this.openSSE();
      this._inited = true;
    }
    this.render();
  }

  async refreshAll() {
    try {
      const [list, status, cfg, toks] = await Promise.all([
        window.electronAPI.botsList(),
        window.electronAPI.botsStatus(),
        window.electronAPI.botsGetConfig(),
        // Pull saved tokens so we know which accounts have a stored password
        window.electronAPI.getTokens ? window.electronAPI.getTokens() : Promise.resolve({ tokens: [] })
      ]);
      this.bots = list?.bots || [];
      this.sections = list?.sections || { created: this.bots, synced: [], teamBots: [] };
      this.task = status?.task || { state: 'idle' };
      this.config = cfg?.config || { has2captcha: false };
      this.savedTokens = toks?.tokens || [];
    } catch (e) {
      showNotification('Failed to load bots: ' + e.message, 'error');
    }
    // Teams + capacity are non-fatal — load in the background.
    this.refreshLibraryAux();
  }

  hasStoredPassword(name) {
    if (!name || !Array.isArray(this.savedTokens)) return false;
    const t = this.savedTokens.find(x => x.name === name);
    return !!t?.hasPassword;
  }

  async refreshLibraryAux() {
    try {
      const [tr, cap] = await Promise.all([
        window.electronAPI.botsTeams().catch(() => ({ teams: [] })),
        window.electronAPI.botsCapacity().catch(() => ({ accounts: [] })),
      ]);
      this.teams = tr?.teams || [];
      this.capacity = cap?.accounts || [];
      if (this.tab === 'lib') this.renderLibrary();
    } catch (e) { /* non-fatal */ }
  }

  openSSE() {
    try {
      const types = ['bot_created', 'bot_failed', 'bot_progress', 'bot_captcha', 'bot_done'].join(',');
      this.sse = new EventSource(`/api/features/stream?types=${types}`);
      this.sse.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.task) this.task = data.task;
          if (data.type === 'bot_created' && data.bot) {
            this.bots.push({ ...data.bot, token: '••••••••' });
            sfx.ding?.();
          }
          if (data.type === 'bot_done') {
            sfx.ding?.();
            // Re-fetch to get full token for newly created bots
            window.electronAPI.botsList().then(r => { this.bots = r?.bots || this.bots; this.renderLibrary(); });
            showNotification(t('bm.task_done'));
          }
          if (data.type === 'bot_failed') {
            const code = data.code ? ` [${data.code}]` : '';
            showNotification(`${t('bm.failed_for')} ${data.name}${code}: ${data.error}`, 'error');
          }
          if (data.type === 'bot_captcha') {
            // A NEW captcha challenge arrived — wipe any stale input the user may
            // have already typed for the previous (now-expired) challenge.
            const stale = this.contentArea.querySelector('#bm-captcha-input');
            if (stale) stale.value = '';
            this._lastCaptchaNonce = data.nonce || null;
            showNotification(t('bm.captcha_needed'));
          }
          this.renderHeader();
          this.renderProgress();
        } catch (e) {}
      };
      this.sse.onerror = () => {};
    } catch (e) {}
  }

  // ─── RENDERING
  render() {
    this.contentArea.innerHTML = `
      <div class="bm-wrap">
        <div class="bm-head">
          <div>
            <h2 class="bm-title">${icon('shield')} <span data-i18n="bm.title">${t('bm.title')}</span></h2>
            <p class="bm-sub">${t('bm.subtitle')}</p>
          </div>
          <div class="bm-tabs">
            <button class="bm-tab ${this.tab === 'gen' ? 'active' : ''}" data-tab="gen">${icon('plus')} ${t('bm.tab_generator')}</button>
            <button class="bm-tab ${this.tab === 'lib' ? 'active' : ''}" data-tab="lib">${icon('users')} ${t('bm.tab_library')} <span class="bm-count">${this.bots.length}</span></button>
          </div>
        </div>

        <div id="bm-progress" class="bm-progress"></div>
        <div id="bm-body"></div>
      </div>
    `;
    this.contentArea.querySelectorAll('.bm-tab').forEach(b => {
      b.addEventListener('click', async () => {
        this.tab = b.dataset.tab;
        sfx.click?.();
        this.contentArea.querySelectorAll('.bm-tab').forEach(x => x.classList.toggle('active', x === b));
        this.renderBody();
        // When entering the Library tab, force a fresh sync from Discord so the
        // user sees Created/Synced/Teams/Capacity reflecting the live state.
        if (this.tab === 'lib') {
          await this.refreshAll().catch(() => {});
          this.renderLibrary();
        }
      });
    });
    this.renderProgress();
    this.renderBody();
  }

  renderHeader() {
    const c = this.contentArea.querySelector('.bm-count');
    if (c) c.textContent = this.bots.length;
  }

  renderProgress() {
    const wrap = this.contentArea.querySelector('#bm-progress');
    if (!wrap) return;
    const t1 = this.task || {};
    if (t1.state === 'idle') { wrap.innerHTML = ''; return; }
    const pct = t1.total ? Math.round(((t1.done + t1.failed) / t1.total) * 100) : 0;
    const stateLabel = ({
      running: t('bm.state_running'),
      waiting_captcha: t('bm.state_waiting_captcha'),
      done: t('bm.state_done'),
      cancelled: t('bm.state_cancelled'),
      error: t('bm.state_error')
    })[t1.state] || t1.state;
    const _sitekey = t1.captcha?.sitekey || '';
    const _service = t1.captcha?.service || 'hcaptcha';
    const _pageUrl = t1.captcha?.pageUrl || 'https://discord.com';
    const _nonce   = t1.captcha?.nonce || '';
    const _hasRqdata = !!t1.captcha?.rqdata;
    // Track this nonce so submitCaptcha can include it
    if (_nonce) this._currentCaptchaNonce = _nonce;
    const captchaPanel = t1.waitingCaptcha ? `
      <div class="bm-captcha">
        <div class="bm-captcha-msg">${icon('shield')} ${t('bm.captcha_panel_msg')}</div>
        <div class="bm-captcha-meta">
          <div class="bm-captcha-field">
            <span class="bm-captcha-label">${t('bm.challenge')}</span>
            <code class="bm-captcha-val" title="Unique id for this challenge — old solutions for previous challenges are rejected">#${escapeHtml(_nonce.slice(0,12))}</code>
            <span class="bm-captcha-label" style="color:${_hasRqdata ? '#23a55a' : '#f0b232'}">${_hasRqdata ? `✔ ${t('bm.enterprise_rqdata')}` : t('bm.basic')}</span>
          </div>
          <div class="bm-captcha-field">
            <span class="bm-captcha-label">${t('bm.sitekey')}</span>
            <code class="bm-captcha-val" data-cap-copy="${escapeAttr(_sitekey)}" title="Click to copy">${escapeHtml(_sitekey)}</code>
            <button class="bm-btn ghost xsmall bm-cap-copy" data-cap-copy="${escapeAttr(_sitekey)}" title="${t('bm.copy_sitekey')}">${icon('copy')}</button>
          </div>
          <div class="bm-captcha-field">
            <span class="bm-captcha-label">${t('bm.page_url')}</span>
            <code class="bm-captcha-val" data-cap-copy="${escapeAttr(_pageUrl)}" title="Click to copy">${escapeHtml(_pageUrl)}</code>
            <button class="bm-btn ghost xsmall bm-cap-copy" data-cap-copy="${escapeAttr(_pageUrl)}" title="${t('bm.copy_url')}">${icon('copy')}</button>
          </div>
        </div>
        <div class="bm-captcha-row">
          <button class="bm-btn primary" id="bm-captcha-helper" title="${t('bm.solve_browser_tip')}">${icon('shield')} ${t('bm.solve_browser')}</button>
        </div>
        <div class="bm-captcha-row">
          <input type="text" id="bm-captcha-input" placeholder="${t('bm.captcha_manual_placeholder')}" />
          <button class="bm-btn" id="bm-captcha-submit">${icon('check')} ${t('bm.submit')}</button>
        </div>
        <div class="bm-captcha-hint">
          ${_hasRqdata
            ? t('bm.enterprise_hint')
            : t('bm.captcha_hint')}
        </div>
        <div class="bm-captcha-health" id="bm-captcha-health">
          ${this.renderCaptchaHealth()}
        </div>
      </div>
    ` : '';
    wrap.innerHTML = `
      <div class="bm-status ${t1.state}">
        <div class="bm-status-row">
          <span class="bm-pill bm-pill-${t1.state}">${stateLabel}</span>
          <span class="bm-status-text">${escapeHtml(t1.current || '')} ${t1.lastError ? '· ⚠ ' + escapeHtml(t1.lastError) : ''}</span>
          <span class="bm-status-counts">${t1.done}/${t1.total} ${t('bm.done')} · ${t1.failed} ${t('bm.failed')}</span>
          ${(t1.state === 'running' || t1.state === 'waiting_captcha') ? `<button class="bm-btn danger small" id="bm-cancel">${icon('x')} ${t('bm.cancel')}</button>` : ''}
        </div>
        <div class="bm-bar"><div class="bm-bar-fill" style="width:${pct}%"></div></div>
        ${captchaPanel}
      </div>
    `;
    wrap.querySelector('#bm-cancel')?.addEventListener('click', () => this.cancelTask());
    if (t1.waitingCaptcha) this.startCaptchaHealthPoll();
    else this.stopCaptchaHealthPoll();
    const sub = wrap.querySelector('#bm-captcha-submit');
    if (sub) sub.addEventListener('click', () => this.submitCaptcha());
    const helperBtn = wrap.querySelector('#bm-captcha-helper');
    if (helperBtn) helperBtn.addEventListener('click', () => {
      // Open in a popup so the hCaptcha widget renders with the correct rqdata.
      // The popup itself POSTs back to /api/bots/captcha and closes when done.
      const w = window.open('/captcha-helper', 'discord-captcha-helper', 'width=600,height=720,resizable=yes,scrollbars=yes');
      if (!w) showNotification(t('bm.popup_blocked'), 'error');
    });
    // Copy buttons / clickable values for sitekey / page URL
    wrap.querySelectorAll('[data-cap-copy]').forEach(el => {
      el.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const v = el.getAttribute('data-cap-copy') || '';
        if (!v) return;
        try { await copyToClipboard(v); showNotification(t('common.copied') || 'Copied', 'success'); }
        catch (e) { showNotification(t('common.copy_failed') || 'Copy failed', 'error'); }
      });
    });
  }

  renderCaptchaHealth() {
    const h = this._captchaHealth;
    if (!h) return `<span class="bm-hint">${t('bm.health_checking')}</span>`;
    const status = h.connected ? t('bm.health_connected') : (h.expired ? t('bm.health_expired') : t('bm.health_stale'));
    return `
      <div class="bm-hint">${t('bm.health_status')}: <strong>${status}</strong></div>
      ${h.fingerprint ? `<div class="bm-hint">${t('bm.health_fingerprint')}: <code>${escapeHtml(h.fingerprint)}</code></div>` : ''}
      ${h.ageSec != null ? `<div class="bm-hint">${t('bm.health_age')}: ${h.ageSec}s</div>` : ''}
    `;
  }

  startCaptchaHealthPoll() {
    if (this._captchaHealthTimer) return;
    const tick = async () => {
      try {
        this._captchaHealth = await window.electronAPI.botsCaptchaHealth();
        const el = this.contentArea.querySelector('#bm-captcha-health');
        if (el) el.innerHTML = this.renderCaptchaHealth();
      } catch (e) {}
    };
    tick();
    this._captchaHealthTimer = setInterval(tick, 2000);
  }

  stopCaptchaHealthPoll() {
    if (this._captchaHealthTimer) clearInterval(this._captchaHealthTimer);
    this._captchaHealthTimer = null;
    this._captchaHealth = null;
  }

  async renderBody() {
    const body = this.contentArea.querySelector('#bm-body');
    if (!body) return;
    if (this.tab === 'gen') return this.renderGenerator(body);
    return this.renderLibraryInto(body);
  }

  async renderGenerator(body) {
    const picker = await buildAccountPicker({ selectId: 'bm-account', selected: this.account });
    if (!this.account && picker.active) this.account = picker.active;
    body.innerHTML = `
      <div class="bm-card">
        <div class="bm-row">${picker.html}</div>

        <div class="bm-grid">
          <div class="bm-field">
            <label>${t('bm.name_pattern')}</label>
            <input type="text" id="bm-name" value="${escapeAttr(this.form.namePattern)}" placeholder="Bot {n}" maxlength="32" />
            <span class="bm-hint">${t('bm.name_pattern_hint')}</span>
          </div>
          <div class="bm-field">
            <label>${t('bm.count')}</label>
            <input type="number" id="bm-count" value="${this.form.count}" min="1" max="50" />
            <span class="bm-hint">${t('bm.count_hint')}</span>
          </div>
          <div class="bm-field">
            <label>${t('bm.cooldown')}: <strong id="bm-cooldown-label">${this.form.cooldownSec}s</strong></label>
            <input type="range" id="bm-cooldown" min="30" max="600" step="10" value="${this.form.cooldownSec}" />
            <span class="bm-hint">${t('bm.cooldown_hint')}</span>
          </div>
        </div>

        <div class="bm-grid">
          <div class="bm-field">
            <label>${t('bm.password')} ${this.hasStoredPassword(this.account) ? `<span style="color:#23a55a;font-size:11px;margin-left:6px">✔ ${t('bm.saved_for_account')}</span>` : ''}</label>
            <div style="display:flex;gap:6px">
              <input type="password" id="bm-account-password" value="${escapeAttr(this.form.accountPassword || '')}" placeholder="${this.hasStoredPassword(this.account) ? t('bm.using_saved_leave_blank') : t('bm.password_optional')}" autocomplete="off" style="flex:1" />
              <button class="bm-btn ghost small" id="bm-save-password" type="button" title="${t('bm.password_save_tip')}">${icon('check')} ${t('common.saved')}</button>
              ${this.hasStoredPassword(this.account) ? `<button class="bm-btn ghost small" id="bm-clear-password" type="button" title="Remove the saved password for this account">${icon('trash')}</button>` : ''}
            </div>
            <span class="bm-hint">Stored encrypted (AES-256-GCM). Used automatically for captcha-protected actions on this account.</span>
          </div>
          <div class="bm-field">
            <label>${icon('image')} ${t('bm.avatar')}</label>
            <div class="bm-pick-row">
              <input type="file" id="bm-avatar" accept="image/*" />
              <div class="bm-thumb" id="bm-avatar-preview">${this.form.avatarDataUrl ? `<img src="${this.form.avatarDataUrl}">` : '<span>—</span>'}</div>
              ${this.form.avatarDataUrl ? `<button class="bm-btn ghost small" id="bm-avatar-clear">${icon('x')}</button>` : ''}
            </div>
          </div>
          <div class="bm-field">
            <label>${icon('image')} ${t('bm.banner')}</label>
            <div class="bm-pick-row">
              <input type="file" id="bm-banner" accept="image/*" />
              <div class="bm-thumb wide" id="bm-banner-preview">${this.form.bannerDataUrl ? `<img src="${this.form.bannerDataUrl}">` : '<span>—</span>'}</div>
              ${this.form.bannerDataUrl ? `<button class="bm-btn ghost small" id="bm-banner-clear">${icon('x')}</button>` : ''}
            </div>
          </div>
        </div>

        <div class="bm-captcha-config">
          <div class="bm-cap-head">${icon('shield')} ${t('bm.captcha_section')}</div>
          <div class="bm-cap-status ${this.config.has2captcha ? 'ok' : ''}">
            ${this.config.has2captcha ? `✔ ${t('bm.has_2captcha')}` : `⚠ ${t('bm.no_2captcha')}`}
          </div>
          <div class="bm-cap-row">
            <input type="password" id="bm-2cap-key" placeholder="${t('bm.captcha_key_placeholder')}" autocomplete="off" />
            <button class="bm-btn" id="bm-save-2cap">${icon('check')} ${t('bm.save_key')}</button>
            ${this.config.has2captcha ? `<button class="bm-btn ghost" id="bm-clear-2cap">${icon('trash')} ${t('bm.clear_key')}</button>` : ''}
          </div>
          <div class="bm-cap-row">
            <a class="bm-btn ghost" href="https://2captcha.com/?from=14692907" target="_blank" rel="noopener">${icon('external')} ${t('bm.get_key')}</a>
            <a class="bm-btn ghost" href="https://2captcha.com/setting" target="_blank" rel="noopener">${icon('settings')} ${t('bm.open_dashboard')}</a>
            <span class="bm-hint" style="align-self:center">${t('bm.auto_save_hint')}</span>
          </div>
          <div class="bm-hint">${t('bm.captcha_section_hint')}</div>
          <div class="bm-hint">${t('bm.captcha_how_to')}</div>
        </div>

        <div class="bm-warn">
          ${icon('shield')} ${t('bm.warn')}
        </div>

        <div class="bm-actions">
          <button class="bm-btn primary big" id="bm-start">${icon('plus')} ${t('bm.start')}</button>
        </div>
      </div>
    `;
    picker.bind(body, (name) => {
      this.account = name || null;
      // Re-render the password row so the "saved" badge updates for the new account
      this.renderBody();
    });
    body.querySelector('#bm-name').addEventListener('input', e => this.form.namePattern = e.target.value);
    body.querySelector('#bm-count').addEventListener('input', e => this.form.count = Math.max(1, Math.min(50, parseInt(e.target.value || '1') || 1)));
    body.querySelector('#bm-account-password')?.addEventListener('input', e => this.form.accountPassword = e.target.value || '');
    body.querySelector('#bm-save-password')?.addEventListener('click', async () => {
      if (!this.account) return showNotification(t('bm.pick_account'), 'error');
      const pw = (body.querySelector('#bm-account-password')?.value || '').trim();
      if (!pw) return showNotification(t('bm.password_type_first'), 'error');
      try {
        await window.electronAPI.setAccountPassword(this.account, pw);
        showNotification(t('bm.password_saved_for').replace('{account}', this.account), 'success');
        this.form.accountPassword = '';
        await this.refreshAll();
        this.renderBody();
      } catch (e) { showNotification(e.message || 'Failed to save', 'error'); }
    });
    body.querySelector('#bm-clear-password')?.addEventListener('click', async () => {
      if (!this.account) return;
      try {
        await window.electronAPI.setAccountPassword(this.account, '');
        showNotification(t('bm.password_cleared_for').replace('{account}', this.account), 'success');
        await this.refreshAll();
        this.renderBody();
      } catch (e) { showNotification(e.message || 'Failed', 'error'); }
    });
    const cd = body.querySelector('#bm-cooldown');
    const cdLbl = body.querySelector('#bm-cooldown-label');
    cd.addEventListener('input', e => { this.form.cooldownSec = parseInt(e.target.value); cdLbl.textContent = `${this.form.cooldownSec}s`; });
    body.querySelector('#bm-avatar').addEventListener('change', (e) => this.handleFile(e, 'avatarDataUrl', '#bm-avatar-preview'));
    body.querySelector('#bm-banner').addEventListener('change', (e) => this.handleFile(e, 'bannerDataUrl', '#bm-banner-preview'));
    body.querySelector('#bm-avatar-clear')?.addEventListener('click', () => { this.form.avatarDataUrl = null; this.renderBody(); });
    body.querySelector('#bm-banner-clear')?.addEventListener('click', () => { this.form.bannerDataUrl = null; this.renderBody(); });
    const capInput = body.querySelector('#bm-2cap-key');
    body.querySelector('#bm-save-2cap').addEventListener('click', () => this.saveCaptchaKey(capInput.value, true));
    body.querySelector('#bm-clear-2cap')?.addEventListener('click', () => this.saveCaptchaKey('', true));
    // Auto-save the captcha key on input (debounced) so users don't need to press Save
    capInput.addEventListener('input', (e) => {
      clearTimeout(this._captchaSaveTimer);
      const v = e.target.value;
      this._captchaSaveTimer = setTimeout(() => {
        if (v && v.trim()) this.saveCaptchaKey(v, false);
      }, 800);
    });
    body.querySelector('#bm-start').addEventListener('click', () => this.startTask());
  }

  async handleFile(e, key, previewSel) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { showNotification('Image too large (max 8MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      this.form[key] = reader.result;
      const p = this.contentArea.querySelector(previewSel);
      if (p) p.innerHTML = `<img src="${reader.result}">`;
      this.renderBody();
    };
    reader.readAsDataURL(f);
  }

  renderLibrary() { const b = this.contentArea.querySelector('#bm-body'); if (b && this.tab === 'lib') this.renderLibraryInto(b); this.renderHeader(); }

  renderLibraryInto(body) {
    const created = (this.sections?.created || []).slice().sort((a, b) => a.number - b.number);
    const synced  = (this.sections?.synced  || []).slice().sort((a, b) => a.number - b.number);
    const teamBots = (this.sections?.teamBots || []).slice().sort((a, b) => a.number - b.number);
    const teams = this.teams || [];
    const capacity = this.capacity || [];

    // Don't early-return on empty state anymore: even when this user has no bots,
    // we still want to show the account capacity and the empty Created/Synced/Teams
    // sections so the user can see the new layout and that nothing is missing.

    body.innerHTML = `
      <div class="bm-lib-head">
        <div class="bm-lib-count">${this.bots.length} ${t('bm.bots') || 'bots'}</div>
        <div class="bm-lib-actions">
          <a class="bm-btn primary" href="${window.electronAPI.botsAllTokensUrl('text')}" download>${icon('download')} ${t('bm.export_all')}</a>
          <a class="bm-btn ghost" href="${window.electronAPI.botsAllTokensUrl('json')}" download>${icon('download')} JSON</a>
          <button class="bm-btn ghost" id="bm-copy-all">${icon('copy')} ${t('bm.copy_all')}</button>
          <button class="bm-btn ghost" id="bm-refresh-lib">${icon('refresh') || ''} ${t('bm.refresh') || 'Refresh'}</button>
          <button class="bm-btn ghost" id="bm-verify-pending">${icon('shield') || ''} ${t('bm.verify_pending') || 'Verify pending'}</button>
        </div>
      </div>

      ${capacity.length ? `
        <div class="bm-lib-section">
          <div class="bm-lib-section-head">
            <h3>${icon('shield')} ${t('bm.capacity_title') || 'Account capacity'}</h3>
            <span class="bm-lib-section-sub">${t('bm.capacity_hint') || 'Discord caps applications per account'}</span>
          </div>
          <div class="bm-cap-grid">
            ${capacity.map(c => this.capacityCardHtml(c)).join('')}
          </div>
        </div>
      ` : ''}

      <div class="bm-lib-section">
        <div class="bm-lib-section-head">
          <h3>${icon('plus')} ${t('bm.section_created') || 'Bots created here'} <span class="bm-pill">${created.length}</span></h3>
          <span class="bm-lib-section-sub">${t('bm.section_created_hint') || 'Bots created through this app'}</span>
        </div>
        ${created.length ? `<div class="bm-list">${created.map(b => this.botCardHtml(b)).join('')}</div>` : `<div class="bm-empty-mini">${t('bm.section_created_empty') || 'No bots created yet'}</div>`}
      </div>

      <div class="bm-lib-section">
        <div class="bm-lib-section-head">
          <h3>${icon('users')} ${t('bm.section_synced') || 'Existing bots on Discord'} <span class="bm-pill">${synced.length}</span></h3>
          <span class="bm-lib-section-sub">${t('bm.section_synced_hint') || 'Discovered from your connected accounts'}</span>
        </div>
        ${synced.length ? `<div class="bm-list">${synced.map(b => this.botCardHtml(b)).join('')}</div>` : `<div class="bm-empty-mini">${t('bm.section_synced_empty') || 'No external bots found on connected accounts'}</div>`}
      </div>

      <div class="bm-lib-section">
        <div class="bm-lib-section-head">
          <h3>${icon('users')} ${t('bm.section_teams') || 'Teams'} <span class="bm-pill">${teams.length}</span></h3>
          <span class="bm-lib-section-sub">${t('bm.section_teams_hint') || 'Discord developer teams you belong to'}</span>
        </div>
        ${teams.length ? `<div class="bm-team-grid">${teams.map(team => this.teamCardHtml(team, teamBots)).join('')}</div>` : `<div class="bm-empty-mini">${t('bm.section_teams_empty') || 'You are not a member of any team'}</div>`}
      </div>
    `;

    body.querySelector('#bm-copy-all').addEventListener('click', async () => {
      const all = (this.bots || []).slice().sort((a, b) => a.number - b.number);
      const text = all.map(b => `${String(b.number).padStart(3, '0')}\t${b.name}\t${b.token}\t${b.password || ''}`).join('\n');
      await copyToClipboard(text);
      showNotification(t('bm.copied_all'));
    });
    body.querySelector('#bm-refresh-lib')?.addEventListener('click', () => this.refreshAll().then(() => this.renderLibrary()));
    body.querySelector('#bm-verify-pending')?.addEventListener('click', async () => {
      try {
        const r = await window.electronAPI.botsVerifyPending();
        showNotification((t('bm.verify_pending_done') || 'Verifier done') + `: ${r.fixed}/${r.checked}`);
        await this.refreshAll();
        this.renderLibrary();
      } catch (e) { showNotification(e.message, 'error'); }
    });
    body.querySelectorAll('.bm-card-bot').forEach(card => {
      const id = card.dataset.id;
      const bot = this.bots.find(x => x.id === id);
      if (!bot) return;
      card.querySelector('.bm-copy-token')?.addEventListener('click', async () => { await copyToClipboard(bot.token); showNotification(t('bm.copied_token')); });
      card.querySelector('.bm-copy-pw')?.addEventListener('click', async () => { await copyToClipboard(bot.password); showNotification(t('bm.copied_pw')); });
      card.querySelector('.bm-toggle-token')?.addEventListener('click', () => {
        const span = card.querySelector('.bm-token-val');
        const hidden = span.dataset.hidden === '1';
        span.textContent = hidden ? bot.token : maskToken(bot.token);
        span.dataset.hidden = hidden ? '0' : '1';
      });
      card.querySelector('.bm-del')?.addEventListener('click', () => this.deleteBot(bot));
      card.querySelector('.bm-del-discord')?.addEventListener('click', () => this.deleteBotFromDiscord(bot));
      card.querySelector('.bm-reset-token')?.addEventListener('click', () => this.resetBotToken(bot));
    });
  }

  capacityCardHtml(c) {
    const used = (c.used == null) ? '?' : c.used;
    const limit = c.limit || 25;
    const remaining = (c.remaining == null) ? '—' : c.remaining;
    const pct = (typeof c.used === 'number') ? Math.min(100, Math.round((c.used / limit) * 100)) : 0;
    const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok';
    const err = c.error ? `<div class="bm-cap-err">${escapeHtml(c.error)}</div>` : '';
    return `
      <div class="bm-cap-card">
        <div class="bm-cap-head">
          <span class="bm-cap-name">${escapeHtml(c.account)}</span>
          <span class="bm-cap-num bm-cap-num-${cls}">${used} / ${limit}</span>
        </div>
        <div class="bm-cap-bar"><div class="bm-cap-bar-fill bm-cap-bar-${cls}" style="width:${pct}%"></div></div>
        <div class="bm-cap-foot">${remaining === '—' ? '' : `${remaining} ${t('bm.cap_remaining') || 'slots remaining'}`}</div>
        ${err}
      </div>
    `;
  }

  teamCardHtml(team, teamBots) {
    const myBots = teamBots.filter(b => b.team?.id === team.id);
    return `
      <div class="bm-team-card">
        <div class="bm-team-head">
          <span class="bm-team-name">${icon('users')} ${escapeHtml(team.name)}</span>
          <span class="bm-team-sub">${myBots.length} ${t('bm.bots') || 'bots'} · ${team.memberCount} ${t('bm.members') || 'members'}</span>
        </div>
        <div class="bm-team-meta">id: <code>${escapeHtml(team.id)}</code> · ${t('bm.via') || 'via'} <code>${escapeHtml(team.discoveredVia)}</code></div>
        ${myBots.length ? `<div class="bm-team-bots">${myBots.map(b => `<span class="bm-team-bot-pill">#${String(b.number).padStart(3,'0')} ${escapeHtml(b.name)}</span>`).join('')}</div>` : ''}
      </div>
    `;
  }

  botCardHtml(b) {
    const hasToken = !!b.token;
    return `
      <div class="bm-card-bot" data-id="${escapeAttr(b.id)}">
        <div class="bm-bot-head">
          ${b.avatarUrl ? `<img class="bm-bot-avatar" src="${escapeAttr(b.avatarUrl)}" alt="avatar" />` : ''}
          <span class="bm-bot-num">#${String(b.number).padStart(3, '0')}</span>
          <span class="bm-bot-name">${escapeHtml(b.name)}</span>
          <span class="bm-bot-meta">app: <code>${escapeHtml(b.appId)}</code></span>
          ${b.team?.name ? `<span class="bm-bot-meta">team: <code>${escapeHtml(b.team.name)}</code></span>` : ''}
          ${b.validated ? `<span class="bm-bot-badge ok">✔ ${t('bm.validated')}</span>` : `<span class="bm-bot-badge warn">⚠ ${t('bm.not_validated')}</span>`}
        </div>
        <div class="bm-bot-row">
          <span class="bm-bot-label">${t('bm.token')}:</span>
          ${hasToken
            ? `<code class="bm-token-val" data-hidden="1">${maskToken(b.token)}</code>
               <button class="bm-btn ghost xsmall bm-toggle-token" title="${t('bm.toggle')}">👁</button>
               <button class="bm-btn ghost xsmall bm-copy-token" title="${t('bm.copy')}">${icon('copy')}</button>`
            : `<code class="bm-token-val bm-token-missing">${t('bm.no_token') || 'no token stored'}</code>`}
          <button class="bm-btn warn xsmall bm-reset-token" title="${t('bm.reset_token_tip') || 'Reset & reveal a fresh token from Discord'}">${icon('refresh') || '↻'} ${hasToken ? (t('bm.reset_token') || 'Reset') : (t('bm.fetch_token') || 'Fetch token')}</button>
        </div>
        ${b.password ? `
        <div class="bm-bot-row">
          <span class="bm-bot-label">${t('bm.password')}:</span>
          <code>${escapeHtml(b.password)}</code>
          <button class="bm-btn ghost xsmall bm-copy-pw" title="${t('bm.copy')}">${icon('copy')}</button>
        </div>` : ''}
        <div class="bm-bot-foot">
          <span class="bm-bot-meta">${t('bm.owner')}: ${escapeHtml(b.createdBy || '—')} · ${new Date(b.createdAt).toLocaleString()}</span>
          <span class="bm-bot-actions">
            <button class="bm-btn ghost xsmall bm-del" title="${t('bm.delete_local_tip') || 'Remove from this library only'}">${icon('trash')} ${t('bm.delete_local') || t('bm.delete')}</button>
            <button class="bm-btn danger xsmall bm-del-discord" title="${t('bm.delete_discord_tip') || 'Permanently delete the Discord application'}">${icon('trash')} ${t('bm.delete_discord') || 'Delete from Discord'}</button>
          </span>
        </div>
      </div>
    `;
  }

  // ─── ACTIONS
  async startTask() {
    if (!this.account) { showNotification(t('bm.pick_account'), 'error'); return; }
    if (!this.form.namePattern.trim()) { showNotification(t('bm.need_pattern'), 'error'); return; }
    try {
      const pf = await window.electronAPI.botsPreflight(this.account);
      if (pf && pf.canStart === false) {
        const msg = (pf.blockers || []).map(b => `• ${b.message}`).join('\n') || t('bm.preflight_blocked');
        showNotification(msg, 'error');
        return;
      }
      const warns = (pf?.checks || []).filter(x => !x.ok);
      if (warns.length) {
        showNotification((t('bm.preflight_warnings') || 'Warnings') + ': ' + warns.map(w => w.message).join(' | '), 'warning');
      }
    } catch (e) {
      // non-fatal: still allow user to proceed manually
    }
    const ok = await showConfirm(t('bm.confirm_start').replace('{n}', this.form.count));
    if (!ok) return;
    sfx.click?.();
    try {
      const r = await window.electronAPI.botsCreate({
        account: this.account,
        count: this.form.count,
        namePattern: this.form.namePattern,
        avatarDataUrl: this.form.avatarDataUrl,
        bannerDataUrl: this.form.bannerDataUrl,
        cooldownMs: this.form.cooldownSec * 1000,
        accountPassword: this.form.accountPassword || ''
      });
      if (r?.success) {
        showNotification(t('bm.task_started'));
        this.task = r.task;
        this.renderProgress();
      } else {
        showNotification(r?.error || 'Failed to start', 'error');
      }
    } catch (e) {
      showNotification(e.message, 'error');
    }
  }

  async cancelTask() {
    try { await window.electronAPI.botsCancel(); showNotification(t('bm.cancelled')); } catch (e) { showNotification(e.message, 'error'); }
  }

  async submitCaptcha() {
    const inp = this.contentArea.querySelector('#bm-captcha-input');
    const v = (inp?.value || '').trim();
    if (!v) { showNotification(t('bm.captcha_empty'), 'error'); return; }
    const nonce = this._currentCaptchaNonce || this.task?.captcha?.nonce || '';
    try {
      const r = await window.electronAPI.botsSubmitCaptcha(v, nonce);
      if (r?.success) {
        showNotification(t('bm.captcha_submitted'));
        if (inp) inp.value = '';
      } else {
        showNotification(r?.error || 'Failed', 'error');
      }
    } catch (e) { showNotification(e.message, 'error'); }
  }

  async saveCaptchaKey(key, notify = true) {
    try {
      await window.electronAPI.botsSetConfig({ captcha2captchaKey: key });
      const cfg = await window.electronAPI.botsGetConfig();
      const wasSaved = this.config.has2captcha;
      this.config = cfg?.config || { has2captcha: false };
      if (notify) {
        showNotification(key ? t('bm.key_saved') : t('bm.key_cleared') || t('bm.key_saved'));
      } else if (this.config.has2captcha && !wasSaved) {
        // Subtle toast when first auto-saved
        showNotification(t('bm.key_auto_saved') || t('bm.key_saved'));
      }
      // Re-render only if status changed (avoid wiping the input the user is typing in)
      if (this.config.has2captcha !== wasSaved || !key) this.renderBody();
    } catch (e) { showNotification(e.message, 'error'); }
  }

  async deleteBot(bot) {
    const ok = await showConfirm(t('bm.confirm_delete').replace('{name}', bot.name));
    if (!ok) return;
    try {
      await window.electronAPI.botsDelete(bot.id);
      this.bots = this.bots.filter(b => b.id !== bot.id);
      this.renderLibrary();
      showNotification(t('bm.deleted'));
    } catch (e) { showNotification(e.message, 'error'); }
  }

  async deleteBotFromDiscord(bot) {
    const owner = bot.ownerAccount || bot.createdBy || '—';
    const msg = (t('bm.confirm_delete_discord') || 'Permanently delete "{name}" application from Discord using the {owner} account? This cannot be undone.')
      .replace('{name}', bot.name).replace('{owner}', owner);
    const ok = await showConfirm(msg);
    if (!ok) return;
    let pwd = '';
    try {
      pwd = window.prompt((t('bm.password_prompt') || 'Discord password for the {owner} account (leave blank if not required):').replace('{owner}', owner), '') || '';
    } catch (e) {}
    try {
      const r = await window.electronAPI.botsDeleteFromDiscord(bot.id, pwd);
      if (!r?.success) throw new Error(r?.error || 'Failed');
      this.bots = this.bots.filter(b => b.id !== bot.id);
      await this.refreshAll().catch(() => {});
      this.renderLibrary();
      showNotification(t('bm.deleted_from_discord') || 'Bot deleted from Discord and library');
    } catch (e) {
      showNotification(e.message || 'Failed', 'error');
    }
  }

  async resetBotToken(bot) {
    const owner = bot.ownerAccount || bot.createdBy || '—';
    const hasToken = !!bot.token;
    const confirmMsg = hasToken
      ? (t('bm.confirm_reset_token') || 'Reset token for "{name}"? The current token will stop working immediately.').replace('{name}', bot.name)
      : (t('bm.confirm_fetch_token') || 'Fetch a fresh token for "{name}"?').replace('{name}', bot.name);
    const ok = await showConfirm(confirmMsg);
    if (!ok) return;
    let pwd = '';
    try {
      pwd = window.prompt((t('bm.password_prompt') || 'Discord password for the {owner} account (leave blank if not required):').replace('{owner}', owner), '') || '';
    } catch (e) {}
    try {
      const r = await window.electronAPI.botsResetToken(bot.id, pwd);
      if (!r?.success) throw new Error(r?.error || 'Failed');
      bot.token = r.token;
      bot.validated = !!r.validated;
      this.renderLibrary();
      try { await copyToClipboard(r.token); showNotification(t('bm.token_reset_copied') || 'New token revealed and copied to clipboard'); }
      catch (e) { showNotification(t('bm.token_reset') || 'New token saved'); }
    } catch (e) {
      showNotification(e.message || 'Failed', 'error');
    }
  }
}

function escapeHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s = '') { return escapeHtml(s); }
function maskToken(tok = '') { if (!tok || tok.length < 12) return '••••••••'; return tok.slice(0, 6) + '•'.repeat(Math.max(8, tok.length - 12)) + tok.slice(-4); }
