import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPlanItems, localDateKey, planMonthWeeks, shiftPlanMonth } from '../plan-panel.js';

test('calendar stays on the local date and uses Monday-first weeks', () => {
  assert.equal(localDateKey(new Date(2026, 10, 1, 0, 1)), '2026-11-01');
  const weeks = planMonthWeeks('2026-11-01');
  assert.equal(weeks[0][0].date, '2026-10-26');
  assert.equal(weeks[0][6].date, '2026-11-01');
  assert.equal(weeks.flat().filter(day => day.inMonth).length, 30);
});

test('month navigation clamps dates in shorter months and crosses years', () => {
  assert.equal(shiftPlanMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(shiftPlanMonth('2026-03-31', -1), '2026-02-28');
  assert.equal(shiftPlanMonth('2026-12-31', 1), '2027-01-31');
});

test('due dates and completion map to independent list groups', () => {
  const items = [
    { id: 1, due_date: '2026-11-28', done: false },
    { id: 2, due_date: '2026-11-29', done: false },
    { id: 3, due_date: '2026-11-30', done: false },
    { id: 4, due_date: null, done: false },
    { id: 5, due_date: '2026-12-06', done: false },
    { id: 6, due_date: '2026-11-28', done: true },
  ];
  const ids = (groups, key) => groups[key].map(item => item.id);
  const sunday = groupPlanItems(items, '2026-11-29');
  assert.deepEqual(ids(sunday, 'overdue'), [1]);
  assert.deepEqual(ids(sunday, 'today'), [2]);
  assert.deepEqual(ids(sunday, 'thisWeek'), []);
  assert.deepEqual(ids(sunday, 'future'), [3, 5]);
  assert.deepEqual(ids(sunday, 'undated'), [4]);
  assert.deepEqual(ids(sunday, 'completed'), [6]);
  const monday = groupPlanItems(items, '2026-11-30');
  assert.deepEqual(ids(monday, 'today'), [3]);
  assert.deepEqual(ids(monday, 'thisWeek'), [5]);
});
