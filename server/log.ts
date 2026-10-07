import crypto from 'crypto';
import { config } from './config';

function redact(s: string): string {
  let out = s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
  if (config.token) out = out.split(config.token).join('<redacted>');
  if (config.secret) out = out.split(config.secret).join('<redacted>');
  return out;
}
export const uidTag = (uid: number) =>
  crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 10);

function write(level: string, event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ severity: level, event, ...data, time: new Date().toISOString() });
  console.log(redact(line));
}
export const log = {
  info: (e: string, d?: Record<string, unknown>) => write('INFO', e, d),
  warn: (e: string, d?: Record<string, unknown>) => write('WARNING', e, d),
  error: (e: string, err?: unknown, d?: Record<string, unknown>) =>
    write('ERROR', e, { ...d, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      code: (err as any)?.code }),
};
