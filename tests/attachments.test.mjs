import { test } from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readAttachment, validateAttachments, attachmentsToParts, attachmentDataURL, formatAttachmentSize, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, MAX_TEXT_ATTACHMENT_BYTES, MAX_HISTORY_ATTACHMENT_BYTES, ATTACHMENT_ACCEPT } from '../attachments.js';

const signatures = {
  'image/jpeg': [255, 216, 255, 224],
  'image/png': [137, 80, 78, 71, 13, 10, 26, 10],
  'image/webp': [...Buffer.from('RIFF'), 4, 0, 0, 0, ...Buffer.from('WEBP')],
  'application/pdf': [...Buffer.from('%PDF-1.7\n')],
};
const binary = (mimeType = 'image/png', size = signatures[mimeType].length, id = 'local_1') => {
  const payload = Buffer.alloc(size); Buffer.from(signatures[mimeType]).copy(payload);
  return { id, name: mimeType === 'application/pdf' ? 'file.pdf' : 'file.png', mimeType, size, kind: mimeType === 'application/pdf' ? 'pdf' : 'image', data: payload.toString('base64') };
};
const text = (value = 'hello', id = 'text_1') => ({ id, name: 'hello.txt', mimeType: 'text/plain', size: Buffer.byteLength(value), kind: 'text', text: value });

