import { checkForUpdates } from './utils/updates.js';
import { loadSavedTokens, saveToken } from './utils/tokenManager.js';
import { DMManager } from './components/DMManager.js';
import { ServerManager } from './components/ServerManager.js';
import { FriendsManager } from './components/FriendsManager.js';
import { GroupManager } from './components/GroupManager.js';
import { OldManager } from './components/OldManager.js';
import { MessagesManager } from './components/MessagesManager.js';
import { ReactionManager } from './components/ReactionManager.js';
import { TokensManager } from './components/TokensManager.js';
import { PrivateManager } from './components/PrivateManager.js';
import { StatsManager } from './components/StatsManager.js';
import { LookupManager } from './components/LookupManager.js';
import { CloneManager } from './components/CloneManager.js';
import { HistoryLogManager } from './components/HistoryLogManager.js';
import { TokenHealthManager } from './components/TokenHealthManager.js';
import { MentionsManager } from './components/MentionsManager.js';
import { PicManager } from './components/PicManager.js';
import { AntiPruneManager } from './components/AntiPruneManager.js';
import { SearchManager } from './components/SearchManager.js';
import { MassFriendManager } from './components/MassFriendManager.js';
import { BotsManager } from './components/BotsManager.js';
import { VoiceManager } from './components/VoiceManager.js';
import { mountTaskBar } from './utils/taskBar.js';
import { mountThemedSelect } from './utils/themedSelect.js';
import { showInfoModal, showTestPreview } from './utils/ui.js';
import { copyToClipboard } from './utils/clipboard.js';
import { getFriendsList } from './utils/discord.js';
import { applyLang, setLang, getLang, t } from './utils/i18n.js';
import { icon } from './utils/icons.js';
import { sfx } from './utils/sounds.js';
import { mountFeaturesMenu } from './utils/featuresMenu.js';

window.t = t;
window.showTestPreview = showTestPreview;

// ── Theme toggle ──
const ICON_MOON = icon('moon');
const ICON_SUN  = icon('sun');

(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') document.body.classList.add('light-theme');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = saved === 'light' ? ICON_SUN : ICON_MOON;
})();

document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
  const isLight = document.body.classList.toggle('light-theme');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = isLight ? ICON_SUN : ICON_MOON;
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
});

// ── Language toggle ──
applyLang();
document.getElementById('langToggleBtn')?.addEventListener('click', () => {
  setLang(getLang() === 'ar' ? 'en' : 'ar');
});

// ── Auth controls (logout + change password) ──
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.href = '/login';
});

