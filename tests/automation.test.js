import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { createServer } from '../server/app.js';
import { normalizeTracking, trackingStatus, verifyAfterShipWebhook } from '../server/integrations.js';

const baseShipment = {
  trackingNumber: 'SHIP-2026-74005', carrier: 'Blue Dart', recipientName: 'Private Person',
  recipientEmail: 'recipient@example.org', originCity: 'Bengaluru', destinationCity: 'Raipur',
  reference: 'SECRET-ORDER-15', notes: 'Internal payment reference: PRIVATE',
  packageDescription: 'Confidential purchase', notificationOptIn: true,
};
const point = (tag, time, city, hash) => ({tag, checkpoint_time:time, city, message:`Scanned in ${city}`, hash});
const snapshot = (tag, checkpoints, id = 'aft987654321', num = baseShipment.trackingNumber) => ({
  meta:{code:200}, data: { id, slug: 'bluedart', tracking_number:num, tag, checkpoints,
    courier_estimated_delivery_date:{estimated_delivery_date:'2026-10-29'} },
});
const okJson = data => ({ok:true,status:200,json:async()=>data});

async function fixture(run, { credentials = true } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(),'shiptrack-auto-'));
  const calls = [];
  let tracking = snapshot('InTransit',[point('InTransit','2026-10-10T08:00:00Z','Delhi','ck-1')]);
  let rejectEmail = false;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({url,opts});
    if (url.endsWith('/trackings') && opts.method === 'POST') return okJson(tracking);
    if (url.includes('/trackings/')) return okJson(tracking);
    if (url.includes('api.resend.com/emails')) {
      if (rejectEmail) return {ok:false,status:503};
      return okJson({id:'test-mail-1'});
    }
    throw new Error(`Unexpected external fetch ${url}`);
  };
  const env = {
    AFTERSHIP_API_KEY: credentials ? 'fake-key' : '',
    AFTERSHIP_WEBHOOK_SECRET:'test-webhook-secret',
    RESEND_API_KEY:credentials ? 'fake-resend' : '',
    RESEND_FROM_EMAIL:credentials ? 'Tracking <updates@shiptrack.test>' : '',
    PUBLIC_BASE_URL:'https://example.org', TRACKING_SYNC_MINUTES:'0',
  };
  const {server,store,automation} = createServer({dataDir,env,fetchImpl});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (route, {method='GET',body,headers={},useAuth=true}={}) => {
    const res = await fetch(base+route,{method,headers:{...(useAuth && cookie ? {Cookie:cookie} : {}),...(body!==undefined ? {'Content-Type':'application/json'} : {}),...headers},body:body===undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
    const type = res.headers.get('content-type') || '';
    return {status:res.status, data:type.includes('application/json') ? await res.json() : await res.text(), headers:res.headers};
  };
  const setup = await request('/api/auth/setup',{method:'POST',body:{name:'Admin Example',email:'admin@shiptrack.test',password:'strong-unique-password-2026'}});
  cookie = setup.headers.get('set-cookie').split(';')[0];
  try { await run({request,calls,store,automation,env,base, setRemote:x=>tracking=x, setRejectEmail:x=>rejectEmail=x, getCookie:()=>cookie}); }
  finally { await new Promise(r=>server.close(r)); automation.stop(); store.db.close(); rmSync(dataDir,{recursive:true,force:true}); }
}

async function createItem(request, item=baseShipment) {
  const r=await request('/api/shipments',{method:'POST',body:item});
  assert.equal(r.status,201,JSON.stringify(r.data));
  return r.data.shipment;
}

test('carrier normalization supports 2026 AfterShip statuses and deduplicates checkpoints', async () => {
  assert.equal(trackingStatus('InfoReceived'),'pending');
  assert.equal(trackingStatus('InTransit'),'in_transit');
  assert.equal(trackingStatus('OutForDelivery'),'out_for_delivery');
  assert.equal(trackingStatus('Delivered'),'delivered');
  assert.equal(trackingStatus('AttemptFail'),'exception');
  assert.equal(trackingStatus('Teleport'),null);
  const output = normalizeTracking(snapshot('Delivered', [
    point('Delivered','2026-10-11T14:00:00Z','Raipur','ck-del'),
    point('InTransit','2026-10-10T08:00:00Z','Delhi','ck-transit'),
  ]));
  assert.equal(output.status,'delivered');
  assert.equal(output.events[0].status,'in_transit');
  assert.equal(output.events[1].externalId,'ck-del');
  assert.equal(output.estimatedDelivery,'2026-10-29');
});

test('public link is opt-in, excludes all private fields, rotates and revokes', async () => fixture(async ({request}) => {
  const s=await createItem(request);
  assert.equal(s.shareToken,null);
  assert.equal((await request(`/api/public/track/${'x'.repeat(32)}`,{useAuth:false})).status,404);
  const enabled=await request(`/api/shipments/${s.id}/share`,{method:'POST',body:{action:'enable'}});
  assert.equal(enabled.status,200);
  const token=enabled.data.shipment.shareToken;
  assert.equal(token.length,32);
  const shared=await request(`/api/public/track/${token}`,{useAuth:false});
  assert.equal(shared.status,200);
  assert.equal(shared.data.shipment.trackingNumber,s.trackingNumber);
  assert.equal(shared.data.shipment.recipientEmail,undefined);
  assert.equal(shared.data.shipment.recipientName,undefined);
  assert.equal(shared.data.shipment.notes,undefined);
  assert.equal(shared.data.shipment.reference,undefined);
  assert.equal(shared.data.shipment.packageDescription,undefined);
  assert.equal(shared.data.shipment.shareToken,undefined);
  assert.equal(shared.data.shipment.events[0].description,undefined);
  const html=await request(`/track/${token}`,{useAuth:false});
  assert.equal(html.status,200);
  assert.match(html.data,/ShipTrack/);
  assert.equal((await request('/server/store.js',{useAuth:false})).status,404);
  const rotated=await request(`/api/shipments/${s.id}/share`,{method:'POST',body:{action:'rotate'}});
  assert.equal(rotated.status,200);
  assert.notEqual(rotated.data.shipment.shareToken,token);
  assert.equal((await request(`/api/public/track/${token}`,{useAuth:false})).status,404);
  assert.equal((await request(`/api/public/track/${rotated.data.shipment.shareToken}`,{useAuth:false})).status,200);
  await request(`/api/shipments/${s.id}/share`,{method:'POST',body:{action:'disable'}});
  assert.equal((await request(`/api/public/track/${rotated.data.shipment.shareToken}`,{useAuth:false})).status,404);
}));

test('provider connect, sync, deduplication, status changes and disconnect', async () => fixture(async ({request,calls,setRemote}) => {
  const s=await createItem(request);
  const connected=await request(`/api/shipments/${s.id}/tracking/connect`,{method:'POST',body:{slug:''}});
  assert.equal(connected.status,200,JSON.stringify(connected.data));
  assert.equal(connected.data.shipment.providerTrackingId,'aft987654321');
  assert.equal(connected.data.shipment.status,'in_transit');
  assert.equal(connected.data.eventsAdded,1);
  const registration=calls.find(c=>c.url.endsWith('/trackings'));
  assert.deepEqual(JSON.parse(registration.opts.body),{tracking_number:s.trackingNumber,slug:'bluedart'});
  assert.equal(registration.opts.headers['as-api-key'],'fake-key');
  assert.equal((await request(`/api/shipments/${s.id}/tracking/sync`,{method:'POST'})).status,429);
  const newSnap=snapshot('Delivered',[
    point('InTransit','2026-10-10T08:00:00Z','Delhi','ck-1'),
    point('Delivered','2026-10-11T07:00:00Z','Raipur','ck-2'),
  ]);
  setRemote(newSnap);
  const result=await request('/api/integrations/sync',{method:'POST'});
  assert.equal(result.status,200);
  assert.equal(result.data.synced,1);
  const after=await request(`/api/shipments/${s.id}`);
  assert.equal(after.data.shipment.status,'delivered');
  assert.equal(after.data.shipment.events.filter(e=>e.externalId==='ck-1').length,1);
  assert.equal(after.data.shipment.events.filter(e=>e.externalId==='ck-2').length,1);
  assert.ok(after.data.shipment.deliveredAt);
  assert.equal((await request(`/api/shipments/${s.id}`,{method:'PATCH',body:{carrier:'DHL'}})).status,400);
  const disconnected=await request(`/api/shipments/${s.id}/tracking/disconnect`,{method:'POST'});
  assert.equal(disconnected.status,200);
  assert.equal(disconnected.data.shipment.providerTrackingId,null);
  assert.equal(disconnected.data.shipment.status,'delivered');
}));

test('signed webhook applies status once; wrong signatures rejected', async () => fixture(async ({request,setRemote}) => {
  const s=await createItem(request);
  await request(`/api/shipments/${s.id}/tracking/connect`,{method:'POST',body:{slug:''}});
  const remote=snapshot('OutForDelivery',[
    point('InTransit','2026-10-10T08:00:00Z','Delhi','ck-1'),
    point('OutForDelivery','2026-10-11T07:00:00Z','Raipur','ck-out'),
  ]);
  setRemote(remote);
  const body={event:'tracking_update',event_id:'10d2ee9b-5409-4154-b280-a05243364156',ts:1791700000,msg:remote.data};
  const raw=JSON.stringify(body);
  const bad=await request('/api/webhooks/aftership',{method:'POST',body:raw,headers:{'aftership-hmac-sha256':'wrong'}});
  assert.equal(bad.status,401);
  const signature=createHmac('sha256','test-webhook-secret').update(raw).digest('base64');
  const opts={method:'POST',body:raw,headers:{'aftership-hmac-sha256':signature,Origin:'https://api.aftership.com'}};
  const okay=await request('/api/webhooks/aftership',opts);
  assert.equal(okay.status,200,JSON.stringify(okay.data));
  assert.equal(okay.data.matched,true);
  assert.equal((await request('/api/webhooks/aftership',opts)).data.duplicate,true);
  const latest=await request(`/api/shipments/${s.id}`);
  assert.equal(latest.data.shipment.status,'out_for_delivery');
  assert.equal(latest.data.shipment.events.filter(e=>e.externalId==='ck-out').length,1);
  assert.ok(verifyAfterShipWebhook(Buffer.from(raw),signature,'test-webhook-secret'));
  assert.ok(!verifyAfterShipWebhook(Buffer.from(raw+' '),signature,'test-webhook-secret'));
}));

test('signed estimated-delivery webhook updates ETA without rolling back status', async () => fixture(async ({request}) => {
  const s = await createItem(request);
  await request(`/api/shipments/${s.id}/tracking/connect`, {method:'POST',body:{slug:''}});
  const event={event:'edd_revise',event_id:'6a3e9024-f8ca-4c56-8af4-291847ff331a',
    msg:{id:'aft987654321',tracking_number:s.trackingNumber,slug:'bluedart',tag:'InfoReceived',
      aftership_estimated_delivery_date:{estimated_delivery_date:'2026-11-03'}}};
  const raw=JSON.stringify(event);
  const signature=createHmac('sha256','test-webhook-secret').update(raw).digest('base64');
  const sent=await request('/api/webhooks/aftership', {method:'POST',body:raw,headers:{'aftership-hmac-sha256':signature}});
  assert.equal(sent.status,200);
  const updated=(await request(`/api/shipments/${s.id}`)).data.shipment;
  assert.equal(updated.status,'in_transit');
  assert.equal(updated.estimatedDelivery,'2026-11-03');
  assert.equal(updated.events.filter(e=>e.source==='aftership').length,1);
}));

test('emails require opt-in and configured provider; never include confidential fields', async () => fixture(async ({request,calls,automation}) => {
  const s=await createItem(request);
  const share=await request(`/api/shipments/${s.id}/share`,{method:'POST',body:{action:'enable'}});
  const status=await request(`/api/shipments/${s.id}/events`,{method:'POST',body:{status:'picked_up',location:'Mumbai',description:'Sensitive note not in email'}});
  assert.equal(status.status,201);
  await automation.notifications.process();
  const mailed=calls.filter(x=>x.url.includes('api.resend.com/emails'));
  assert.equal(mailed.length,1);
  const message=JSON.parse(mailed[0].opts.body);
  assert.equal(message.to[0],'recipient@example.org');
  assert.match(message.text,/https:\/\/example.org\/track\//);
  assert.doesNotMatch(message.text,/SECRET-ORDER-15|Internal payment|Sensitive note/);
  assert.equal((await request('/api/integrations/status')).data.notifications.counts.sent,1);
  // User opts out: following status changes must not send email.
  await request(`/api/shipments/${s.id}`,{method:'PATCH',body:{notificationOptIn:false}});
  await request(`/api/shipments/${s.id}/events`,{method:'POST',body:{status:'delivered'}});
  await automation.notifications.process();
  assert.equal(calls.filter(x=>x.url.includes('api.resend.com/emails')).length,1);
  assert.ok(share.data.shipment.shareToken);
}));

test('permissions: viewer cannot connect or share and operator cannot read notification log', async () => fixture(async ({request,getCookie}) => {
  const s=await createItem(request);
  await request('/api/users',{method:'POST',body:{name:'Viewer',email:'viewer@shiptrack.test',password:'viewer-long-password-2026',role:'viewer'}});
  await request('/api/users',{method:'POST',body:{name:'Operator',email:'operator@shiptrack.test',password:'operator-long-password-2026',role:'operator'}});
  const original=getCookie();
  const viewerLogin=await request('/api/auth/login',{method:'POST',body:{email:'viewer@shiptrack.test',password:'viewer-long-password-2026'}});
  const viewCookie=viewerLogin.headers.get('set-cookie').split(';')[0];
  const viewerOpts={method:'POST',body:{action:'enable'},headers:{Cookie:viewCookie},useAuth:false};
  assert.equal((await request(`/api/shipments/${s.id}/share`,viewerOpts)).status,403);
  assert.equal((await request(`/api/shipments/${s.id}/tracking/connect`,{...viewerOpts,body:{slug:''}})).status,403);
  const operatorLogin=await request('/api/auth/login',{method:'POST',body:{email:'operator@shiptrack.test',password:'operator-long-password-2026'}});
  const opCookie=operatorLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/integrations/status',{headers:{Cookie:opCookie},useAuth:false})).status,403);
  assert.equal((await request('/api/integrations/sync',{method:'POST',headers:{Cookie:opCookie},useAuth:false})).status,403);
  assert.equal((await request(`/api/shipments/${s.id}/share`,{...viewerOpts,headers:{Cookie:opCookie}})).status,200);
  assert.ok(original);
}));

test('manual tracking works without paid provider keys and cannot send email', async () => fixture(async ({request,calls}) => {
  const s=await createItem(request);
  assert.equal((await request('/api/integrations/capabilities')).data.aftershipConfigured,false);
  assert.equal((await request(`/api/shipments/${s.id}/tracking/connect`,{method:'POST',body:{slug:''}})).status,503);
  const changed=await request(`/api/shipments/${s.id}/events`,{method:'POST',body:{status:'in_transit'}});
  assert.equal(changed.status,201);
  assert.equal(calls.length,0);
}, {credentials:false}));
