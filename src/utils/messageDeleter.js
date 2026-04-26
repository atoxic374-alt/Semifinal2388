import { ProgressBar } from '../components/ProgressBar.js';

/**
 * Optimized message deleter:
 *  - Parallel collection from multiple pages (up to a safe concurrency)
 *  - Concurrent deletion with adaptive throttling
 *  - Smart rate-limit handling (respects retry-after; backs off globally)
 *  - Cancellable
 */
export async function deleteDMMessages({
  channelId,
  username,
  electronAPI,
  onComplete = () => {},
  skipRefresh = false,
  isGroup = false,
  oldestFirst = false,
  concurrency = 3
}) {
  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'modal-overlay';
  modalOverlay.innerHTML = `
    <div class="modal-content">
      <h2>Deleting messages ${isGroup ? 'in' : 'with'} ${username}</h2>
      <div id="progressContainer">
        <div class="message-counter">
          <span id="deletedCount">0</span> / <span id="totalCount">collecting…</span> messages
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalOverlay);

  const progressBar = new ProgressBar('progressContainer', { showCancelButton: true });
  progressBar.create();
  progressBar.show();

  let shouldStop = false;
  progressBar.onCancel(() => {
    shouldStop = true;
    progressBar.setCancelButtonText('Cancelling…');
    progressBar.disableCancelButton();
  });

  const totalEl = () => document.getElementById('totalCount');
  const dEl = () => document.getElementById('deletedCount');

  try {
    let lastMessageId = null;
    let hasMore = true;
    let currentUserId = null;
    const deletable = [];

    // Fast collection loop (sequential — Discord requires ordered pagination)
    while (hasMore && !shouldStop) {
      const result = isGroup
        ? await electronAPI.getGroupMessages(channelId, lastMessageId)
        : await electronAPI.getDMMessages(channelId, lastMessageId);

      if (!result.success || !result.messages?.length) { hasMore = false; break; }
      if (!currentUserId && result.currentUserId) currentUserId = result.currentUserId;

      const messages = result.messages;
      for (const msg of messages) {
        if (isGroup) {
          if (msg.author?.id !== currentUserId) continue;
          deletable.push(msg);
        } else if (msg.isDeletable) {
          deletable.push(msg);
        }
      }
      if (totalEl()) totalEl().textContent = String(deletable.length);

      hasMore = messages.length === 100;
      lastMessageId = messages[messages.length - 1].id;
      // tiny breather to be nice to API
      await sleep(120);
    }

    if (shouldStop) throw new Error('Operation cancelled');
    if (!deletable.length) throw new Error('No messages to delete');

    if (oldestFirst) deletable.reverse();

    if (totalEl()) totalEl().textContent = String(deletable.length);

    // Concurrent deletion with adaptive throttle
    let deleted = 0;
    let globalCooldownUntil = 0;

    const deleteOne = async (msg) => {
      if (shouldStop) return;
      // global cooldown
      const wait = globalCooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);

      try {
        if (isGroup) await electronAPI.deleteGroupMessage(channelId, msg.id);
        else         await electronAPI.deleteDMMessage(channelId, msg.id);
        deleted++;
        if (dEl()) dEl().textContent = String(deleted);
        progressBar.update((deleted / deletable.length) * 100);
      } catch (err) {
        // Server returns { success: false, error: '...' } — try to detect rate-limit text
        const msgErr = String(err?.message || err);
        if (msgErr.includes('429') || /rate[- ]?limit/i.test(msgErr)) {
          globalCooldownUntil = Date.now() + 4000;
          await sleep(4000);
          try {
            if (isGroup) await electronAPI.deleteGroupMessage(channelId, msg.id);
            else         await electronAPI.deleteDMMessage(channelId, msg.id);
            deleted++;
            if (dEl()) dEl().textContent = String(deleted);
            progressBar.update((deleted / deletable.length) * 100);
          } catch (e) { /* skip */ }
        }
      }
    };

    // Worker pool
    const queue = deletable.slice();
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length && !shouldStop) {
        const m = queue.shift();
        if (!m) break;
        await deleteOne(m);
        // small jitter between calls per worker
        await sleep(200 + Math.floor(Math.random() * 200));
      }
    });
    await Promise.all(workers);

    if (!shouldStop) progressBar.update(100);
  } catch (error) {
    console.error('Delete error:', error);
    const c = document.getElementById('progressContainer');
    if (c) c.innerHTML = `<p class="error">${error.message}</p>`;
  } finally {
    setTimeout(() => { modalOverlay.remove(); onComplete(); }, 800);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
