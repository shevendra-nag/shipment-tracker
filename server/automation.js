import { randomUUID } from 'node:crypto';
import { InputError } from './validation.js';
import { AfterShipClient, normalizeTracking } from './integrations.js';
import { STATUS } from './constants.js';

const asNumber = (value, fallback) => value === undefined ? fallback : Number(value);
function publicOrigin(value) {
  try {
    if (!value) return '';
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return '';
    return url.origin;
  } catch { return ''; }
}

export class NotificationService {
  constructor(store, { env = process.env, fetchImpl = fetch } = {}) {
    this.store = store;
    this.db = store.db;
    this.fetchImpl = fetchImpl;
    this.apiKey = env.RESEND_API_KEY || '';
    this.from = env.RESEND_FROM_EMAIL || '';
    this.siteOrigin = publicOrigin(env.PUBLIC_BASE_URL);
    this.configured = Boolean(this.apiKey && this.from);
    this.running = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, recipient TEXT NOT NULL,
      status_label TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT, next_attempt_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(state,next_attempt_at);`);
  }
  queueStatusChange(before, after) {
    if (!this.configured || !after.notificationOptIn || !after.recipientEmail || before.status === after.status) return null;
    const now = new Date().toISOString();
    const id = randomUUID();
    const payload = { carrier: after.carrier, trackingNumber: after.trackingNumber, status: after.status, location: after.location || '' };
    this.db.prepare(`INSERT INTO notifications
      (id, shipment_id, recipient, status_label, payload, state, attempts, created_at, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(
      id, after.id, after.recipientEmail, STATUS[after.status] || 'Updated', JSON.stringify(payload), now, Date.now(),
    );
    return id;
  }
  stats() {
    const counts = Object.fromEntries(['pending', 'sent', 'failed'].map(key => [key, 0]));
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS total FROM notifications GROUP BY state').all()) counts[row.state] = row.total;
    return { counts, configured: this.configured, sender: this.configured ? this.from : null,
      latest: this.db.prepare(`SELECT id,recipient,status_label,state,attempts,last_error,created_at,sent_at
        FROM notifications ORDER BY created_at DESC LIMIT 15`).all() };
  }
  async send(row) {
    const s = this.store.shipments.find(item => item.id === row.shipment_id);
    // Consent may have been withdrawn since the update was queued.
    if (!s || !s.notificationOptIn || s.recipientEmail !== row.recipient) return 'cancelled';
    const payload = JSON.parse(row.payload);
    const link = s.shareToken && this.siteOrigin ? `\nTrack your parcel: ${this.siteOrigin}/track/${s.shareToken}\n` : '';
    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST', headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json', 'Idempotency-Key': row.id,
      },
      body: JSON.stringify({
        from: this.from, to: [row.recipient],
        subject: `Shipment update: ${payload.status} · ${payload.trackingNumber}`,
        text: `Hello,\n\nYour shipment ${payload.trackingNumber} (${payload.carrier}) is now ${payload.status.toLowerCase()}.\n${payload.location ? `Latest location: ${payload.location}\n` : ''}${link}\nThis is an automated shipment update.\n`,
      }), signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Email provider rejected the request (HTTP ${response.status}).`);
    return 'sent';
  }
  async process() {
    if (this.running || !this.configured) return { processed: 0 };
    this.running = true;
    let processed = 0;
    try {
      const jobs = this.db.prepare("SELECT * FROM notifications WHERE state='pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 8").all(Date.now());
      for (const row of jobs) {
        try {
          const outcome = await this.send(row);
          this.db.prepare('UPDATE notifications SET state=?,attempts=attempts+1,sent_at=?,last_error=NULL WHERE id=?')
            .run(outcome === 'sent' ? 'sent' : 'failed', outcome === 'sent' ? new Date().toISOString() : null, row.id);
        } catch (error) {
          const attempts = row.attempts + 1;
          const next = Date.now() + Math.min(3600000, 60000 * (2 ** (attempts - 1)));
          this.db.prepare('UPDATE notifications SET state=?,attempts=?,last_error=?,next_attempt_at=? WHERE id=?')
            .run(attempts >= 5 ? 'failed' : 'pending', attempts, String(error.message).slice(0, 180), next, row.id);
        }
        processed++;
      }
    } finally { this.running = false; }
    return { processed };
  }
}

export class TrackingAutomation {
  constructor(store, { env = process.env, fetchImpl = fetch } = {}) {
    this.store = store;
    this.client = new AfterShipClient({ apiKey: env.AFTERSHIP_API_KEY || '', fetchImpl });
    this.notifications = new NotificationService(store, { env, fetchImpl });
    this.webhookSecret = env.AFTERSHIP_WEBHOOK_SECRET || '';
    this.syncMinutes = asNumber(env.TRACKING_SYNC_MINUTES, 30);
    if (!Number.isFinite(this.syncMinutes) || this.syncMinutes < 0) this.syncMinutes = 30;
    this.timer = null;
    this.busy = false;
    this.lastRuns = new Map();
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS tracking_webhook_receipts (
      id TEXT PRIMARY KEY, processed_at TEXT NOT NULL
    );`);
  }
  status() {
    const counts = this.notifications.stats();
    return {
      aftershipConfigured: this.client.configured,
      webhookConfigured: Boolean(this.webhookSecret),
      syncMinutes: this.syncMinutes,
      linked: this.store.shipments.filter(s => s.providerTrackingId).length,
      shareEnabled: this.store.shipments.filter(s => s.shareToken).length,
      notifications: counts,
    };
  }
  async connect(id, slug = '') {
    const shipment = this.store.get(id);
    if (shipment.providerTrackingId) throw new InputError('Already connected to a courier.', undefined, 409);
    const snapshot = await this.client.create(shipment, slug);
    if (!snapshot.id) throw new InputError('AfterShip did not return a tracking ID.', undefined, 502);
    this.store.connectProvider(id, { trackingId: snapshot.id, slug: snapshot.slug });
    const result = this.store.applyProviderSnapshot(id, snapshot);
    this.notifications.queueStatusChange(shipment, result.shipment);
    void this.notifications.process().catch(error => console.error('[email queue]', error.message));
    return result;
  }
  async sync(id, { ignoreCooldown = false } = {}) {
    const shipment = this.store.get(id);
    if (!shipment.providerTrackingId) throw new InputError('Connect this shipment to AfterShip first.', undefined, 409);
    const last = Date.parse(shipment.lastSyncedAt || '') || 0;
    if (!ignoreCooldown && Date.now() - last < 60_000) throw new InputError('This shipment was synced recently. Try again in one minute.', undefined, 429);
    try {
      const snapshot = await this.client.get(shipment.providerTrackingId);
      const result = this.store.applyProviderSnapshot(id, snapshot);
      this.notifications.queueStatusChange(shipment, result.shipment);
      void this.notifications.process().catch(error => console.error('[email queue]', error.message));
      return result;
    } catch (error) {
      this.store.recordSyncError(id, error.message);
      throw error;
    }
  }
  async syncDue({ limit = 12, force = false } = {}) {
    if (this.busy || !this.client.configured) return { synced: 0, failed: 0, skipped: true };
    this.busy = true;
    let synced = 0, failed = 0;
    try {
      const threshold = Date.now() - this.syncMinutes * 60000;
      const shipments = this.store.linkedShipments().filter(s => force || !s.lastSyncedAt || Date.parse(s.lastSyncedAt) <= threshold).slice(0, Math.min(limit, 20));
      for (const [index, item] of shipments.entries()) {
        // Limit burst traffic; AfterShip documents a five-GET-per-second limit.
        if (index) await new Promise(resolve => setTimeout(resolve, 300));
        try { await this.sync(item.id, { ignoreCooldown: true }); synced++; }
        catch { failed++; }
      }
    } finally { this.busy = false; }
    return { synced, failed, skipped: false };
  }
  processWebhook(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new InputError('Invalid webhook payload.');
    const receiptId = String(payload.event_id || '').slice(0, 150);
    if (!receiptId || !/^[A-Za-z0-9_-]{8,150}$/.test(receiptId)) throw new InputError('Missing valid webhook event ID.');
    if (this.db.prepare('SELECT id FROM tracking_webhook_receipts WHERE id=?').get(receiptId)) return { duplicate: true };
    const raw = payload.msg?.tracking || payload.msg;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('Webhook does not contain tracking information.');
    const snapshot = normalizeTracking(raw);
    const matched = this.store.findByProviderSnapshot(snapshot);
    if (matched && ['tracking_update', 'edd_revise'].includes(payload.event)) {
      // EDD-only webhooks should not regress the shipment's delivery status,
      // even when their embedded tracking tag is older than a later checkpoint.
      const update = payload.event === 'edd_revise'
        ? { ...snapshot, status: null, events: [] } : snapshot;
      const updated = this.store.applyProviderSnapshot(matched.id, update);
      this.notifications.queueStatusChange(matched, updated.shipment);
      void this.notifications.process().catch(error => console.error('[email queue]', error.message));
    }
    // Ignore deliveries for unrelated tracking IDs, but remember their event IDs.
    this.db.prepare('INSERT INTO tracking_webhook_receipts (id,processed_at) VALUES (?,?)').run(receiptId, new Date().toISOString());
    return { duplicate: false, matched: Boolean(matched) };
  }
  start() {
    if (this.timer) return;
    if (!(this.client.configured || this.notifications.configured)) return;
    this.timer = setInterval(() => {
      void this.notifications.process().catch(error => console.error('[email queue]', error.message));
      if (this.syncMinutes > 0) void this.syncDue().catch(error => console.error('[tracking sync]', error.message));
    }, 60_000);
    this.timer.unref();
    void this.notifications.process().catch(error => console.error('[email queue]', error.message));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
