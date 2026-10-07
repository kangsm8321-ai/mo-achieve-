import { config } from './config.ts';
import { log } from './log.ts';
import { handleUpdate, claimUpdate } from './bot.ts';

let pollingActive = false;
let offset = 0;

export async function startPolling() {
  if (pollingActive || !config.token) return;
  pollingActive = true;
  log.info('bot_polling_started');

  (async () => {
    while (pollingActive) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${config.token}/getUpdates?offset=${offset}&timeout=20`,
          { signal: AbortSignal.timeout(35_000) }
        );
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const data: any = await res.json().catch(() => ({}));
        if (data?.ok && Array.isArray(data.result)) {
          for (const u of data.result) {
            offset = u.update_id + 1;
            try {
              if (await claimUpdate(u.update_id)) {
                await handleUpdate(u);
              } else {
                log.info('duplicate_update', { update_id: u.update_id });
              }
            } catch (e) {
              log.error('update_failed', e, { update_id: u.update_id });
            }
          }
        }
      } catch (e: any) {
        if (e.name !== 'TimeoutError') {
          log.warn('polling_error', { message: e?.message });
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();
}

export function stopPolling() {
  pollingActive = false;
}
