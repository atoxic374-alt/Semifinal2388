import { showInputModal, showToast, pulseButton, showConfirm, showNotification } from './ui.js';
import { updateTokensList } from './domManager.js';
import { t } from './i18n.js';

export async function loadSavedTokens() {
    try {
        const result = await window.electronAPI.getTokens();
        if (!result.success) {
            console.error('Failed to load tokens:', result.error);
            return;
        }

        const tokenManagement = document.getElementById('tokenManagement');
        if (!result.tokens.length) {
            tokenManagement.innerHTML = '<p class="text-muted">No saved tokens</p>';
            return;
        }

        updateTokensList(result.tokens, {
            // "Use" no longer pipes through the connect button (which was creating
            // a second client with an auto-generated name). Instead:
            //   1. If this token is already connected (by name), just switch active.
            //   2. Otherwise call the saved-token connect endpoint, which reuses
            //      the saved name — preventing duplicate sessions.
            useToken: async (token, name) => {
                try {
                    const cl = await window.electronAPI.listClients();
                    const already = cl?.success && (cl.clients || []).find(c => c.name === name);
                    if (already) {
                        await window.electronAPI.setActiveClient(name);
                        showToast(`Switched to "${name}"`, 'success');
                    } else {
                        const r = await window.electronAPI.connectSaved(name);
                        if (!r.success) throw new Error(r.error || 'Connect failed');
                        await window.electronAPI.setActiveClient(name);
                        showToast(`Connected "${name}"`, 'success');
                    }
                    // Reflect the connected state in the UI by simulating the
                    // post-connect flow without creating a duplicate.
                    document.getElementById('tokenInput').value = '';
                    const cl2 = await window.electronAPI.listClients();
                    const me = cl2.success ? (cl2.clients || []).find(c => c.name === name) : null;
                    window.dispatchEvent(new CustomEvent('saved-token-connected', { detail: { name, info: me } }));
                } catch (e) {
                    showToast(e.message || 'Connect failed', 'error');
                }
            },
            deleteToken: async (name) => {
                const ok = await showConfirm(`Delete "${name}"?`);
                if (!ok) return;
                const result = await window.electronAPI.deleteToken(name);
                if (result.success) {
                    showToast(`Deleted "${name}"`, 'success');
                    loadSavedTokens();
                } else {
                    showToast(result.error || t('common.save_fail'), 'error');
                }
            }
        });
    } catch (error) {
        console.error('Failed to load tokens:', error);
    }
}

export async function saveToken(token, status) {
    if (!token) {
        if (status) { status.textContent = 'Please enter a token'; status.className = 'error'; }
        showToast('Please enter a token first', 'error');
        return;
    }

    const ok = await showConfirm(t('app.confirm_save'), {
        confirmText: t('common.save') || 'Save',
        cancelText:  t('common.cancel') || 'Cancel',
    });
    if (!ok) return;

    const name = await showInputModal(t('app.save_token_title'), t('app.save_token_msg'));
    if (!name) return;

    const btn = document.getElementById('saveTokenBtn');
    try {
        await pulseButton(btn, async () => {
            const result = await window.electronAPI.saveToken(name, token);
            if (!result.success) throw new Error(result.error || 'Failed');
            return result;
        });
        if (status) { status.textContent = t('app.save_ok'); status.className = 'success'; }
        showToast(t('app.save_ok'), 'success');
        await loadSavedTokens();
    } catch (error) {
        if (status) { status.textContent = error.message || t('app.save_fail'); status.className = 'error'; }
        showToast(error.message || t('app.save_fail'), 'error');
    }
}
