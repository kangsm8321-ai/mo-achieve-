import fs from 'fs';
import path from 'path';

function readFirebaseConfig(): { projectId?: string; firestoreDatabaseId?: string } {
  try {
    const p = path.join(process.cwd(), 'firebase-applet-config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}
const fb = readFirebaseConfig();

const rawSecret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
// Telegram secret_token requires characters matching [a-zA-Z0-9_-]
const sanitizedSecret = rawSecret.replace(/[^a-zA-Z0-9_-]/g, '_');

export const config = {
  token: process.env.TELEGRAM_BOT_TOKEN ?? '',
  secret: sanitizedSecret,
  allowed: new Set(
    (process.env.TELEGRAM_ALLOWED_USER_ID ?? '')
      .split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number)
  ),
  projectId: process.env.FIRESTORE_PROJECT_ID || fb.projectId,
  databaseId: process.env.FIRESTORE_DATABASE_ID || fb.firestoreDatabaseId || '(default)',
  port: Number(process.env.PORT) || 3000,
};

export const configStatus = () => {
  const hasSa = Boolean(
    (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) ||
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    fs.existsSync(path.join(process.cwd(), 'service-account.json'))
  );
  return {
    botToken: !!config.token,
    webhookSecret: config.secret.length >= 16,
    allowedUsers: config.allowed.size,
    firestoreProject: !!config.projectId,
    serviceAccountKey: hasSa,
  };
};
