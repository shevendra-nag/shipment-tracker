import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { InputError } from './validation.js';

// AfterShip Tracking API 2026-07. The base URL is deliberately fixed: no user-controlled URLs.
const AFTERSHIP_BASE = 'https://api.aftership.com/tracking/2026-07';
const DEFAULT_SLUGS = Object.freeze({
  'Blue Dart': 'bluedart', 'Delhivery': 'delhivery', 'DTDC': 'dtdc',
  'Ekart': 'ekart', 'India Post': 'india-post', 'Ecom Express': 'ecom-express',
  'DHL': 'dhl', 'FedEx': 'fedex', 'UPS': 'ups', 'USPS': 'usps',
});
const TAGS = Object.freeze({
  pending: 'pending', inforeceived: 'pending', pickedup: 'picked_up',
  intransit: 'in_transit', outfordelivery: 'out_for_delivery',
  availableforpickup: 'out_for_delivery', delivered: 'delivered',
  attemptfail: 'exception', exception: 'exception', expired: 'exception',
});

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
export function trackingStatus(tag) {
  return TAGS[String(tag || '').replace(/[^a-z]/gi, '').toLowerCase()] || null;
}
export function carrierSlug(carrier, override = '') {
  if (override && !/^[a-z0-9][a-z0-9-]{1,49}$/.test(override)) {
    throw new InputError('Carrier slug must contain 2–50 lowercase letters, digits or hyphens.');
  }
  return override || DEFAULT_SLUGS[carrier] || '';
}
function isoTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value) ? `${value}Z` : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function safeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}
export function normalizeTracking(raw) {
  const entry = raw?.data?.tracking || raw?.data || raw?.tracking || raw;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new InputError('The carrier sent an unrecognized tracking response.', undefined, 502);
  const checkpoints = Array.isArray(entry.checkpoints) ? entry.checkpoints.slice(0, 1000) : [];
  const events = checkpoints.map(point => {
    const status = trackingStatus(point.tag);
    const observed = isoTime(point.checkpoint_time || point.created_at);
    if (!status || !observed) return null;
    const location = cleanString([point.city, point.state, point.country_region_name].filter(Boolean).join(', '), 100);
    const description = cleanString(point.message || point.subtag_message || 'Carrier status updated.', 500);
    const key = cleanString(point.hash, 120) || createHash('sha256').update(JSON.stringify([observed, status, location, description])).digest('hex');
    return { externalId: key, status, location, description, createdAt: observed, source: 'aftership' };
  }).filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = events.at(-1);
  const status = trackingStatus(entry.tag) || last?.status || null;
  const estimatedDelivery = safeDate(entry.courier_estimated_delivery_date?.estimated_delivery_date)
    || safeDate(entry.aftership_estimated_delivery_date?.estimated_delivery_date)
    || safeDate(entry.latest_estimated_delivery?.estimated_delivery_date);
  return {
    id: cleanString(entry.id, 128), trackingNumber: cleanString(entry.tracking_number, 70),
    slug: cleanString(entry.slug, 60), status, estimatedDelivery, events,
  };
}

export class AfterShipClient {
  constructor({ apiKey = '', fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }
  get configured() { return Boolean(this.apiKey); }
  async request(endpoint, { method = 'GET', body } = {}) {
    if (!this.configured) throw new InputError('Set AFTERSHIP_API_KEY in the server environment to enable live tracking.', undefined, 503);
    let response;
    try {
      response = await this.fetchImpl(`${AFTERSHIP_BASE}${endpoint}`, {
        method, headers: { 'as-api-key': this.apiKey, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new InputError('Cannot reach AfterShip right now. Try again later.', undefined, 502);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new InputError('AfterShip returned an unreadable response.', undefined, 502); }
    if (!response.ok || (payload?.meta?.code && payload.meta.code >= 400)) {
      const message = cleanString(payload?.meta?.message || payload?.meta?.type || 'Carrier service rejected the request.', 180);
      throw new InputError(`AfterShip: ${message}`, undefined, response.status === 429 ? 429 : 502);
    }
    return normalizeTracking(payload);
  }
  create(shipment, override = '') {
    const slug = carrierSlug(shipment.carrier, override);
    const body = { tracking_number: shipment.trackingNumber };
    if (slug) body.slug = slug;
    return this.request('/trackings', { method: 'POST', body });
  }
  get(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new InputError('Invalid provider tracking ID.');
    return this.request(`/trackings/${encodeURIComponent(id)}`);
  }
}

export function verifyAfterShipWebhook(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}
