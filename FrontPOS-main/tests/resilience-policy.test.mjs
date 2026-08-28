import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cartRecordKey,
  cartStorageKey,
  classifySyncStatus,
  computeSSERetryDelay,
  computeSyncRetryDelay,
  isFatalSyncStatus,
  parseSSEBlock,
} from '../src/lib/resilience-policy.mjs';

test('sync backoff is deterministic with injected randomness and capped at five minutes', () => {
  assert.equal(computeSyncRetryDelay(0, () => 0), 2_000);
  assert.equal(computeSyncRetryDelay(3, () => 0), 16_000);
  assert.equal(computeSyncRetryDelay(40, () => 0.99), 300_000);
});

test('fatal sale responses go to dead-letter while later queue items remain classifiable', () => {
  assert.deepEqual([400, 201, 503].map(classifySyncStatus), ['dead-letter', 'success', 'retry']);
  for (const status of [400, 409, 410, 422]) assert.equal(isFatalSyncStatus(status), true);
  assert.equal(isFatalSyncStatus(401), false);
  assert.equal(classifySyncStatus(401), 'session-recovery');
});

test('SSE reconnect backoff grows exponentially and caps at 30 seconds', () => {
  assert.equal(computeSSERetryDelay(0, () => 0), 1_000);
  assert.equal(computeSSERetryDelay(4, () => 0), 16_000);
  assert.equal(computeSSERetryDelay(20, () => 0.5), 30_000);
});

test('SSE parser supports CRLF, event names and multiline data', () => {
  assert.deepEqual(
    parseSSEBlock('event: INVENTORY_UPDATE\r\ndata: {"ok":true}\r\ndata: second\r\n'),
    { event: 'INVENTORY_UPDATE', data: '{"ok":true}\nsecond' },
  );
  assert.deepEqual(parseSSEBlock('data: "heartbeat"'), { event: 'message', data: '"heartbeat"' });
  assert.equal(parseSSEBlock(': keep-alive'), null);
});

test('cart records and fallback storage are isolated by cashier DNI', () => {
  assert.equal(cartRecordKey('1001'), 'active::1001');
  assert.notEqual(cartRecordKey('1001'), cartRecordKey('1002'));
  assert.equal(cartStorageKey('pos-active-carts', 'A/B'), 'pos-active-carts::A%2FB');
  assert.throws(() => cartRecordKey('  '), /DNI/);
  assert.throws(() => cartStorageKey('pos-active-carts', ''), /DNI/);
});
