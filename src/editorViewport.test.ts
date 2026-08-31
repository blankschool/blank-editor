import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_GAP, pageOffset, pageAtY, zoomedPanY, verticalBounds } from './editorViewport.ts';

const pages = [{ h: 1440 }, { h: 1080 }, { h: 1920 }];

test('page controls keep the same space at 15%, 100% and 180% zoom', () => {
  for (const zoom of [0.15, 1, 1.8]) {
    const firstBottom = pages[0].h * zoom;
    const secondTop = pageOffset(pages, 1, zoom) * zoom;
    assert.ok(Math.abs(secondTop - firstBottom - PAGE_GAP) < 1e-8);
    assert.equal(pageAtY(pages, pageOffset(pages, 2, zoom) + 80, zoom), 2);
  }
});

test('zoom on a later page preserves the artwork point under the cursor', () => {
  const oldZoom = 0.4, nextZoom = 1.8, anchorY = 300, localY = 420;
  const panY = anchorY - (pageOffset(pages, 2, oldZoom) + localY) * oldZoom;
  const nextPanY = zoomedPanY(pages, panY, anchorY, oldZoom, nextZoom);
  assert.ok(Math.abs(nextPanY + (pageOffset(pages, 2, nextZoom) + localY) * nextZoom - anchorY) < 1e-8);
});

test('the gap belongs to the nearest page, including before and after the document', () => {
  const zoom = 0.4;
  const split = pages[0].h + PAGE_GAP / zoom / 2;
  assert.equal(pageAtY(pages, -100, zoom), 0);
  assert.equal(pageAtY(pages, split - 1, zoom), 0);
  assert.equal(pageAtY(pages, split + 1, zoom), 1);
  assert.equal(pageAtY(pages, 50000, zoom), 2);
});

test('a small document stays centered instead of panning into empty space', () => {
  assert.deepEqual(verticalBounds(200, 800), { min: 300, max: 300 });
});

test('scroll limits leave room for the first header and final add-page button', () => {
  const bounds = verticalBounds(2400, 800);
  assert.equal(bounds.max, 56);
  assert.equal(bounds.min + 2400, 720);
  // A page that fits without its controls still needs scroll to expose them.
  const nearlyFits = verticalBounds(760, 800);
  assert.ok(nearlyFits.min < nearlyFits.max);
});
