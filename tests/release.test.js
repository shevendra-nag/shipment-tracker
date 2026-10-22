import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/app.js';
import { parseCsv, analyzeCsv, csvTemplate } from '../server/bulk.js';
import { buildAnalytics } from '../server/analytics.js';
import { ShipmentStore } from '../server/store.js';

const valid = {
  trackingNumber: 'REL-001', carrier: 'India Post', recipientName: 'Recipient',
  originCity: 'Raipur', destinationCity: 'Bhopal', estimatedDelivery: '2026-10-30',
};
const sampleCsv = `Tracking number,Carrier,Recipient,Recipient email,Origin,Destination,Service,Weight (kg),Estimated delivery,Notes,Email opt-in\r\n"NEW-01","India Post","Chris, R.",,"Raipur","Bhopal",Express,1.5,2026-11-01,"urgent, fragile",no\r\nNEW-02,DTDC,Taylor,,Pune,Delhi,Standard,0.75,2026-11-02,,false\r\n`;

async function fixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shipment-release-'));
  const {server, store} = createServer({dataDir:dir});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let session = '';
  const req = async (route, method='GET', body=null) => {
    const res = await fetch(base + route, {
      method, headers:{ ...(session ? { Cookie: session } : {}), ...(body ? {'Content-Type':'application/json'} : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.headers.get('set-cookie')) session = res.headers.get('set-cookie').split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : type.includes('image/') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return {status:res.status, data, headers:res.headers};
  };
  try {
    assert.equal((await req('/api/auth/setup','POST', {name:'Release Admin',email:'release@example.com',password:'strong-password-release-123'})).status,201);
    await fn({req, dir, store});
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    rmSync(dir,{recursive:true,force:true});
  }
}

test('CSV parser handles BOM, quoted commas and escaped line breaks', () => {
  assert.match(csvTemplate(), /^\uFEFF"Tracking number"/);
  const parsed = parseCsv('\uFEFFTracking number,Carrier,Recipient,Origin,Destination,Notes\r\nAAA-001,DHL,"Taylor, M.",Delhi,Raipur,"Fragile\r\nthis side"\r\n');
  assert.equal(parsed.length,1);
  assert.equal(parsed[0].data.recipientName,'Taylor, M.');
  assert.equal(parsed[0].data.notes,'Fragile\r\nthis side');
  assert.throws(() => parseCsv('Tracking number,Carrier,Recipient,Origin,Destination\n"unclosed'),/unclosed/);
  assert.throws(() => parseCsv('Tracking number,Carrier,Recipient,Origin,Destination\n"AA"junk,DTDC,Taylor,X,Y'),/Malformed CSV/);
});

test('bulk CSV preview is non-mutating and import commits validated rows', async () => {
  await fixture(async ({req,store}) => {
    const preview = await req('/api/shipments/import/preview','POST',{csv:sampleCsv});
    assert.equal(preview.status,200);
    assert.deepEqual([preview.data.total, preview.data.ready, preview.data.skipped, preview.data.errors.length],[2,2,0,0]);
    assert.equal(store.list().length,0);
    assert.equal(preview.data.examples[0].recipientName,'Chris, R.');
    const result = await req('/api/shipments/import','POST',{csv:sampleCsv});
    assert.equal(result.status,201);
    assert.deepEqual([result.data.imported,result.data.skipped],[2,0]);
    assert.equal(store.list().length,2);
    assert.equal(store.list().find(x=>x.trackingNumber==='NEW-01').weightKg,1.5);
    assert.equal(store.list().find(x=>x.trackingNumber==='NEW-01').notificationOptIn,false);
    const again = await req('/api/shipments/import','POST',{csv:sampleCsv});
    assert.equal(again.status,200);
    assert.equal(again.data.imported,0);
    assert.equal(again.data.skipped,2);
    const reject = await req('/api/shipments/import','POST',{csv:sampleCsv,skipDuplicates:false});
    assert.equal(reject.status,422);
    assert.equal(store.list().length,2);
  });
});

test('CSV invalid rows cannot partially import and validation rejects absent columns', async () => {
  await fixture(async ({req}) => {
    const bad = sampleCsv + 'INV-003,DHL,"",,Delhi,Pune,Standard,1,,,no\n';
    const result = await req('/api/shipments/import/preview','POST',{csv:bad});
    assert.equal(result.status,200);
    assert.equal(result.data.ready,2);
    assert.equal(result.data.errors.length,1);
    const commit = await req('/api/shipments/import','POST',{csv:bad});
    assert.equal(commit.status,422);
    assert.equal((await req('/api/shipments')).data.shipments.length,0);
    const missing = await req('/api/shipments/import/preview','POST',{csv:'Tracking number,Carrier\nAA-555,DHL\n'});
    assert.equal(missing.status,400);
    assert.throws(() => parseCsv(sampleCsv.repeat(10000)),/600 KB/);
  });
});

test('reports measure shipped, delivered, overdue and carriers without inventing data', () => {
  const report = buildAnalytics([
    {carrier:'DHL',status:'delivered',createdAt:'2026-10-18T00:00:00.000Z',deliveredAt:'2026-10-19T12:00:00.000Z',shippedAt:'2026-10-17',estimatedDelivery:'2026-10-20'},
    {carrier:'DHL',status:'in_transit',createdAt:'2026-10-17T00:00:00.000Z',estimatedDelivery:'2026-10-18'},
    {carrier:'DTDC',status:'exception',createdAt:'2026-09-01T00:00:00.000Z',estimatedDelivery:''},
  ],7,new Date('2026-10-20T18:00:00.000Z'));
  assert.equal(report.total,3);
  assert.equal(report.createdInPeriod,2);
  assert.equal(report.deliveredInPeriod,1);
  assert.equal(report.onTimeRate,100);
  assert.equal(report.onTimeSample,1);
  assert.equal(report.overdue,1);
  assert.equal(report.carriers[0].total,2);
  assert.equal(report.counts.exception,1);
  assert.ok(report.avgTransitDays > 2);
  assert.throws(() => buildAnalytics([],14),/period must/);
});

test('branding is publicly readable but editable only by admin, supports validated logos', async () => {
  await fixture(async ({req}) => {
    assert.equal((await req('/api/public/branding')).data.branding.companyName,'Shipment Tracker');
    const invalid = await req('/api/branding','PUT',{companyName:'A',accent:'#ffffff'});
    assert.equal(invalid.status,400);
    const changed = await req('/api/branding','PUT',{companyName:'Northern Parcels',shortName:'NP',accent:'#1255c7',trackingMessage:'Shipment updates from our operations team.',supportEmail:'support@example.com'});
    assert.equal(changed.status,200);
    assert.equal((await req('/api/public/branding')).data.branding.companyName,'Northern Parcels');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
    assert.equal((await req('/api/branding/logo','POST',{image:`data:image/png;base64,${png}`})).status,200);
    assert.equal((await req('/api/public/logo')).status,200);
    assert.equal((await req('/api/public/branding')).data.branding.hasLogo,true);
    assert.equal((await req('/api/branding/logo','DELETE')).status,200);
    assert.equal((await req('/api/public/logo')).status,404);
    const xss = await req('/api/branding','PUT',{accent:'red; background:url(//evil.test)'});
    assert.equal(xss.status,400);
  });
});

test('API release routes are authenticated; viewers cannot import or change branding', async () => {
  await fixture(async ({req}) => {
    assert.equal((await req('/api/healthz')).status,200);
    assert.equal((await req('/api/analytics?days=30')).status,200);
    const user = await req('/api/users','POST',{name:'Viewer',email:'viewer-release@example.com',password:'viewer-pass-1234567',role:'viewer'});
    assert.equal(user.status,201);
    const signed = await req('/api/auth/login','POST',{email:'viewer-release@example.com',password:'viewer-pass-1234567'});
    assert.equal(signed.status,200);
    assert.equal((await req('/api/analytics')).status,200);
    assert.equal((await req('/api/branding','PUT',{companyName:'Hacked'})).status,403);
    assert.equal((await req('/api/shipments/import','POST',{csv:sampleCsv})).status,403);
  });
});

test('production mode requires an administrator setup key', () => {
  const dir = mkdtempSync(path.join(tmpdir(),'shipment-prod-test-'));
  try {
    assert.throws(() => createServer({dataDir:dir,env:{NODE_ENV:'production'}}),/ADMIN_SETUP_KEY/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('shipment persistence continues to work with bulk-imported rows', () => {
  const dir = mkdtempSync(path.join(tmpdir(),'shipment-bulk-persist-'));
  try {
    const one = new ShipmentStore(dir);
    const analysis = analyzeCsv(sampleCsv,one);
    one.bulkImport(analysis.records);
    one.db.close();
    const two = new ShipmentStore(dir);
    assert.equal(two.get(two.list()[0].id).events.length,1);
    assert.equal(two.list().length,2);
    two.db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
