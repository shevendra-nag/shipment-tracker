import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/app.js';

const payload = { trackingNumber:'SEC-123456', carrier:'Blue Dart', recipientName:'Recipient', originCity:'Delhi', destinationCity:'Jaipur' };
test('setup, login, permissions, sessions and migration', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'shiptrack-auth-'));
  const legacy = { id:'00000000-0000-4000-8000-000000000001', ...payload, status:'pending', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), events:[] };
  writeFileSync(path.join(dataDir,'shipments.json'),JSON.stringify([legacy]));
  const {server,store} = createServer({dataDir});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (url, method='GET', body, session='') => {
    const res = await fetch(base + url,{method,headers:{...(session ? {Cookie:session} : {}),...(body ? {'Content-Type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined});
    return {status:res.status, data:await res.json(), cookie:res.headers.get('set-cookie')?.split(';')[0]};
  };
  try {
    assert.equal((await req('/api/shipments')).status,401);
    assert.equal((await req('/api/auth/state')).data.initialized,false);
    const admin = await req('/api/auth/setup','POST',{name:'Administrator', email:'admin@shiptrack.test',password:'correct-horse-battery-123'});
    assert.equal(admin.status,201);
    assert.equal((await req('/api/auth/setup','POST',{name:'Other',email:'other@test.org',password:'long-long-password'})).status,409);
    const cookie=admin.cookie;
    assert.equal((await req('/api/shipments','GET',null,cookie)).data.shipments.length,1);
    assert.ok(existsSync(path.join(dataDir,'shipments.sqlite')));
    const viewer = await req('/api/users','POST',{name:'Read Only',email:'read@test.org',password:'viewer-password-123',role:'viewer'},cookie);
    assert.equal(viewer.status,201);
    const operator = await req('/api/users','POST',{name:'Operator',email:'op@test.org',password:'operator-password-123',role:'operator'},cookie);
    assert.equal(operator.status,201);
    assert.equal((await req('/api/auth/login','POST',{email:'read@test.org',password:'wrong'})).status,401);
    const viewerCookie=(await req('/api/auth/login','POST',{email:'read@test.org',password:'viewer-password-123'})).cookie;
    assert.equal((await req('/api/shipments','POST',payload,viewerCookie)).status,403);
    assert.equal((await req('/api/users','GET',null,viewerCookie)).status,403);
    const opCookie=(await req('/api/auth/login','POST',{email:'op@test.org',password:'operator-password-123'})).cookie;
    assert.equal((await req('/api/shipments','POST',{...payload, trackingNumber:'SEC-999'},opCookie)).status,201);
    assert.equal((await req(`/api/shipments/${legacy.id}`,'DELETE',null,opCookie)).status,403);
    assert.equal((await req(`/api/users/${admin.data.user.id}`,'PATCH',{role:'viewer'},cookie)).status,400);
    assert.equal((await req('/api/auth/logout','POST',null,cookie)).status,200);
    assert.equal((await req('/api/shipments','GET',null,cookie)).status,401);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); rmSync(dataDir,{recursive:true,force:true}); }
});
