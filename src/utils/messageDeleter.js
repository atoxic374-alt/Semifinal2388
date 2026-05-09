import { ProgressBar } from '../components/ProgressBar.js';
import { openOperationLog } from './operationLog.js';
import { t } from './i18n.js';

// Module-scope shared cooldown so concurrent delete sessions across
// different channels respect the same rate-limit signal. Previously each
// invocation had its own `globalCooldownUntil`, so opening two delete
// modals at once would hammer Discord with ~6 parallel deletes.
let _moduleCooldownUntil = 0;

/**
 * Optimized message deleter:
 *  - Parallel collection from multiple pages (up to a safe concurrency)
 *  - Concurrent deletion with adaptive throttling
 *  - Smart rate-limit handling (respects retry-after; backs off globally
 *    AND module-globally — see _moduleCooldownUntil above)
 *  - Cancellable
 *  - Optional `opLog`: when provided, all step events are reported there
 *    instead of (or in addition to) the legacy modal. Pass `useLegacyModal:false`
 *    to skip building the legacy modal entirely.
 *
 *  Returns a result object: { deleted, total, failed, cancelled }
 */
export async function deleteDMMessages({
  channelId,
  username,
  electronAPI,
  onComplete = () => {},
  skipRefresh = false,
  isGroup = false,
  oldestFirst = false,
  concurrency = 3,
  opLog = null,
  useLegacyModal = true,
  preFetchedMessages = null,
}) {
  let modalOverlay = null;
  let progressBar = null;
  let ownsLog = false;
  if (!opLog) {
    ownsLog = true;
    opLog = openOperationLog({
      title: (t('dm.op_delete_title') || 'Deleting messages'),
      context: (t('dm.op_with') || 'with @{name}').replace('{name}', username || ''),
      total: null,
    });
  }

  if (useLegacyModal) {
    modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    modalOverlay.style.zIndex = '9400';
    modalOverlay.innerHTML = `
      <div class="modal-content">
        <h2>Deleting messages ${isGroup ? 'in' : 'with'} ${username || ''}</h2>
        <div id="progressContainer">
          <div class="message-counter">
            <span id="deletedCount">0</span> / <span id="totalCount">collecting…</span> messages
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modalOverlay);
    progressBar = new ProgressBar('progressContainer', { showCancelButton: true });
    progressBar.create();
    progressBar.show();
  }

  let shouldStop = false;
  const requestCancel = () => {
    if (shouldStop) return;
    shouldStop = true;
    if (progressBar) {
      progressBar.setCancelButtonText('Cancelling…');
      progressBar.disableCancelButton();
    }
  };
  if (progressBar) progressBar.onCancel(requestCancel);
  opLog.onCancel(requestCancel);

  const totalEl = () => modalOverlay ? document.getElementById('totalCount') : null;
  const dEl = () => modalOverlay ? document.getElementById('deletedCount') : null;

  const result = { deleted: 0, total: 0, failed: 0, cancelled: false };

  try {
    let lastMessageId = null;
    let hasMore = true;
    let currentUserId = null;
    const deletable = [];

    const fetchKey = `fetch:${channelId}`;
    opLog.start(fetchKey, {
      title: t('dm.op_collecting') || 'Collecting messages…',
      context: (t('dm.op_with') || 'with @{name}').replace('{name}', username || ''),
    });

    if (preFetchedMessages && preFetchedMessages.length > 0) {
      // Skip the collection loop — messages were already gathered in the preview modal
      deletable.push(...preFetchedMessages);
      if (totalEl()) totalEl().textContent = String(deletable.length);
    } else {
      // Fast collection loop (sequential — Discord requires ordered pagination)
      while (hasMore && !shouldStop) {
        const result0 = isGroup
          ? await electronAPI.getGroupMessages(channelId, lastMessageId)
          : await electronAPI.getDMMessages(channelId, lastMessageId);

        if (!result0.success || !result0.messages?.length) { hasMore = false; break; }
        if (!currentUserId && result0.currentUserId) currentUserId = result0.currentUserId;

        const messages = result0.messages;
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
        await sleep(120);
      }
    }

    if (shouldStop) {
      opLog.fail(fetchKey, { error: t('dm.op_cancelled') || 'Cancelled by user' });
      throw new Error('Operation cancelled');
    }
    if (!deletable.length) {
      opLog.fail(fetchKey, { error: t('dm.op_no_messages') || 'No deletable messages found' });
      throw new Error('No messages to delete');
    }
    opLog.success(fetchKey, {
      detail: (t('dm.op_collected') || 'Found {n} deletable messages').replace('{n}', deletable.length),
    });
    opLog.setTotal(deletable.length);
    result.total = deletable.length;

    if (oldestFirst) deletable.reverse();

    if (totalEl()) totalEl().textContent = String(deletable.length);

    // Concurrent deletion with adaptive throttle
    let deleted = 0;

    const deleteOne = async (msg) => {
      if (shouldStop) return;
      const stepKey = `del:${channelId}:${msg.id}`;
      // Honor BOTH the per-session and the module-global cooldown — covers
      // the case where a 429 was triggered by another open delete modal.
      const wait = _moduleCooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);

      opLog.start(stepKey, {
        title: t('dm.op_deleting_one') || 'Deleting message',
        context: `id ${msg.id}`,
      });

      try {
        if (isGroup) await electronAPI.deleteGroupMessage(channelId, msg.id);
        else         await electronAPI.deleteDMMessage(channelId, msg.id);
        deleted++;
        result.deleted = deleted;
        if (dEl()) dEl().textContent = String(deleted);
        if (progressBar) progressBar.update((deleted / deletable.length) * 100);
        opLog.success(stepKey, {
          title: t('dm.op_deleted_one') || 'Message deleted',
          detail: `id ${msg.id}`,
        });
      } catch (err) {
        // Server returns { success: false, error: '...' } — try to detect rate-limit text
        const msgErr = String(err?.message || err);
        if (msgErr.includes('429') || /rate[- ]?limit/i.test(msgErr)) {
          // Try to extract retry-after if the server included it; otherwise back off 4s.
          const m = msgErr.match(/retry[\-_ ]?after[":\s]+(\d+(?:\.\d+)?)/i);
          const backoffMs = m ? Math.min(15000, Math.ceil(parseFloat(m[1]) * 1000) + 500) : 4000;
          _moduleCooldownUntil = Math.max(_moduleCooldownUntil, Date.now() + backoffMs);
          opLog.warn({
            title: t('dm.op_rate_limited') || 'Discord rate limit — backing off',
            detail: `${Math.round(backoffMs / 100) / 10}s`,
          });
          await sleep(backoffMs);
          try {
            if (isGroup) await electronAPI.deleteGroupMessage(channelId, msg.id);
            else         await electronAPI.deleteDMMessage(channelId, msg.id);
            deleted++;
            result.deleted = deleted;
            if (dEl()) dEl().textContent = String(deleted);
            if (progressBar) progressBar.update((deleted / deletable.length) * 100);
            opLog.success(stepKey, {
              title: t('dm.op_deleted_one') || 'Message deleted',
              detail: `id ${msg.id}`,
            });
            return;
          } catch (e2) {
            result.failed++;
            opLog.fail(stepKey, {
              title: t('dm.op_delete_failed') || 'Could not delete message',
              error: String(e2?.message || e2),
            });
            return;
          }
        }
        result.failed++;
        opLog.fail(stepKey, {
          title: t('dm.op_delete_failed') || 'Could not delete message',
          error: msgErr,
        });
      }
    };

    // Worker pool — atomic index counter (closure-shared) prevents the
    // theoretical case where two workers pop the same array slot under
    // weird microtask ordering. `shift()` is synchronous in JS so this is
    // belt-and-suspenders, but it also lets us track progress more cleanly.
    let nextIdx = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (!shouldStop) {
        const idx = nextIdx++;
        if (idx >= deletable.length) break;
        const m = deletable[idx];
        if (!m) break;
        await deleteOne(m);
        // small jitter between calls per worker
        await sleep(200 + Math.floor(Math.random() * 200));
      }
    });
    await Promise.all(workers);

    if (shouldStop) result.cancelled = true;
    if (progressBar && !shouldStop) progressBar.update(100);
  } catch (error) {
    console.error('Delete error:', error);
    if (modalOverlay) {
      const c = document.getElementById('progressContainer');
      if (c) c.innerHTML = `<p class="error">${error.message}</p>`;
    }
  } finally {
    if (modalOverlay) {
      setTimeout(() => { try { modalOverlay.remove(); } catch (_) {} ; onComplete(); }, 800);
    } else {
      onComplete();
    }
    if (ownsLog) {
      opLog.summary({ ok: result.deleted, fail: result.failed, total: result.total || (result.deleted + result.failed) });
      opLog.close({ delay: 2200 });
    }
  }
  return result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
