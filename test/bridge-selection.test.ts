import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAutoConnectBridge } from '../src/bridge-selection';

const bridges = [{ name: 'other-project' }, { name: 'my-project' }, { name: 'third' }];

test('selectAutoConnectBridge: exact workspace match is claimed', () => {
  assert.equal(selectAutoConnectBridge(bridges, 'my-project'), 'my-project');
});

test('selectAutoConnectBridge: no match does NOT fall back to the first bridge', () => {
  assert.equal(selectAutoConnectBridge(bridges, 'unrelated'), null);
});

test('selectAutoConnectBridge: no workspace folder -> nothing auto-claimed', () => {
  assert.equal(selectAutoConnectBridge(bridges, null), null);
  assert.equal(selectAutoConnectBridge(bridges, undefined), null);
  assert.equal(selectAutoConnectBridge(bridges, ''), null);
});

test('selectAutoConnectBridge: single non-matching bridge is still not claimed', () => {
  assert.equal(selectAutoConnectBridge([{ name: 'someone-else' }], 'my-project'), null);
});

test('selectAutoConnectBridge: no bridges -> null', () => {
  assert.equal(selectAutoConnectBridge([], 'my-project'), null);
});

test('selectAutoConnectBridge: match is exact (no prefix / case-insensitive match)', () => {
  assert.equal(selectAutoConnectBridge([{ name: 'my-project-2' }, { name: 'My-Project' }], 'my-project'), null);
});