// ── Populate header user chip from /api/me ──────────────────────
// Shows the current user's username + Discord avatar (if linked).
(async function loadMe() {
  try {
    const r = await fetch('/api/me').then(x => x.json());
    if (!r?.success || !r.user) return;
    const me = r.user;
    const chip = document.getElementById('headerUser');
    const img  = document.getElementById('headerUserAvatar');
    const nm   = document.getElementById('headerUserName');
    if (!chip) return;
    nm.textContent = me.username || 'user';
    if (me.discord?.id) {
      img.src = me.discord.avatar
        ? `https://cdn.discordapp.com/avatars/${me.discord.id}/${me.discord.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(me.discord.id) >> 22n) % 6n}.png`;
    } else {
      // Fallback initial-avatar SVG
      const init = (me.username || '?')[0].toUpperCase();
      img.src = `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='32' fill='#5865F2'/><text x='50%' y='54%' text-anchor='middle' font-family='-apple-system,sans-serif' font-size='30' font-weight='600' fill='#fff' dominant-baseline='middle'>${init}</text></svg>`
      )}`;
    }
    chip.hidden = false;
    window._currentUser = me;
  } catch {}
})();

document.getElementById('changePwBtn')?.addEventListener('click', async () => {
  const oldPw = window.prompt('Current password');
  if (!oldPw) return;
  const newPw = window.prompt('New password (min 6 chars)');
  if (!newPw || newPw.length < 6) return;
  const newPw2 = window.prompt('Confirm new password');
  if (newPw !== newPw2) { alert('Passwords do not match'); return; }
  try {
    const r = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    }).then(x => x.json());
    if (!r.success) throw new Error(r.error || 'Failed');
    alert('Password changed.');
  } catch (e) { alert('Failed: ' + e.message); }
});

// ── One-time self-bot warning banner (dismissible) ──
(function initSelfBotWarning() {
  if (localStorage.getItem('sb-warn-dismissed') === '1') return;
  const banner = document.createElement('div');
  banner.id = 'sb-warning';
  banner.innerHTML = `
    <span style="display:inline-flex;align-items:center;gap:8px">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span>Self-bot use violates Discord's Terms of Service. Your accounts may be banned.</span>
    </span>
    <button aria-label="Dismiss" id="sb-warning-x">×</button>`;
  Object.assign(banner.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '99999',
    padding: '8px 16px', background: 'linear-gradient(90deg,#7c2d12,#9a3412)',
    color: '#fff', fontSize: '12.5px', fontWeight: '500',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    boxShadow: '0 2px 12px rgba(0,0,0,.4)',
  });
  const xBtn = banner.querySelector('#sb-warning-x');
  Object.assign(xBtn.style, {
    background: 'transparent', border: '0', color: '#fff', fontSize: '20px',
    cursor: 'pointer', padding: '0 8px', lineHeight: '1',
  });
  xBtn.addEventListener('click', () => {
    banner.remove();
    localStorage.setItem('sb-warn-dismissed', '1');
  });
  document.body.insertBefore(banner, document.body.firstChild);
})();

// ── Mobile nav drawer ──
(function initNavToggle() {
  const sidebar = document.getElementById('navSidebar');
  const backdrop = document.getElementById('navBackdrop');
  const toggle = document.getElementById('navToggleBtn');
  const close = () => { sidebar?.classList.remove('open'); backdrop?.classList.remove('show'); };
  toggle?.addEventListener('click', () => {
    const open = sidebar?.classList.toggle('open');
    backdrop?.classList.toggle('show', !!open);
  });
  backdrop?.addEventListener('click', close);
  document.addEventListener('click', (e) => {
    if (e.target.closest('.nav-item') && window.innerWidth <= 880) close();
  });
})();

// Discord-style default avatar (used for Test mode)
const DISCORD_DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="32" fill="#5865F2"/>
  <path fill="#fff" d="M44.6 19.5c-2.3-1-4.7-1.8-7.3-2.2-.3.6-.7 1.4-1 2-2.7-.4-5.4-.4-8 0-.3-.6-.7-1.4-1-2-2.5.5-5 1.3-7.3 2.3-4.6 6.9-5.8 13.6-5.2 20.2 3.1 2.3 6 3.7 8.9 4.6.7-1 1.4-2 1.9-3.1-1.1-.4-2.1-.9-3.1-1.5.3-.2.5-.4.8-.6 5.9 2.7 12.4 2.7 18.3 0 .3.2.5.4.8.6-1 .6-2 1.1-3.1 1.5.6 1.1 1.2 2.1 1.9 3.1 2.9-.9 5.8-2.3 8.9-4.6.7-7.7-1.2-14.3-5.2-20.2zM25.4 36.1c-1.8 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.3 1.6 3.2 3.6c0 2-1.4 3.6-3.2 3.6zm13.1 0c-1.8 0-3.2-1.6-3.2-3.6s1.4-3.6 3.2-3.6 3.3 1.6 3.2 3.6c0 2-1.4 3.6-3.2 3.6z"/>
</svg>`)}`;

window._discordDefaultAvatar = DISCORD_DEFAULT_AVATAR;

window.dmManager       = new DMManager(document.getElementById('dms-page'));
window.serverManager   = new ServerManager(document.getElementById('servers-page'));
window.friendsManager  = new FriendsManager(document.getElementById('friends-page'));
window.groupManager    = new GroupManager(document.getElementById('groups-page'));
window.oldManager      = new OldManager(document.getElementById('history-page'));
window.messagesManager = new MessagesManager(document.getElementById('messages-page'));
window.reactionManager = new ReactionManager(document.getElementById('reactions-page'));
window.tokensManager   = new TokensManager(document.getElementById('tokens-page'));
window.privateManager  = new PrivateManager(document.getElementById('private-page'));
window.statsManager    = new StatsManager(document.getElementById('stats-page'));
window.lookupManager   = new LookupManager(document.getElementById('lookup-page'));
window.cloneManager    = new CloneManager(document.getElementById('clone-page'));
window.historyLogManager = new HistoryLogManager(document.getElementById('historylog-page'));
window.tokenHealthManager = new TokenHealthManager(document.getElementById('tokenhealth-page'));
window.mentionsManager  = new MentionsManager(document.getElementById('mentions-page'));
window.picManager       = new PicManager(document.getElementById('pic-page'));
window.antiPruneManager = new AntiPruneManager(document.getElementById('antiprune-page'));
window.searchManager    = new SearchManager(document.getElementById('search-page'));
window.massFriendManager = new MassFriendManager(document.getElementById('massfriend-page'));
window.botsManager      = new BotsManager(document.getElementById('bots-page'));
window.voiceManager     = new VoiceManager(document.getElementById('voice-page'));

// Mount the top-right features hamburger dropdown
mountFeaturesMenu(document.querySelector('.window-controls'));

// Global background-task progress bar at the bottom of the screen
mountTaskBar();

// Replace native dropdowns with our themed animated dropdown.
mountThemedSelect();

// Floating bottom-right hamburger shortcut to the support server
(function mountSupportFab() {
  const fab = document.createElement('a');
  fab.id = 'supportFab';
  fab.className = 'support-fab';
  fab.href = 'https://discord.gg/ens';
  fab.target = '_blank';
  fab.rel = 'noopener';
  fab.title = t('lg.support_title');
  fab.innerHTML = `
    <span class="sf-burger"><span></span><span></span><span></span></span>
    <span class="sf-tooltip">${t('lg.support_title')}</span>
  `;
  document.body.appendChild(fab);
})();

// Listen for navigation requests from the dropdown
window.addEventListener('feature-nav', (ev) => {
  const map = {
    historylog:  'historylog',
    tokenhealth: 'tokenhealth',
    mentions:    'mentions',
    pic:         'pic',
    antiprune:   'antiprune',
    search:      'search',
    massfriend:  'massfriend',
    clone:       'clone',
    stats:       'stats',
    voice:       'voice',
  };
  const page = map[ev.detail];
  if (page) switchPage(page);
});

window.copyToClipboard = copyToClipboard;
window.getFriendsList = getFriendsList;

// Copy message link with animated feedback
window.copyMessageLink = async (btn, link) => {
  try {
    await navigator.clipboard.writeText(link);
    btn.classList.add('copied');
    const lbl = btn.querySelector('.om-copy-link-text');
    const orig = lbl ? lbl.textContent : '';
    if (lbl) lbl.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      if (lbl) lbl.textContent = orig;
    }, 1400);
  } catch (e) {
    console.error('Failed to copy link:', e);
  }
};

const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page-container');
const userProfile = document.getElementById('userProfile');
const loginNavItem = document.getElementById('loginNavItem');

function showUserProfile(username, avatar) {
  const userInitial = document.getElementById('userInitial');
  const userName = document.getElementById('userName');
  const userAvatarImg = document.getElementById('userAvatarImg');
  const userAvatarBox = document.getElementById('userAvatar');

  userName.textContent = username;
  if (avatar) {
    userAvatarImg.src = avatar;
    userAvatarImg.style.display = 'block';
    userAvatarBox.style.display = 'none';
  } else {
    userInitial.textContent = (username || '?').charAt(0).toUpperCase();
    userAvatarImg.style.display = 'none';
    userAvatarBox.style.display = 'flex';
  }
  userProfile.classList.add('visible');
}

function hideUserProfile() {
  userProfile.classList.remove('visible');
}

function toggleNavItems(show) {
  document.querySelectorAll('.nav-item:not(#loginNavItem)').forEach(item => {
    item.classList.toggle('hidden', !show);
  });
  loginNavItem.classList.toggle('hidden', show);
  // Hide the burger features menu when not logged in.
  const fm = document.getElementById('featuresMenuBtn');
  if (fm) fm.classList.toggle('hidden', !show);
  // Hide the support FAB too — it's a feature shortcut.
  const fab = document.getElementById('supportFab');
  if (fab) fab.style.display = show ? '' : 'none';
}

function switchPage(pageId) {
  pages.forEach(page => {
    page.classList.remove('active');
    if (page.id === `${pageId}-page`) {
      setTimeout(() => page.classList.add('active'), 50);
    }
  });

  navItems.forEach(item => {
    item.classList.remove('active');
    if (item.dataset.page === pageId) item.classList.add('active');
  });

  switch (pageId) {
    case 'friends':   window.friendsManager.refreshFriendsList();   break;
    case 'servers':   window.serverManager.refreshServersList();    break;
    case 'dms':       window.dmManager.refreshDMsList();            break;
    case 'groups':    window.groupManager.refreshGroupsList();      break;
    case 'history':   window.oldManager.init();                      break;
    case 'messages':  window.messagesManager.init();                 break;
    case 'reactions': window.reactionManager.init();                 break;
    case 'tokens':    window.tokensManager.init();                   break;
    case 'private':   window.privateManager.init();                  break;
    case 'stats':     window.statsManager.init();                    break;
    case 'lookup':    window.lookupManager.init();                   break;
    case 'clone':       window.cloneManager.init();                  break;
    case 'historylog':  window.historyLogManager.init();             break;
    case 'tokenhealth': window.tokenHealthManager.init();            break;
    case 'mentions':    window.mentionsManager.init();               break;
    case 'pic':         window.picManager.init();                    break;
    case 'antiprune':   window.antiPruneManager.init();              break;
    case 'search':      window.searchManager.init();                  break;
    case 'massfriend':  window.massFriendManager.init();              break;
    case 'bots':        window.botsManager.init();                    break;
    case 'voice':       window.voiceManager.init();                   break;
  }
}

toggleNavItems(false);
switchPage('login');

navItems.forEach(item => {
  item.addEventListener('click', () => switchPage(item.dataset.page));
});

window.addEventListener('active-client-changed', () => {
  // Re-load some panels lazily on active switch
});

// When a saved token is "Use"-d, finalize the login UI without going through
// the connect button (which used to create a duplicate auto-named client).
window.addEventListener('saved-token-connected', async (ev) => {
  try {
    const info = ev.detail?.info || {};
    const username = info.username || ev.detail?.name || 'Account';
    const avatar = info.avatar || null;
    showUserProfile(username, avatar);
    toggleNavItems(true);
    switchPage('tokens');
    await loadSavedTokens();
  } catch (e) { console.error(e); }
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await checkForUpdates();
    await loadSavedTokens();
  } catch (e) { console.error('Init error:', e); }
});

document.getElementById('minimizeBtn').addEventListener('click', () => {});
document.getElementById('maximizeBtn').addEventListener('click', () => {});
document.getElementById('closeBtn').addEventListener('click', () => {});
document.getElementById('infoBtn').addEventListener('click', showInfoModal);
document.getElementById('saveTokenBtn').addEventListener('click', () => saveToken(tokenInput.value, status));

document.getElementById('disconnectBtn').addEventListener('click', async () => {
  try { await window.electronAPI.disconnect(); } catch (e) {}
  hideUserProfile();
  toggleNavItems(false);
  switchPage('login');
  tokenInput.value = '';
  status.textContent = '';
});

const connectBtn = document.getElementById('connectBtn');
const tokenInput = document.getElementById('tokenInput');
const status = document.getElementById('status');

connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value;
  if (!token) {
    status.textContent = 'Please enter a token';
    status.className = 'error';
    return;
  }

  const btnText = connectBtn.querySelector('.btn-text');
  const loader = connectBtn.querySelector('.loader');
  btnText.style.display = 'none';
  loader.style.display = 'inline-block';
  connectBtn.disabled = true;

  if (token.toLowerCase() === 'test') {
    window._testMode = true;
    status.textContent = 'Connected as Ahmed (Test)';
    status.className = 'success';
    showUserProfile('Ahmed (Test)', DISCORD_DEFAULT_AVATAR);
    toggleNavItems(true);
    switchPage('tokens');
    btnText.style.display = 'inline-block';
    loader.style.display = 'none';
    connectBtn.disabled = false;
    return;
  }

  window._testMode = false;

  try {
    const result = await window.electronAPI.connectDiscord(token);
    if (result.success) {
      status.textContent = `Connected as ${result.username}`;
      status.className = 'success';
      // Try to fetch avatar from clients list
      let avatar = null;
      try {
        const cl = await window.electronAPI.listClients();
        const me = cl.success ? cl.clients.find(c => c.active) : null;
        avatar = me?.avatar || null;
      } catch (e) {}
      showUserProfile(result.username, avatar);
      toggleNavItems(true);
      switchPage('tokens');
    } else {
      status.textContent = result.error;
      status.className = 'error';
    }
  } catch (error) {
    status.textContent = 'Connection failed';
    status.className = 'error';
  } finally {
    btnText.style.display = 'inline-block';
    loader.style.display = 'none';
    connectBtn.disabled = false;
  }
});
