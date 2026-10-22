import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/app.js';

async function fixture(fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'shipment-tracker-test-'));
  const { server } = createServer({ dataDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let session = '';
  const request = async (pathname, options = {}) => {
    const res = await fetch(`${url}${pathname}`, {
      ...options, headers: { ...(session ? { Cookie: session } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    if (res.headers.get('set-cookie')) session = res.headers.get('set-cookie').split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { res, body: type.includes('application/json') ? await res.json() : await res.text() };
  };
  await request('/api/auth/setup', { method: 'POST', body: JSON.stringify({name:'Test Admin',email:'admin@example.com',password:'very-safe-test-password-123'}) });
  try { await fn({ url, request, dataDir }); }
  finally { await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); }
}

const item = {
  trackingNumber: 'TEST-00001', carrier: 'Blue Dart', recipientName: 'Test Recipient',
  originCity: 'Mumbai', destinationCity: 'Pune', service: 'Express',
  estimatedDelivery: '2027-03-28', weightKg: 2.5,
};

test('full shipment lifecycle: create, list, edit, track, export, delete', async () => {
  await fixture(async ({ request, dataDir }) => {
    const home = await request('/');
    assert.equal(home.res.status, 200);
    assert.match(home.body, /Shipment Tracker/);

    const created = await request('/api/shipments', { method: 'POST', body: JSON.stringify(item) });
    assert.equal(created.res.status, 201);
    const id = created.body.shipment.id;
    assert.equal(created.body.shipment.status, 'pending');
    assert.equal(created.body.shipment.events.length, 1);

    const duplicate = await request('/api/shipments', { method: 'POST', body: JSON.stringify(item) });
    assert.equal(duplicate.res.status, 409);

    const updated = await request(`/api/shipments/${id}`, {
      method: 'PATCH', body: JSON.stringify({ destinationCity: 'Nagpur', notes: 'Call on arrival.' }),
    });
    assert.equal(updated.body.shipment.destinationCity, 'Nagpur');

    const event = await request(`/api/shipments/${id}/events`, {
      method: 'POST', body: JSON.stringify({ status: 'in_transit', location: 'Nashik', description: 'Sorted at hub.' }),
    });
    assert.equal(event.res.status, 201);
    assert.equal(event.body.shipment.status, 'in_transit');
    assert.equal(event.body.shipment.events.length, 2);

    const invalidStatus = await request(`/api/shipments/${id}/events`, {
      method: 'POST', body: JSON.stringify({ status: 'teleported' }),
    });
    assert.equal(invalidStatus.res.status, 400);

    const list = await request('/api/shipments');
    assert.equal(list.body.shipments.length, 1);
    const csv = await request('/api/shipments/export.csv');
    assert.equal(csv.res.status, 200);
    assert.match(csv.body, /TEST-00001/);

    const db = new DatabaseSync(path.join(dataDir, 'shipments.sqlite'));
    const saved = db.prepare('SELECT payload FROM shipments').all().map(x => JSON.parse(x.payload));
    db.close();
    assert.equal(saved[0].events.length, 2);
    const deleted = await request(`/api/shipments/${id}`, { method: 'DELETE' });
    assert.equal(deleted.res.status, 200);
    assert.equal((await request('/api/summary')).body.total, 0);
    assert.equal((await request(`/api/shipments/${id}`)).res.status, 404);
  });
});

test('validation rejects invalid dates, unexpected fields and malformed json', async () => {
  await fixture(async ({ request }) => {
    const badDate = await request('/api/shipments', { method: 'POST', body: JSON.stringify({ ...item, estimatedDelivery: '2026-02-31' }) });
    assert.equal(badDate.res.status, 400);
    assert.ok(badDate.body.details.estimatedDelivery);
    const badField = await request('/api/shipments', { method: 'POST', body: JSON.stringify({ ...item, status: 'delivered' }) });
    assert.equal(badField.res.status, 400);
    const badJson = await request('/api/shipments', { method: 'POST', body: '{broken' });
    assert.equal(badJson.res.status, 400);
  });
});

test('CSV export avoids spreadsheet formula injection', async () => {
  await fixture(async ({ request }) => {
    await request('/api/shipments', {
      method: 'POST', body: JSON.stringify({ ...item, trackingNumber: '=2+2', notes: '@SUM(1,2)' }),
    });
    const result = await request('/api/shipments/export.csv');
    // Invalid tracking number must be rejected before export.
    assert.doesNotMatch(result.body, /'=2\+2/);
    const clean = await request('/api/shipments', {
      method: 'POST', body: JSON.stringify({ ...item, notes: '=2+2' }),
    });
    assert.equal(clean.res.status, 201);
    const csv = await request('/api/shipments/export.csv');
    assert.match(csv.body, /"'=2\+2"/);
  });
});

test('static content does not expose files outside the public folder', async () => {
  await fixture(async ({ request }) => {
    assert.equal((await request('/server/app.js')).res.status, 404);
    assert.equal((await request('/assets/app.js')).res.status, 200);
    assert.equal((await request('/api/does-not-exist')).res.status, 404);
  });
});
