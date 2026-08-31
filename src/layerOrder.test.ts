import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draggedLayerIds, reorderLayers } from './layerOrder.ts';
const layers = [{ id: 'background' }, { id: 'photo' }, { id: 'title' }, { id: 'badge' }];
const names = (items: {id:string}[]) => items.map(item => item.id);

test('dropping above a row paints the moved layer in front of it', () => {
  const result = reorderLayers(layers, ['photo'], 'badge', 'before');
  assert.deepEqual(names(result), ['background', 'title', 'badge', 'photo']);
  assert.deepEqual(names(layers), ['background', 'photo', 'title', 'badge']);
  assert.equal(result[3], layers[1]);
});
test('dropping below a row paints behind it, including at the back', () => {
  assert.deepEqual(names(reorderLayers(layers, ['badge'], 'photo', 'after')), ['background', 'badge', 'photo', 'title']);
  assert.deepEqual(names(reorderLayers(layers, ['title'], 'background', 'after')), ['title', 'background', 'photo', 'badge']);
});
test('multi-selection retains its relative order regardless of selection order', () => {
  assert.deepEqual(names(reorderLayers(layers, ['badge', 'photo'], 'title', 'after')), ['background', 'photo', 'badge', 'title']);
});
test('no-op and invalid drops preserve identity, avoiding empty undo entries', () => {
  assert.equal(reorderLayers(layers, ['title'], 'badge', 'after'), layers);
  assert.equal(reorderLayers(layers, ['title'], 'title', 'before'), layers);
  assert.equal(reorderLayers(layers, ['missing'], 'title', 'before'), layers);
  assert.equal(reorderLayers(layers, ['title'], 'other-page', 'before'), layers);
  assert.equal(reorderLayers(layers, [], 'badge', 'before'), layers);
});
test('dragging a selected item includes the selection and all members of its groups', () => {
  const grouped = [{id:'a',group:'g'}, {id:'b'}, {id:'c',group:'g'}, {id:'d'}];
  assert.deepEqual(draggedLayerIds(grouped, 'a', ['a','b','another-page']), ['a','b','c']);
  assert.deepEqual(draggedLayerIds(grouped, 'd', ['a','b']), ['d']);
  assert.deepEqual(draggedLayerIds(grouped, 'a', []), ['a','c']);
});
test('locked layers and groups containing a locked member cannot be dragged', () => {
  const locked = [{id:'a',group:'g'}, {id:'b',group:'g',locked:true}, {id:'c'}];
  assert.deepEqual(draggedLayerIds(locked, 'a', []), []);
  assert.deepEqual(draggedLayerIds(locked, 'c', ['b','c']), []);
  assert.equal(reorderLayers(locked, ['b'], 'c', 'before'), locked);
  assert.deepEqual(names(reorderLayers(locked, ['c'], 'b', 'after')), ['a','c','b']);
});
