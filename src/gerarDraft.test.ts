import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBlankGerarImageSource, isBlankGerarImageSource, listGerarFixedElements, prepareGerarDraftDocument } from './gerarDraft.ts';
import type { Doc, El } from './types.ts';

function image(id: string, src: string): El {
  return {
    id, type: 'image', name: id, x: 0, y: 0, w: 100, h: 100, rot: 0,
    opacity: 1, locked: false, hidden: false, fill: '', stroke: '', strokeWidth: 0,
    radius: 0, src,
  };
}

test('an empty image slot inherited from the Blank seed does not render as a grey block', () => {
  const source: Doc = {
    name: 'Tweet', active: 0, seedId: 'source',
    pages: [{ id: 'p1', w: 1080, h: 1350, bg: '#000', els: [
      image('avatar', 'https://cdn.example.test/avatar.png'),
      image('media', 'https://placehold.co/936x620/2f3336/71757a?text=+'),
    ] }],
  };
  const before = structuredClone(source);
  const result = prepareGerarDraftDocument(source);
  assert.equal(hasBlankGerarImageSource(source), true);
  assert.equal(hasBlankGerarImageSource(result), false);
  assert.equal(result.pages[0].els[0].src, 'https://cdn.example.test/avatar.png');
  assert.equal(result.pages[0].els[1].src, '');
  assert.deepEqual(source, before);
});

test('recognizes only the legacy placeholder provider as an empty generated image', () => {
  assert.equal(isBlankGerarImageSource('https://placehold.co/100x100/aaa/bbb'), true);
  assert.equal(isBlankGerarImageSource('https://cdn.example.test/placehold.co/photo.png'), false);
  assert.equal(isBlankGerarImageSource('data:image/png;base64,fixture'), false);
  assert.equal(isBlankGerarImageSource(''), false);
});

test('preserves user images, embedded assets and private uploads', () => {
  const source: Doc = {
    name: 'Post', active: 0, pages: [{ id: 'p1', w: 100, h: 100, bg: '#fff', els: [
      image('public', 'https://images.example.test/photo.jpg'),
      image('embedded', 'data:image/png;base64,fixture'),
      image('asset', '@photo'),
      image('upload', 'supabase://uploads/user/photo.png'),
    ] }],
  };
  assert.deepEqual(prepareGerarDraftDocument(source), source);
});

test('changes visibility only for the selected fixed element on the requested page', () => {
  const source: Doc = {
    name: 'Post', active: 0, pages: [0, 1].map(page => ({
      id: `p${page}`, w: 100, h: 100, bg: '#fff', els: [{
        id: 'decoration', type: 'ellipse', name: 'Elipse', x: 10, y: 10, w: 30, h: 30,
        rot: 0, opacity: 1, locked: false, hidden: false, fill: '#8296a1', stroke: '',
        strokeWidth: 0, radius: 0,
      }],
    })),
  };
  const result = prepareGerarDraftDocument(source, 1, [{ id: 'decoration', hidden: true }]);
  assert.equal(result.pages[0].els[0].hidden, false);
  assert.equal(result.pages[1].els[0].hidden, true);
  assert.equal(source.pages[1].els[0].hidden, false);
});

test('lists the unexpected ellipse as a fixed model element, separate from generated fields', () => {
  const source: Doc = {
    name: 'Tweet', active: 0, pages: [{ id: 'p1', w: 1080, h: 1350, bg: '#000', els: [
      image('avatar', 'https://images.example.test/avatar.png'),
      { id: 'title', type: 'text', name: 'tweetText', text: 'Post', x: 0, y: 0, w: 100, h: 30, rot: 0, opacity: 1, locked: false, hidden: false, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 },
      { id: 'extra', type: 'ellipse', name: 'Elipse', x: 410, y: 545, w: 260, h: 260, rot: 0, opacity: 1, locked: false, hidden: false, fill: '#8296a1', stroke: '', strokeWidth: 0, radius: 0 },
    ] }],
  };
  assert.deepEqual(listGerarFixedElements(source, 0), [
    { id: 'extra', name: 'Elipse', type: 'ellipse', hidden: false },
  ]);
});
