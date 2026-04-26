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
