import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { InputError } from './validation.js';
import { STATUS } from './constants.js';

const publicFields = ['trackingNumber', 'carrier', 'originCity', 'destinationCity', 'status', 'location',
  'estimatedDelivery', 'shippedAt', 'deliveredAt', 'lastSyncedAt'];
const clone = (item) => structuredClone(item);

export class ShipmentStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'shipments.sqlite');
    const isNew = !existsSync(this.file);
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_shipments_updated ON shipments(updated_at);`);
    this.shipments = this.db.prepare('SELECT payload FROM shipments').all().map(row => JSON.parse(row.payload));
    const legacy = path.join(directory, 'shipments.json');
    if (isNew && existsSync(legacy)) {
      const imported = JSON.parse(readFileSync(legacy, 'utf8'));
      if (!Array.isArray(imported)) throw new Error('Invalid legacy data format.');
      this.shipments = imported;
      this.save();
    }
  }

  save() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM shipments');
      const insert = this.db.prepare('INSERT INTO shipments (id,payload,updated_at) VALUES (?,?,?)');
      for (const item of this.shipments) insert.run(item.id, JSON.stringify(item), item.updatedAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  item(id) {
    const shipment = this.shipments.find(item => item.id === id);
    if (!shipment) throw new InputError('Shipment not found.', undefined, 404);
    return shipment;
  }
  list() { return clone(this.shipments).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) { return clone(this.item(id)); }
  hasDuplicate(carrier, number, exceptId = null) {
    return this.shipments.some(s => s.id !== exceptId
      && s.carrier.toLowerCase() === carrier.toLowerCase()
      && s.trackingNumber.toLowerCase() === number.toLowerCase());
  }
  add(data) {
    if (this.hasDuplicate(data.carrier, data.trackingNumber)) {
      throw new InputError('A shipment with this carrier and tracking number already exists.', { trackingNumber: 'Tracking number already exists for this carrier.' }, 409);
    }
    if (data.notificationOptIn && !data.recipientEmail) throw new InputError('Recipient email is required for delivery notifications.', { recipientEmail: 'Enter an email address.' });
    const item = this.buildShipment(data);
    this.shipments.push(item);
    this.save();
    return clone(item);
  }
  buildShipment(data) {
    const now = new Date().toISOString();
    const item = {
      id: randomUUID(), trackingNumber: data.trackingNumber, carrier: data.carrier,
      recipientName: data.recipientName, recipientEmail: data.recipientEmail ?? '',
      notificationOptIn: data.notificationOptIn ?? false,
      originCity: data.originCity, destinationCity: data.destinationCity,
      packageDescription: data.packageDescription ?? '', service: data.service || 'Standard',
      weightKg: data.weightKg ?? null, reference: data.reference ?? '', notes: data.notes ?? '',
      shippedAt: data.shippedAt ?? '', estimatedDelivery: data.estimatedDelivery ?? '',
      status: 'pending', location: data.originCity, deliveredAt: null,
      shareToken: null, providerTrackingId: null, providerSlug: null,
      lastSyncedAt: null, lastProviderEventAt: null, syncError: null,
      createdAt: now, updatedAt: now,
      events: [{ id: randomUUID(), status: 'pending', location: data.originCity,
        description: 'Shipment added to the tracker.', createdAt: now, source: 'manual' }],
    };
    return item;
  }
  bulkImport(records) {
    if (!Array.isArray(records) || records.length === 0 || records.length > 500) throw new InputError('Import requires 1–500 valid shipments.');
    const originalLength = this.shipments.length;
    const keys = new Set(this.shipments.map(s => `${s.carrier.toLowerCase()}\0${s.trackingNumber.toLowerCase()}`));
    for (const record of records) {
      const key = `${record.carrier.toLowerCase()}\0${record.trackingNumber.toLowerCase()}`;
      if (keys.has(key)) throw new InputError('One or more imported tracking numbers already exist.', undefined, 409);
      keys.add(key);
    }
    try {
      this.shipments.push(...records.map(row => this.buildShipment(row)));
      this.save();
      return { imported: this.shipments.length - originalLength };
    } catch (error) {
      this.shipments.length = originalLength;
      throw error;
    }
  }
  update(id, changes) {
    const current = this.item(id);
    const next = { ...current, ...changes };
    if (!next.trackingNumber || !next.carrier || !next.recipientName || !next.originCity || !next.destinationCity) {
      throw new InputError('Required shipment fields cannot be empty.');
    }
    if (next.shippedAt && next.estimatedDelivery && next.shippedAt > next.estimatedDelivery) {
      throw new InputError('Estimated delivery must be on or after shipping date.', { estimatedDelivery: 'Delivery is before shipment date.' });
    }
    if (next.notificationOptIn && !next.recipientEmail) {
      throw new InputError('Recipient email is required for delivery notifications.', { recipientEmail: 'Enter an email address.' });
    }
    if (current.providerTrackingId && (next.carrier !== current.carrier || next.trackingNumber !== current.trackingNumber)) {
      throw new InputError('Disconnect live tracking before changing the carrier or tracking number.');
    }
    if (this.hasDuplicate(next.carrier, next.trackingNumber, id)) {
      throw new InputError('A shipment with this carrier and tracking number already exists.', { trackingNumber: 'Tracking number already exists for this carrier.' }, 409);
    }
    Object.assign(current, changes, { updatedAt: new Date().toISOString() });
    this.save();
    return clone(current);
  }
  addEvent(id, data) {
    const current = this.item(id);
    const now = new Date().toISOString();
    current.events.push({ id: randomUUID(), ...data, createdAt: now, source: 'manual' });
    current.status = data.status;
    if (data.location) current.location = data.location;
    current.deliveredAt = data.status === 'delivered' ? now : null;
    current.updatedAt = now;
    this.save();
    return clone(current);
  }
  delete(id) {
    const index = this.shipments.findIndex(s => s.id === id);
    if (index < 0) throw new InputError('Shipment not found.', undefined, 404);
    const [removed] = this.shipments.splice(index, 1);
    this.save();
    return clone(removed);
  }
  setShare(id, action) {
    const current = this.item(id);
    if (action === 'enable' || action === 'rotate') current.shareToken = randomBytes(24).toString('base64url');
    else if (action === 'disable') current.shareToken = null;
    else throw new InputError('Invalid sharing action.');
    current.updatedAt = new Date().toISOString();
    this.save();
    return clone(current);
  }
  publicView(token) {
    // No IDs, personal contact info, package descriptions, order references or internal notes.
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new InputError('Tracking link not found.', undefined, 404);
    const s = this.shipments.find(item => item.shareToken && item.shareToken === token);
    if (!s) throw new InputError('Tracking link not found.', undefined, 404);
    const details = Object.fromEntries(publicFields.map(key => [key, s[key] ?? null]));
    details.events = (s.events || []).map(e => ({
      status: e.status, location: e.location || '', createdAt: e.createdAt,
      // Descriptions often contain private operations notes. Only expose normalized statuses.
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return details;
  }
  connectProvider(id, { trackingId, slug }) {
    const current = this.item(id);
    if (current.providerTrackingId) throw new InputError('This shipment is already connected.', undefined, 409);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(trackingId)) throw new InputError('Provider did not return a valid tracking ID.', undefined, 502);
    current.providerTrackingId = trackingId;
    current.providerSlug = slug || null;
    current.syncError = null;
    current.updatedAt = new Date().toISOString();
    this.save();
    return clone(current);
  }
  disconnectProvider(id) {
    const current = this.item(id);
    current.providerTrackingId = null;
    current.providerSlug = null;
    current.lastSyncedAt = null;
    current.lastProviderEventAt = null;
    current.syncError = null;
    current.updatedAt = new Date().toISOString();
    this.save();
    return clone(current);
  }
  recordSyncError(id, message) {
    const current = this.item(id);
    current.syncError = String(message).slice(0, 220);
    current.lastSyncedAt = new Date().toISOString();
    this.save();
  }
  applyProviderSnapshot(id, snapshot) {
    const current = this.item(id);
    if (!current.providerTrackingId) throw new InputError('Live tracking is not connected.', undefined, 409);
    if (snapshot.id && current.providerTrackingId !== snapshot.id) throw new InputError('Provider tracking ID mismatch.', undefined, 502);
    if (snapshot.trackingNumber && snapshot.trackingNumber.toLowerCase() !== current.trackingNumber.toLowerCase()) {
      throw new InputError('Provider tracking number mismatch.', undefined, 502);
    }
    const previousStatus = current.status;
    const seen = new Set((current.events || []).map(e => e.externalId).filter(Boolean));
    let eventsAdded = 0;
    for (const event of snapshot.events) {
      if (seen.has(event.externalId)) continue;
      current.events.push({ id: randomUUID(), ...event });
      seen.add(event.externalId);
      eventsAdded++;
    }
    const latest = snapshot.events.at(-1)?.createdAt || null;
    const isStale = latest && current.lastProviderEventAt && latest < current.lastProviderEventAt;
    if (!isStale && snapshot.status) current.status = snapshot.status;
    if (latest && (!current.lastProviderEventAt || latest > current.lastProviderEventAt)) current.lastProviderEventAt = latest;
    const newest = [...snapshot.events].reverse().find(e => e.location);
    if (!isStale && newest) current.location = newest.location;
    if (!isStale && snapshot.estimatedDelivery && (!current.estimatedDelivery || current.status !== 'delivered')) current.estimatedDelivery = snapshot.estimatedDelivery;
    if (current.status === 'delivered' && !current.deliveredAt) {
      current.deliveredAt = [...current.events].reverse().find(e => e.status === 'delivered')?.createdAt || new Date().toISOString();
    } else if (current.status !== 'delivered') current.deliveredAt = null;
    const statusChanged = previousStatus !== current.status;
    // Some carriers send an overall status without a new checkpoint.
    if (statusChanged && !snapshot.events.some(e => e.status === current.status)) {
      const fallbackId = `tag:${current.status}:${latest || 'none'}`;
      if (!seen.has(fallbackId) && !current.events.some(e => e.externalId === fallbackId)) {
        current.events.push({ id: randomUUID(), externalId: fallbackId, status: current.status,
          location: current.location || '', description: 'Carrier status updated.',
          createdAt: new Date().toISOString(), source: 'aftership' });
        eventsAdded++;
      }
    }
    current.lastSyncedAt = new Date().toISOString();
    current.syncError = null;
    if (statusChanged || eventsAdded || snapshot.estimatedDelivery) current.updatedAt = current.lastSyncedAt;
    this.save();
    return { shipment: clone(current), statusChanged, eventsAdded };
  }
  linkedShipments() { return this.list().filter(s => s.providerTrackingId && s.status !== 'delivered'); }
  findByProviderSnapshot(snapshot) {
    const found = this.shipments.find(s => s.providerTrackingId && (
      (snapshot.id && s.providerTrackingId === snapshot.id) ||
      (snapshot.trackingNumber && s.trackingNumber.toLowerCase() === snapshot.trackingNumber.toLowerCase()
        && (!snapshot.slug || s.providerSlug === snapshot.slug))));
    return found ? clone(found) : null;
  }
  summary() {
    const counts = Object.fromEntries(Object.keys(STATUS).map(key => [key, 0]));
    const today = new Date().toISOString().slice(0, 10);
    let overdue = 0;
    for (const item of this.shipments) {
      counts[item.status] += 1;
      if (item.estimatedDelivery && item.estimatedDelivery < today && item.status !== 'delivered') overdue++;
    }
    return { total: this.shipments.length, counts, overdue };
  }
}
