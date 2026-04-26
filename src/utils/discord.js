// Utility functions for Discord operations
export const getFriendsList = async (account) => {
  const result = await window.electronAPI.getFriends(account ? { account } : {});
  if (!result.success) throw new Error(result.error);
  return result.friends || [];
};

export const getServersList = async (account) => {
  const result = await window.electronAPI.getServers(account ? { account } : {});
  if (!result.success) throw new Error(result.error);
  return result.servers || [];
};

export const getDMsList = async (account, botsOnly = false) => {
  const opts = {};
  if (account)  opts.account = account;
  if (botsOnly) opts.botsOnly = true;
  const result = await window.electronAPI.getDMs(opts);
  if (!result.success) throw new Error(result.error);
  return result.dms || [];
};

export const getGroupsList = async (account) => {
  const result = await window.electronAPI.getGroups(account ? { account } : {});
  if (!result.success) throw new Error(result.error);
  return result.groups || [];
};

export const listClientsList = async () => {
  const result = await window.electronAPI.listClients();
  if (!result.success) return { clients: [], active: null };
  return { clients: result.clients || [], active: result.active || null };
};

export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    showNotification('Copied to clipboard!');
  } catch (error) {
    console.error('Failed to copy:', error);
  }
};

export const showNotification = (message) => {
  const notification = document.createElement('div');
  notification.className = 'copy-notification';
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 2000);
};