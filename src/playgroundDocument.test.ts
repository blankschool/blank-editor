import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTweetTemplateDocument } from './tweetTemplateDoc.ts';
import { createPlaygroundDocument, savePlaygroundCopy } from './playgroundDocument.ts';

test('opens the generated text and image as editable elements without changing the original', () => {
  const original = createTweetTemplateDocument();
  const before = structuredClone(original);
  const result = createPlaygroundDocument(original, 1, [
    { name: 'tweetText', type: 'text', value: 'Texto alterado no Playground\nSegunda linha' },
    { name: 'media', type: 'image', value: '  https://example.test/new.png  ' },
  ]);
  assert.equal(result.pages[0].els.find(el => el.name === 'tweetText')?.text, 'Texto alterado no Playground\nSegunda linha');
  assert.equal(result.pages[0].els.find(el => el.name === 'media')?.src, 'https://example.test/new.png');
  assert.equal(result.pages[0].els.length, original.pages[0].els.length);
  assert.equal(result.pages[0].els[3].type, 'text');
  assert.equal(result.pages[0].els[3].x, original.pages[0].els[3].x);
  assert.equal(result.seedId, undefined);
  assert.deepEqual(original, before);
});

test('captures values at generation time, detached from subsequent field and template edits', () => {
  const original = createTweetTemplateDocument();
  const fields = [{ name: 'tweetText', type: 'text' as const, value: 'Gerado' }];
  const result = createPlaygroundDocument(original, 1, fields);
  fields[0].value = 'Ainda não gerado';
  original.pages[0].els[3].fill = 'red';
  assert.equal(result.pages[0].els[3].text, 'Gerado');
  assert.notEqual(result.pages[0].els[3].fill, 'red');
});

test('applies fields only to the requested page and preserves assets, groups and the other pages', () => {
  const original = createTweetTemplateDocument();
  original.pages.push(structuredClone(original.pages[0]));
  original.pages[1].id = 'second';
  original.pages[1].els[3].group = 'my-group';
  original.assets = { photo: 'data:image/png;base64,fixture' };
  original.pages[1].els[4].src = '@photo';
  const result = createPlaygroundDocument(original, 2, [{ name: 'tweetText', type: 'text', value: 'Slide 2' }]);
  assert.equal(result.active, 1);
  assert.deepEqual(result.pages[0], original.pages[0]);
  assert.equal(result.pages[1].els[3].text, 'Slide 2');
  assert.equal(result.pages[1].els[3].group, 'my-group');
  assert.deepEqual(result.assets, original.assets);
  assert.equal(result.pages[1].els[4].src, '@photo');
});

test('blank fields preserve defaults just like the render request, and invalid pages fail', () => {
  const original = createTweetTemplateDocument();
  const result = createPlaygroundDocument(original, 1, [
    { name: 'tweetText', type: 'text', value: '  ' },
    { name: 'media', type: 'image', value: '' },
    { name: 'displayName', type: 'image', value: 'https://example.test/wrong-type.png' },
  ]);
  assert.deepEqual(result.pages, original.pages);
  for (const page of [0, 2, 1.5, NaN]) assert.throws(() => createPlaygroundDocument(original, page, []), /Página/);
});

test('persists a new design, never PUTs the source template, and returns the new identity', async (t) => {
  const source = createTweetTemplateDocument();
  const document = createPlaygroundDocument(source, 1, [{ name: 'tweetText', type: 'text', value: 'Gerado' }]);
  const calls: Array<{ url: unknown; options: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 'new-copy' }), { status: 201 });
  });
  const saved = await savePlaygroundCopy(document);
  assert.equal(saved.seedId, 'new-copy');
  assert.equal(document.seedId, undefined);
  assert.equal(source.seedId, 'tweet-screenshot');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/templates');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].options.body)).document, document);
});

test('reports a failed save without assigning the source identity or losing the generated document', async (t) => {
  const document = createPlaygroundDocument(createTweetTemplateDocument(), 1, []);
  const before = structuredClone(document);
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(savePlaygroundCopy(document));
  assert.deepEqual(document, before);
});
