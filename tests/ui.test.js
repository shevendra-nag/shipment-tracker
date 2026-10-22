import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, badge, icon, dateShort } from '../public/assets/ui.js';

test('user-controlled strings are escaped before HTML rendering', () => {
  const dangerous = '"<img src=x onerror="alert(1)">&';
  const safe = esc(dangerous);
  assert.equal(safe.includes('<img'), false);
  assert.match(safe, /&lt;img/);
  assert.match(safe, /&quot;/);
  assert.match(safe, /&amp;/);
});

test('status labels and icons render with supported values', () => {
  assert.match(badge('delivered'), /Delivered/);
  assert.match(badge('exception'), /badge-red/);
  assert.match(icon('truck'), /<svg/);
});

test('invalid dates have safe display fallbacks', () => {
  assert.equal(dateShort(''), 'Not set');
  assert.equal(dateShort('not-a-date'), 'Unknown');
});