test('public constants match UI contract and accept list excludes active/binary formats', () => {
  assert.equal(MAX_ATTACHMENTS, 4); assert.equal(MAX_ATTACHMENT_BYTES, 4 * 1024 ** 2);
  assert.equal(MAX_ATTACHMENT_TOTAL_BYTES, 8 * 1024 ** 2); assert.equal(MAX_TEXT_ATTACHMENT_BYTES, 512 * 1024);
  assert.equal(MAX_HISTORY_ATTACHMENT_BYTES, 12 * 1024 ** 2);
  for (const value of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', '.ts', '.py', '.md']) assert.ok(ATTACHMENT_ACCEPT.includes(value));
  for (const value of ['image/svg', '.svg', '.docx', '.zip']) assert.ok(!ATTACHMENT_ACCEPT.includes(value));
});
test('browser File/Blob reader produces signed image/PDF records and native data URLs', async () => {
  for (const mimeType of Object.keys(signatures)) {
    const record = await readAttachment(new File([Uint8Array.from(signatures[mimeType])], mimeType === 'application/pdf' ? 'f.pdf' : 'photo.png', { type: mimeType }));
    assert.equal(record.mimeType, mimeType); assert.equal(record.size, signatures[mimeType].length);
    assert.match(record.id, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(record.data, Buffer.from(signatures[mimeType]).toString('base64'));
    assert.equal(attachmentDataURL(record), `data:${mimeType};base64,${record.data}`);
  }
});
test('UTF-8 text/code/docs are inert canonical text, preserving BOM, Unicode and filenames as data', async () => {
  for (const [name, type] of [['code.py', ''], ['sample.ts', 'application/octet-stream'], ['file.json', 'application/json'], ['page.html', 'text/html'], ['notes.md', 'text/markdown'], ['a.csv', 'text/csv']]) {
    const value = '\ufeffhi é 😀\n<script>throw 1</script>\t';
    const record = await readAttachment(new File([value], name, { type }));
    assert.equal(record.kind, 'text'); assert.equal(record.mimeType, 'text/plain'); assert.equal(record.text, value);
    assert.equal(record.size, Buffer.byteLength(value));
  }
  const name = '<img src=x onerror=alert(1)>.txt';
  const record = await readAttachment(new File(['ordinary'], name, { type: 'text/plain' }));
  assert.equal(record.name, name);
  assert.throws(() => attachmentDataURL(record), /Only validated images and PDFs/);
});
test('unsupported metadata, empty files and oversize reject before reading', async () => {
  for (const file of [
    { name: 'x.svg', type: 'image/svg+xml', size: 10 }, { name: 'x.svg', type: 'text/plain', size: 10 },
    { name: 'x.zip', type: 'application/zip', size: 10 }, { name: 'x.docx', type: 'application/zip', size: 10 },
    { name: 'x.bin', type: '', size: 10 }, { name: 'x.png', type: 'image/x-unknown', size: 10 },
    { name: 'x.png', type: 'image/png', size: MAX_ATTACHMENT_BYTES + 1 },
    { name: 'x.txt', type: 'text/plain', size: MAX_TEXT_ATTACHMENT_BYTES + 1 }, { name: 'x.txt', type: 'text/plain', size: 0 },
  ]) await assert.rejects(readAttachment({ ...file, arrayBuffer() { assert.fail('Read rejected metadata'); } }), /Unsupported|smaller|Empty/);
});
test('reader rejects signature/MIME mismatch, invalid UTF8, NUL/control binary, and changed file size', async () => {
  for (const [bytes, type, name] of [
    [signatures['image/png'], 'image/jpeg', 'x.jpg'], [[1, 2, 3], 'application/pdf', 'x.pdf'],
    [[255, 254], 'text/plain', 'x.txt'], [[65, 0, 66], 'text/plain', 'x.txt'], [[65, 27, 66], 'text/plain', 'x.txt'],
  ]) await assert.rejects(readAttachment(new File([Uint8Array.from(bytes)], name, { type })), /match|UTF-8|control/);
  await assert.rejects(readAttachment({ name: 'x.txt', type: 'text/plain', size: 2, arrayBuffer: async () => new Uint8Array([65]).buffer }), /size changed/);
});
test('persisted records validate exact bytes, canonical base64 and signatures defensively', () => {
  for (const mime of Object.keys(signatures)) assert.deepEqual(validateAttachments([binary(mime)]), [binary(mime)]);
  const png = binary();
  for (const record of [
    null, {}, { ...png, kind: 'video' }, { ...png, id: '../bad' }, { ...png, id: 'x'.repeat(129) },
    { ...png, name: '' }, { ...png, name: 'x'.repeat(256) }, { ...png, name: 'a\n.png' }, { ...png, name: 'a.svg' },
    { ...png, size: 0 }, { ...png, size: 1.5 }, { ...png, size: png.size + 1 },
    { ...png, mimeType: 'image/svg+xml' }, { ...png, mimeType: 'image/jpeg' },
    { ...png, data: 'https://example.com/image.png' }, { ...png, data: `data:image/png;base64,${png.data}` },
    { ...png, data: png.data + '\n' }, { ...png, data: png.data.replace(/=$/, 'A') },
    { ...png, data: Buffer.alloc(png.size).toString('base64') }, { ...png, text: 'mixed' },
    { ...text(), data: 'a' }, { ...text(), mimeType: 'text/html' }, { ...text(), size: 1 },
    { ...text(), text: '\u0000'.repeat(5) }, { ...text(), text: '\ud800test' },
    { ...binary('image/jpeg'), data: '/9j/4B==' }, // Non-zero unused base64 bits.
  ]) assert.throws(() => validateAttachments([record]), undefined, JSON.stringify(record)?.slice(0, 120));
  assert.throws(() => validateAttachments({}), /array/);
});
test('message count, duplicate IDs, per-type and aggregate boundaries are enforced', () => {
  const large = binary('image/png', MAX_ATTACHMENT_BYTES);
  assert.equal(validateAttachments([large])[0].size, MAX_ATTACHMENT_BYTES);
  assert.equal(validateAttachments([large, { ...large, id: 'second' }]).length, 2);
  assert.throws(() => validateAttachments([large, { ...large, id: 'second' }, text()]), /8 MiB/);
  assert.throws(() => validateAttachments([binary('image/png', MAX_ATTACHMENT_BYTES + 1)]), /4 MiB/);
  assert.equal(validateAttachments([text('a'.repeat(MAX_TEXT_ATTACHMENT_BYTES))])[0].size, MAX_TEXT_ATTACHMENT_BYTES);
  assert.throws(() => validateAttachments([text('a'.repeat(MAX_TEXT_ATTACHMENT_BYTES + 1))]), /512 KiB/);
  assert.throws(() => validateAttachments([text(), text()]), /Duplicate/);
  assert.throws(() => validateAttachments(Array.from({ length: 5 }, (_, i) => text('a', `id${i}`))), /at most 4/);
});
test('maximum-size browser file reads round-trip without quadratic base64 construction', async () => {
  const expected = binary('image/png', MAX_ATTACHMENT_BYTES);
  const file = new File([Buffer.from(expected.data, 'base64')], 'large.png', { type: 'image/png' });
  const record = await readAttachment(file);
  assert.equal(record.size, MAX_ATTACHMENT_BYTES); assert.equal(record.data, expected.data);
  assert.equal(validateAttachments([record])[0].data, expected.data);
});
test('safe records and history parts are snapshots stripping unknown properties', () => {
  const record = { ...text(), secret: 'strip-me' };
  const validated = validateAttachments([record]); const parts = attachmentsToParts([record]);
  record.text = 'changed'; record.name = 'changed';
  assert.deepEqual(validated[0], text()); assert.deepEqual(parts, [{ prismAttachment: text() }]);
  assert.equal(formatAttachmentSize(0), '0 B'); assert.equal(formatAttachmentSize(512), '512 B');
  assert.equal(formatAttachmentSize(1536), '1.5 KiB'); assert.equal(formatAttachmentSize(4 * 1024 ** 2), '4 MiB');
  assert.throws(() => formatAttachmentSize(-1));
});
