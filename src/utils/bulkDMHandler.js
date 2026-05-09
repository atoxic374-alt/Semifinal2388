import { deleteDMMessages } from './messageDeleter.js';
import { openOperationLog } from './operationLog.js';
import { t } from './i18n.js';

/**
 * Run a bulk action across many DMs through ONE shared operation log so the
 * user sees every step (which DM, success/fail, totals) in real time.
 *
 *   handleBulkDMActions(items, 'delete' | 'close', electronAPI)
 *     → returns { ok, fail, total, cancelled }
 *
 * Notes:
 *  - Sequential by DM (Discord rate-limits per channel; parallel close/delete
 *    across many channels just generates 429s and noisy retries).
 *  - For 'delete', each DM gets its own internal worker pool inside
 *    `deleteDMMessages`, but those events flow into the shared op log via
 *    the `opLog` parameter.
 *  - Cancellable: clicking Cancel in the log stops new DMs; the in-flight
 *    one finishes its current message then exits.
 */
export async function handleBulkDMActions(selectedDMs, action, electronAPI) {
  const total = selectedDMs.length;
  const isDelete = action === 'delete';

  const log = openOperationLog({
    title: (isDelete
      ? (t('dm.op_delete_bulk_title') || 'Deleting messages in {n} DMs')
      : (t('dm.op_close_bulk_title')  || 'Closing {n} DMs')
    ).replace('{n}', total),
    context: '',
    total,
  });

  let cancelled = false;
  log.onCancel(() => { cancelled = true; });

  const summary = { ok: 0, fail: 0, total, cancelled: false };

  try {
    for (let i = 0; i < selectedDMs.length; i++) {
      if (cancelled) { summary.cancelled = true; break; }
      const dm = selectedDMs[i];
      const ctx = (t('dm.op_with') || 'with @{name}').replace('{name}', dm.username || dm.id);

      if (isDelete) {
        // Pipe per-message events into the shared log; suppress the legacy
        // modal so we don't get one popup per DM.
        const r = await deleteDMMessages({
          channelId: dm.id,
          username: dm.username,
          electronAPI,
          skipRefresh: true,
          opLog: log,
          useLegacyModal: false,
        });
        if (r && r.deleted > 0 && r.failed === 0) summary.ok++;
        else if (r && r.deleted > 0 && r.failed > 0) summary.ok++;
        else summary.fail++;
      } else {
        const stepKey = `close:${dm.id}`;
        log.start(stepKey, {
          title: t('dm.op_closing_one') || 'Closing channel',
          context: ctx,
        });
        try {
          const r = await electronAPI.closeDM(dm.id);
          if (r && r.success) {
            summary.ok++;
            log.success(stepKey, { title: t('dm.op_closed_one') || 'Channel closed', context: ctx });
          } else {
            summary.fail++;
            log.fail(stepKey, {
              title: t('dm.op_close_failed') || 'Could not close channel',
              context: ctx,
              error: (r && r.error) || 'unknown',
            });
          }
        } catch (e) {
          summary.fail++;
          log.fail(stepKey, {
            title: t('dm.op_close_failed') || 'Could not close channel',
            context: ctx,
            error: String(e?.message || e),
          });
        }
      }
    }
  } finally {
    log.summary({ ok: summary.ok, fail: summary.fail, total: summary.total });
    log.close({ delay: 2400 });
  }
  return summary;
}
