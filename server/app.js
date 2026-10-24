import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ShipmentStore } from './store.js';
import { TrackingAutomation } from './automation.js';
import { verifyAfterShipWebhook } from './integrations.js';
import { AuthService, parseSession, cookie, clearCookie } from './auth.js';
import { STATUS, CARRIERS, SERVICES } from './constants.js';
import { InputError, validateShipment, validateEvent } from './validation.js';
import { analyzeCsv, csvTemplate } from './bulk.js';
import { buildAnalytics } from './analytics.js';
import { BrandingService } from './branding.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(body);
}

async function readRaw(req, maxSize = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw new InputError('Request body is too large.', undefined, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxSize = 65536) {
  const body = (await readRaw(req, maxSize)).toString('utf8');
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new InputError('Content-Type must be application/json.', undefined, 415);
  }
  try { return JSON.parse(body); }
  catch { throw new InputError('Invalid JSON request body.'); }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(items) {
  const keys = [
    ['trackingNumber', 'Tracking number'], ['carrier', 'Carrier'], ['status', 'Status'],
    ['recipientName', 'Recipient'], ['recipientEmail', 'Recipient email'],
    ['originCity', 'Origin'], ['destinationCity', 'Destination'],
    ['service', 'Service'], ['packageDescription', 'Description'], ['weightKg', 'Weight (kg)'],
    ['reference', 'Order reference'], ['shippedAt', 'Shipped at'],
    ['estimatedDelivery', 'Estimated delivery'], ['location', 'Last location'],
    ['createdAt', 'Created at'], ['updatedAt', 'Updated at'], ['notes', 'Notes'],
  ];
  return '\ufeff' + [
    keys.map(([, label]) => csvCell(label)).join(','),
    ...items.map((item) => keys.map(([key]) => csvCell(key === 'status' ? STATUS[item.status] : item[key])).join(',')),
  ].join('\r\n') + '\r\n';
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : /^\/track\/[A-Za-z0-9_-]{32}$/.test(pathname) ? 'track.html' : pathname.replace(/^\/+/, '');
  if (relative.includes('\\') || relative.includes('\0')) return send(res, 404, { error: 'Not found.' });
  const file = path.resolve(PUBLIC, relative);
  if (file !== PUBLIC && !file.startsWith(`${PUBLIC}${path.sep}`)) {
    return send(res, 404, { error: 'Not found.' });
  }
  const extension = path.extname(file);
  if (!CONTENT_TYPES[extension]) return send(res, 404, { error: 'Not found.' });
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension],
      'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return send(res, 404, { error: 'Not found.' });
    throw error;
  }
}

