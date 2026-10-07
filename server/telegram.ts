import { config } from './config';
import { log } from './log';

export class TgError extends Error {
  constructor(public method: string, public status: number, public description: string) {
    super(`Telegram ${method} failed (${status}): ${description}`);
  }
}
const base = () => `https://api.telegram.org/bot${config.token}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const IDEMPOTENT = new Set(['editMessageText', 'answerCallbackQuery', 'getFile', 'getMe', 'getWebhookInfo']);

export async function tg(method: string, body: Record<string, unknown>, attempt = 0): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${base()}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    if (IDEMPOTENT.has(method) && attempt < 2) { await sleep(500 * 2 ** attempt); return tg(method, body, attempt + 1); }
    log.error('tg_network_error', e, { method });
    throw new TgError(method, 0, 'network error');
  }
  const j: any = await res.json().catch(() => ({}));
  if (j.ok) return j.result;
  const desc = String(j.description ?? 'unknown');
  if (res.status === 429 && attempt < 2) {
    await sleep(Math.min((j.parameters?.retry_after ?? 1) * 1000, 5000));
    return tg(method, body, attempt + 1);
  }
  if (res.status >= 500 && IDEMPOTENT.has(method) && attempt < 2) {
    await sleep(500 * 2 ** attempt); return tg(method, body, attempt + 1);
  }
  if (!desc.includes('message is not modified')) log.warn('tg_api_error', { method, status: res.status, desc });
  throw new TgError(method, res.status, desc);
}

export async function sendDocument(chatId: number, filename: string, content: string, caption: string) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', caption);
  fd.append('document', new Blob([content], { type: 'application/json' }), filename);
  const res = await fetch(`${base()}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!j.ok) throw new TgError('sendDocument', res.status, String(j.description ?? 'unknown'));
}

export async function downloadFile(fileId: string, maxBytes: number): Promise<string> {
  const f = await tg('getFile', { file_id: fileId });
  if (!f?.file_path) throw new Error('file path missing');
  if (f.file_size && f.file_size > maxBytes) throw new Error('file too large');
  const res = await fetch(`https://api.telegram.org/file/bot${config.token}/${f.file_path}`,
    { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`file download failed (${res.status})`);
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error('file too large');
  return text;
}
