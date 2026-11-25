import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff3 } from '../diff3.js';

const BASE = 'line1\nline2\nline3\nline4';

test('no changes is clean and identical', () => {
  const r = diff3(BASE, BASE, BASE);
  assert.equal(r.clean, true);
  assert.equal(r.merged, BASE);
  assert.deepEqual(r.conflicts, []);
});

test('local-only change wins', () => {
  const local = 'line1\nLOCAL\nline3\nline4';
  const r = diff3(BASE, local, BASE);
  assert.equal(r.clean, true);
  assert.equal(r.merged, local);
});

test('server-only change wins', () => {
  const server = 'line1\nline2\nSERVER\nline4';
  const r = diff3(BASE, BASE, server);
  assert.equal(r.clean, true);
  assert.equal(r.merged, server);
});

test('disjoint edits auto-merge', () => {
  const local = 'LOCAL\nline2\nline3\nline4';
  const server = 'line1\nline2\nline3\nSERVER';
  const r = diff3(BASE, local, server);
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'LOCAL\nline2\nline3\nSERVER');
});

test('identical edits on both sides are clean', () => {
  const same = 'line1\nBOTH\nline3\nline4';
  const r = diff3(BASE, same, same);
  assert.equal(r.clean, true);
  assert.equal(r.merged, same);
});

test('overlapping different edits conflict with markers', () => {
  const local = 'line1\nLOCAL\nline3\nline4';
  const server = 'line1\nSERVER\nline3\nline4';
  const r = diff3(BASE, local, server);
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], { base: 'line2', local: 'LOCAL', server: 'SERVER' });
  assert.ok(r.merged.includes('<<<<<<< LOCAL'));
  assert.ok(r.merged.includes('======='));
  assert.ok(r.merged.includes('>>>>>>> SERVER'));
  assert.ok(r.merged.includes('line1'));
  assert.ok(r.merged.includes('line3'));
});

test('insertion on one side merges', () => {
  const local = 'line1\nline2\nINSERTED\nline3\nline4';
  const server = 'line1\nline2\nline3\nSERVER';
  const r = diff3(BASE, local, server);
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'line1\nline2\nINSERTED\nline3\nSERVER');
});

test('trailing insertion on one side merges', () => {
  const local = BASE + '\nAPPENDED';
  const r = diff3(BASE, local, BASE);
  assert.equal(r.clean, true);
  assert.equal(r.merged, local);
});

test('trailing insertion on both sides at end conflicts or merges deterministically', () => {
  const local = BASE + '\nLOCALTAIL';
  const server = BASE + '\nSERVERTAIL';
  const r = diff3(BASE, local, server);
  // Both appended different tails at the same position: overlap -> conflict.
  assert.equal(r.clean, false);
  assert.ok(r.merged.includes('LOCALTAIL'));
  assert.ok(r.merged.includes('SERVERTAIL'));
});

test('deletions in disjoint regions merge', () => {
  const local = 'line2\nline3\nline4';
  const server = 'line1\nline2\nline3';
  const r = diff3(BASE, local, server);
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'line2\nline3');
});

test('empty base with content on both identical sides', () => {
  const r = diff3('', 'a\nb', 'a\nb');
  assert.equal(r.clean, true);
  assert.equal(r.merged, 'a\nb');
});

test('multi-line overlapping region reports full slices', () => {
  const base = 'a\nb\nc\nd\ne';
  const local = 'a\nB1\nB2\nd\ne';
  const server = 'a\nS1\nc\nd\ne';
  const r = diff3(base, local, server);
  assert.equal(r.clean, false);
  assert.equal(r.conflicts[0].base, 'b\nc');
  assert.equal(r.conflicts[0].local, 'B1\nB2');
  assert.equal(r.conflicts[0].server, 'S1\nc');
});