export function createServer({ dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), env = process.env, fetchImpl = fetch } = {}) {
  const store = new ShipmentStore(path.resolve(dataDir));
  const auth = new AuthService(store.db);
  const branding = new BrandingService(store.db);
  if (env.NODE_ENV === 'production' && (!env.ADMIN_SETUP_KEY || env.ADMIN_SETUP_KEY.length < 20)) {
    store.db.close();
    throw new Error('ADMIN_SETUP_KEY must have at least 20 characters in production.');
  }
  const automation = new TrackingAutomation(store, { env, fetchImpl });
  const loginAttempts = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (env.COOKIE_SECURE === 'true') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch { throw new InputError('Invalid request path.'); }
      if (pathname.startsWith('/api/')) {
        const method = req.method;
        if (pathname === '/api/healthz' && method === 'GET') return send(res, 200, { ok: true });
        if (pathname === '/api/public/branding' && method === 'GET') return send(res, 200, { branding: branding.get() });
        if (pathname === '/api/public/logo' && method === 'GET') {
          const logo = branding.logo();
          if (!logo) return send(res, 404, { error: 'Logo not configured.' });
          res.writeHead(200, { 'Content-Type': logo.mime, 'Content-Length': logo.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(logo.bytes);
          return;
        }
        const token = parseSession(req);
        const secure = env.COOKIE_SECURE === 'true';
        const origin = req.headers.origin;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && origin && pathname !== '/api/webhooks/aftership') {
          let originHost = '';
          try { originHost = new URL(origin).host; } catch { /* reject malformed origin */ }
          if (originHost !== req.headers.host) return send(res, 403, { error: 'Cross-origin request denied.' });
        }
        // Public tracking needs an unguessable share token, never a shipment ID.
        const publicMatch = pathname.match(/^\/api\/public\/track\/([A-Za-z0-9_-]{32})$/);
        if (publicMatch && method === 'GET') return send(res, 200, { shipment: store.publicView(publicMatch[1]) });
        if (pathname === '/api/webhooks/aftership' && method === 'POST') {
          if (!automation.webhookSecret) return send(res, 503, { error: 'Webhook integration is not configured.' });
          const raw = await readRaw(req, 1024 * 1024);
          if (!verifyAfterShipWebhook(raw, req.headers['aftership-hmac-sha256'], automation.webhookSecret)) {
            return send(res, 401, { error: 'Invalid webhook signature.' });
          }
          let payload;
          try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new InputError('Invalid JSON webhook.'); }
          return send(res, 200, { ok: true, ...automation.processWebhook(payload) });
        }
        if (pathname === '/api/auth/state' && method === 'GET') return send(res, 200, { initialized: auth.initialized(), user: auth.me(token), setupProtectionRequired: Boolean(env.ADMIN_SETUP_KEY) });
        if (pathname === '/api/auth/setup' && method === 'POST') {
          const data = await readJson(req);
          if (env.ADMIN_SETUP_KEY) {
            const a = createHash('sha256').update(String(data?.setupKey || '')).digest();
            const b = createHash('sha256').update(env.ADMIN_SETUP_KEY).digest();
            if (!timingSafeEqual(a,b)) return send(res, 403, { error: 'Invalid administrator setup key.' });
          }
          const user = auth.setup(data);
          return send(res, 201, { user }, { 'Set-Cookie': cookie(auth.issue(user.id), secure) });
        }
        if (pathname === '/api/auth/login' && method === 'POST') {
          const ip = req.socket.remoteAddress || 'unknown';
          const recent = (loginAttempts.get(ip) || []).filter(ts => Date.now() - ts < 15 * 60_000);
          if (recent.length >= 10) return send(res, 429, { error: 'Too many login attempts. Try again later.' });
          try {
            const { user, token: issued } = auth.login(await readJson(req));
            loginAttempts.delete(ip);
            return send(res, 200, { user }, { 'Set-Cookie': cookie(issued, secure) });
          } catch (error) {
            if (error.status === 401) loginAttempts.set(ip, [...recent, Date.now()]);
            throw error;
          }
        }
        if (pathname === '/api/auth/logout' && method === 'POST') {
          auth.logout(token);
          return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(secure) });
        }
        const user = auth.me(token);
        if (!user) return send(res, 401, { error: 'Sign in to continue.' });
        if (pathname === '/api/analytics' && method === 'GET') {
          const period = new URL(req.url, 'http://localhost').searchParams.get('days') || '30';
          return send(res, 200, { analytics: buildAnalytics(store.list(), period) });
        }
        if (pathname === '/api/branding' && method === 'PUT') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          return send(res, 200, { branding: branding.update(await readJson(req)) });
        }
        if (pathname === '/api/branding/logo' && method === 'POST') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          return send(res, 200, branding.saveLogo(await readJson(req, 500_000)));
        }
        if (pathname === '/api/branding/logo' && method === 'DELETE') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          return send(res, 200, branding.removeLogo());
        }
        if (pathname === '/api/integrations/capabilities' && method === 'GET') return send(res, 200, {
          aftershipConfigured: automation.client.configured,
          notificationsConfigured: automation.notifications.configured,
        });
        if (pathname === '/api/integrations/status' && method === 'GET') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          return send(res, 200, automation.status());
        }
        if (pathname === '/api/integrations/sync' && method === 'POST') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          return send(res, 200, await automation.syncDue({ limit: 12, force: true }));
        }
        if (pathname === '/api/users' && method === 'GET') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          return send(res, 200, { users: auth.listUsers() });
        }
        if (pathname === '/api/users' && method === 'POST') {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          const data = await readJson(req);
          return send(res, 201, { user: auth.create(data, data.role || 'viewer') });
        }
        const userMatch = pathname.match(/^\/api\/users\/([0-9a-f-]{36})$/i);
        if (userMatch) {
          if (user.role !== 'admin') return send(res, 403, { error: 'Admin access required.' });
          if (method === 'PATCH') return send(res, 200, { user: auth.changeRole(userMatch[1], (await readJson(req)).role, user.id) });
          if (method === 'DELETE') { auth.removeUser(userMatch[1], user.id); return send(res, 200, { ok: true }); }
        }
        if (!['GET', 'HEAD'].includes(method)) {
          if (user.role === 'viewer') return send(res, 403, { error: 'Read-only account.' });
          if (method === 'DELETE' && user.role !== 'admin') return send(res, 403, { error: 'Admin access required to delete shipments.' });
        }
        if (pathname === '/api/health' && method === 'GET') return send(res, 200, { ok: true });
        if (pathname === '/api/meta' && method === 'GET') return send(res, 200, { statuses: STATUS, carriers: CARRIERS, services: SERVICES });
        if (pathname === '/api/summary' && method === 'GET') return send(res, 200, store.summary());
        if (pathname === '/api/shipments/import/template.csv' && method === 'GET') {
          return send(res, 200, csvTemplate(), { 'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename=shipment-import-template.csv' });
        }
        if (pathname === '/api/shipments/import/preview' && method === 'POST') {
          if (user.role === 'viewer') return send(res, 403, { error: 'Read-only account.' });
          const data = await readJson(req, 850_000);
          const { records, ...preview } = analyzeCsv(data?.csv, store, { skipDuplicates: data?.skipDuplicates !== false });
          return send(res, 200, preview);
        }
        if (pathname === '/api/shipments/import' && method === 'POST') {
          if (user.role === 'viewer') return send(res, 403, { error: 'Read-only account.' });
          const data = await readJson(req, 850_000);
          const { records, ...preview } = analyzeCsv(data?.csv, store, { skipDuplicates: data?.skipDuplicates !== false });
          if (preview.errors.length) throw new InputError('Fix the invalid CSV rows before importing.', { rows: preview.errors.slice(0, 20) }, 422);
          if (!records.length) return send(res, 200, { imported: 0, skipped: preview.skipped });
          return send(res, 201, { ...store.bulkImport(records), skipped: preview.skipped });
        }
        if (pathname === '/api/shipments/export.csv' && method === 'GET') {
          return send(res, 200, exportCsv(store.list()), {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="shipments.csv"',
          });
        }
        if (pathname === '/api/shipments' && method === 'GET') return send(res, 200, { shipments: store.list() });
        if (pathname === '/api/shipments' && method === 'POST') {
          const record = store.add(validateShipment(await readJson(req)));
          return send(res, 201, { shipment: record });
        }
        const integrationMatch = pathname.match(/^\/api\/shipments\/([0-9a-f-]{36})\/(share|tracking\/(connect|sync|disconnect))$/i);
        if (integrationMatch && method === 'POST') {
          if (user.role === 'viewer') return send(res, 403, { error: 'Read-only account.' });
          const id = integrationMatch[1];
          const action = integrationMatch[2];
          if (action === 'share') {
            const body = await readJson(req);
            return send(res, 200, { shipment: store.setShare(id, body.action) });
          }
          if (action === 'tracking/connect') {
            const body = await readJson(req);
            if (typeof body.slug !== 'string') throw new InputError('Carrier slug must be text.');
            return send(res, 200, await automation.connect(id, body.slug.trim()));
          }
          if (action === 'tracking/sync') return send(res, 200, await automation.sync(id));
          if (action === 'tracking/disconnect') return send(res, 200, { shipment: store.disconnectProvider(id) });
        }
        const match = pathname.match(/^\/api\/shipments\/([0-9a-f-]{36})(?:\/(events))?$/i);
        if (match) {
          const id = match[1];
          if (match[2] === 'events' && method === 'POST') {
            const previous = store.get(id);
            const updated = store.addEvent(id, validateEvent(await readJson(req)));
            automation.notifications.queueStatusChange(previous, updated);
            void automation.notifications.process().catch(error => console.error('[notifications]', error.message));
            return send(res, 201, { shipment: updated });
          }
          if (!match[2] && method === 'GET') return send(res, 200, { shipment: store.get(id) });
          if (!match[2] && method === 'PATCH') {
            return send(res, 200, { shipment: store.update(id, validateShipment(await readJson(req), { partial: true })) });
          }
          if (!match[2] && method === 'DELETE') return send(res, 200, { shipment: store.delete(id) });
        }
        return send(res, 404, { error: 'API endpoint not found.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
      return await serveStatic(res, pathname);
    } catch (error) {
      if (!(error instanceof InputError)) console.error('[server]', error);
      if (!res.headersSent) return send(res, error.status || 500, {
        error: error instanceof InputError ? error.message : 'An unexpected server error occurred.',
        ...(error instanceof InputError && error.details ? { details: error.details } : {}),
      });
      res.end();
    }
  });
  server.on('listening', () => automation.start());
  server.on('close', () => automation.stop());
  return { server, store, auth, automation, branding };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be a valid port number.');
    process.exit(1);
  }
  const { server } = createServer();
  server.listen(port, host, () => console.log(`Shipment Tracker: http://${host}:${server.address().port}`));
}
