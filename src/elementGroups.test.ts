import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGroupElements, canUngroupElements, groupElements, ungroupElements } from './elementGroups.ts';

type Item = { id: string; group?: string; locked?: boolean };
const items = (...values: Item[]) => values;

test('groups two selected elements and reports whether the command changed anything', () => {
  const elements = items({ id: 'a' }, { id: 'b' }, { id: 'c' });
  assert.equal(canGroupElements(elements, ['a', 'b']), true);
  assert.equal(groupElements(elements, ['a', 'b'], 'new-group'), true);
  assert.equal(elements[0].group, 'new-group');
  assert.equal(elements[1].group, 'new-group');
  assert.equal(elements[2].group, undefined);
  assert.equal(groupElements(elements, ['a', 'b'], 'unused'), false);
});

test('grouping one member of a group with another element keeps the old group together', () => {
  const elements = items({ id: 'a', group: 'old' }, { id: 'b', group: 'old' }, { id: 'c' });
  assert.equal(groupElements(elements, ['a', 'c'], 'combined'), true);
  assert.deepEqual(elements.map(element => element.group), ['combined', 'combined', 'combined']);
});

test('ungrouping one selected member removes the group from all of its members', () => {
  const elements = items({ id: 'a', group: 'old' }, { id: 'b', group: 'old' }, { id: 'c' });
  assert.equal(canUngroupElements(elements, ['a']), true);
  assert.equal(ungroupElements(elements, ['a']), true);
  assert.deepEqual(elements.map(element => element.group), [undefined, undefined, undefined]);
});

test('locked elements disable structural group changes instead of partially changing a group', () => {
  const groupCase = items({ id: 'a' }, { id: 'b', locked: true });
  assert.equal(canGroupElements(groupCase, ['a', 'b']), false);
  assert.equal(groupElements(groupCase, ['a', 'b'], 'new'), false);
  const ungroupCase = items({ id: 'a', group: 'old' }, { id: 'b', group: 'old', locked: true });
  assert.equal(canUngroupElements(ungroupCase, ['a']), false);
  assert.equal(ungroupElements(ungroupCase, ['a']), false);
  assert.deepEqual(ungroupCase.map(element => element.group), ['old', 'old']);
});

test('invalid and single selections leave the document untouched', () => {
  const elements = items({ id: 'a' }, { id: 'b' });
  assert.equal(canGroupElements(elements, ['missing', 'a']), false);
  assert.equal(canUngroupElements(elements, ['a']), false);
  assert.equal(groupElements(elements, ['a'], 'new'), false);
  assert.equal(ungroupElements(elements, ['a']), false);
});
