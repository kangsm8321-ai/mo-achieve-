import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { config, configStatus } from './server/config.ts';
import { db, col } from './server/db.ts';
import { log } from './server/log.ts';
import { handleUpdate, claimUpdate } from './server/bot.ts';
import { startPolling } from './server/polling.ts';

const app = express();
app.disable('x-powered-by');

app.get('/health', async (_req, res) => {
  let firestore = 'ok';
  try { await db.collection('users').limit(1).get(); }
  catch (e) { firestore = 'error'; log.error('health_firestore_failed', e); }
  res.status(firestore === 'ok' ? 200 : 503).json({ status: firestore === 'ok' ? 'ok' : 'degraded', firestore, config: configStatus(), time: new Date().toISOString() });
});

// Read-only public media list & reviews API for the web showcase
app.get('/api/media', async (_req, res) => {
  try {
    const snap = await col.media().get();
    const media = snap.docs.map((d: any) => ({
      id: d.id,
      ...d.data(),
    })).sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ ok: true, media });
  } catch (e) {
    log.error('get_media_error', e);
    res.status(500).json({ ok: false, error: 'Failed to fetch media list' });
  }
});

function secretOk(h: string | undefined) {
  if (!config.secret || !h) return false;
  const a = Buffer.from(h), b = Buffer.from(config.secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/telegram/webhook',
  (req, res, next) => (secretOk(req.get('x-telegram-bot-api-secret-token')) ? next() : res.sendStatus(401)),
  express.json({ limit: '1mb' }),
  async (req, res) => {
    const u = req.body;
    if (!u || typeof u !== 'object' || !Number.isInteger(u.update_id)) { log.warn('invalid_update'); return res.sendStatus(200); }
    try {
      if (!(await claimUpdate(u.update_id))) { log.info('duplicate_update', { update_id: u.update_id }); return res.sendStatus(200); }
    } catch (e) {
      log.error('claim_failed', e, { update_id: u.update_id });
      return res.sendStatus(503);
    }
    try { await handleUpdate(u); } catch (e) { log.error('update_failed', e, { update_id: u.update_id }); }
    res.sendStatus(200);
  });

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.warn('bad_request', { type: err?.type });
  res.sendStatus(400);
});

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(process.cwd(), 'dist');
    app.use(express.static(dist));
    app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.listen(config.port, '0.0.0.0', () => {
    log.info('server_started', { port: config.port, config: configStatus() });
    startPolling();
  });
}
start();
