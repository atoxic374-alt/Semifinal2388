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
      const [list, status, cfg] = await Promise.all([
        window.electronAPI.botsList(),
        window.electronAPI.botsStatus(),
        window.electronAPI.botsGetConfig()
      ]);
      this.bots = list?.bots || [];
      this.task = status?.task || { state: 'idle' };
      this.config = cfg?.config || { has2captcha: false };
    } catch (e) {
      showNotification('Failed to load bots: ' + e.message, 'error');
    }
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
            showNotification(`${t('bm.failed_for')} ${data.name}: ${data.error}`, 'error');
          }
          if (data.type === 'bot_captcha') {
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
      b.addEventListener('click', () => { this.tab = b.dataset.tab; sfx.click?.(); this.renderBody(); this.contentArea.querySelectorAll('.bm-tab').forEach(x => x.classList.toggle('active', x === b)); });
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
    const captchaPanel = t1.waitingCaptcha ? `
      <div class="bm-captcha">
        <div class="bm-captcha-msg">${icon('shield')} ${t('bm.captcha_panel_msg')}</div>
        <div class="bm-captcha-meta">sitekey: <code>${escapeHtml(t1.captcha?.sitekey || '')}</code> · service: <code>${escapeHtml(t1.captcha?.service || 'hcaptcha')}</code></div>
        <div class="bm-captcha-row">
          <input type="text" id="bm-captcha-input" placeholder="${t('bm.captcha_placeholder')}" />
          <button class="bm-btn primary" id="bm-captcha-submit">${icon('check')} ${t('bm.submit')}</button>
        </div>
        <div class="bm-captcha-hint">${t('bm.captcha_hint')}</div>
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
    const sub = wrap.querySelector('#bm-captcha-submit');
    if (sub) sub.addEventListener('click', () => this.submitCaptcha());
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
            <label>${t('bm.password')}</label>
            <input type="password" id="bm-account-password" value="${escapeAttr(this.form.accountPassword || '')}" placeholder="${t('bm.password')} (optional)" autocomplete="off" />
            <span class="bm-hint">Used only when Discord requires password confirmation for app/bot actions.</span>
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
    picker.bind(body, (name) => { this.account = name || null; });
    body.querySelector('#bm-name').addEventListener('input', e => this.form.namePattern = e.target.value);
    body.querySelector('#bm-count').addEventListener('input', e => this.form.count = Math.max(1, Math.min(50, parseInt(e.target.value || '1') || 1)));
    body.querySelector('#bm-account-password')?.addEventListener('input', e => this.form.accountPassword = e.target.value || '');
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
    if (!this.bots.length) {
      body.innerHTML = `
        <div class="bm-empty">
          <div class="bm-empty-icon">${icon('users')}</div>
          <div>${t('bm.empty_title')}</div>
          <div class="bm-hint">${t('bm.empty_hint')}</div>
        </div>
      `;
      return;
    }
    const sorted = this.bots.slice().sort((a, b) => a.number - b.number);
    body.innerHTML = `
      <div class="bm-lib-head">
        <div class="bm-lib-count">${sorted.length} ${t('bm.bots')}</div>
        <div class="bm-lib-actions">
          <a class="bm-btn primary" href="${window.electronAPI.botsAllTokensUrl('text')}" download>${icon('download')} ${t('bm.export_all')}</a>
          <a class="bm-btn ghost" href="${window.electronAPI.botsAllTokensUrl('json')}" download>${icon('download')} JSON</a>
          <button class="bm-btn ghost" id="bm-copy-all">${icon('copy')} ${t('bm.copy_all')}</button>
        </div>
      </div>
      <div class="bm-list">
        ${sorted.map(b => this.botCardHtml(b)).join('')}
      </div>
    `;
    body.querySelector('#bm-copy-all').addEventListener('click', async () => {
      const text = sorted.map(b => `${String(b.number).padStart(3, '0')}\t${b.name}\t${b.token}\t${b.password || ''}`).join('\n');
      await copyToClipboard(text);
      showNotification(t('bm.copied_all'));
    });
    body.querySelectorAll('.bm-card-bot').forEach(card => {
      const id = card.dataset.id;
      const bot = sorted.find(x => x.id === id);
      card.querySelector('.bm-copy-token').addEventListener('click', async () => { await copyToClipboard(bot.token); showNotification(t('bm.copied_token')); });
      card.querySelector('.bm-copy-pw')?.addEventListener('click', async () => { await copyToClipboard(bot.password); showNotification(t('bm.copied_pw')); });
      card.querySelector('.bm-toggle-token').addEventListener('click', () => {
        const span = card.querySelector('.bm-token-val');
        const hidden = span.dataset.hidden === '1';
        span.textContent = hidden ? bot.token : maskToken(bot.token);
        span.dataset.hidden = hidden ? '0' : '1';
      });
      card.querySelector('.bm-del').addEventListener('click', () => this.deleteBot(bot));
    });
  }

  botCardHtml(b) {
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
          <code class="bm-token-val" data-hidden="1">${maskToken(b.token)}</code>
          <button class="bm-btn ghost xsmall bm-toggle-token" title="${t('bm.toggle')}">👁</button>
          <button class="bm-btn ghost xsmall bm-copy-token" title="${t('bm.copy')}">${icon('copy')}</button>
        </div>
        ${b.password ? `
        <div class="bm-bot-row">
          <span class="bm-bot-label">${t('bm.password')}:</span>
          <code>${escapeHtml(b.password)}</code>
          <button class="bm-btn ghost xsmall bm-copy-pw" title="${t('bm.copy')}">${icon('copy')}</button>
        </div>` : ''}
        <div class="bm-bot-foot">
          <span class="bm-bot-meta">${t('bm.owner')}: ${escapeHtml(b.createdBy || '—')} · ${new Date(b.createdAt).toLocaleString()}</span>
          <button class="bm-btn danger xsmall bm-del">${icon('trash')} ${t('bm.delete')}</button>
        </div>
      </div>
    `;
  }

  // ─── ACTIONS
  async startTask() {
    if (!this.account) { showNotification(t('bm.pick_account'), 'error'); return; }
    if (!this.form.namePattern.trim()) { showNotification(t('bm.need_pattern'), 'error'); return; }
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
    try {
      const r = await window.electronAPI.botsSubmitCaptcha(v);
      if (r?.success) { showNotification(t('bm.captcha_submitted')); }
      else showNotification(r?.error || 'Failed', 'error');
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
}

function escapeHtml(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s = '') { return escapeHtml(s); }
function maskToken(tok = '') { if (!tok || tok.length < 12) return '••••••••'; return tok.slice(0, 6) + '•'.repeat(Math.max(8, tok.length - 12)) + tok.slice(-4); }
