import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCatboxURL, requestCatboxUpload, CATBOX_API_URL, CATBOX_SITE_URL, CATBOX_MAX_FILE_BYTES } from '../catbox.js';

test('Catbox public endpoints and decimal file limit are fixed', () => {
  assert.equal(CATBOX_API_URL, 'https://catbox.moe/user/api.php');
  assert.equal(CATBOX_SITE_URL, 'https://catbox.moe/');
  assert.equal(CATBOX_MAX_FILE_BYTES, 200000000);
});

for (const [value, expected] of [
  ['https://files.catbox.moe/abc123.png', 'https://files.catbox.moe/abc123.png'],
  ['https://files.catbox.moe/abc123.exe', 'https://files.catbox.moe/abc123.exe'],
  ['https://files.catbox.moe/AbC_12-9.tar.gz', 'https://files.catbox.moe/AbC_12-9.tar.gz'],
  ['https://files.catbox.moe/abc123', 'https://files.catbox.moe/abc123'],
  ['  https://files.catbox.moe/abc123.jpg\r\n', 'https://files.catbox.moe/abc123.jpg'],
  ['HTTPS://FILES.CATBOX.MOE/ABC123.PNG', 'https://files.catbox.moe/ABC123.PNG'],
  [`https://files.catbox.moe/${'a'.repeat(255)}`, `https://files.catbox.moe/${'a'.repeat(255)}`],
]) {
  test(`Catbox URL validator accepts only a safe single file path: ${value.slice(0, 80)}`, () => {
    assert.equal(validateCatboxURL(value), expected);
  });
}

for (const value of [
  undefined, null, false, 0, {}, [],
  '', 'files.catbox.moe/abc123.png', '//files.catbox.moe/abc123.png',
  'http://files.catbox.moe/abc123.png', 'javascript:alert(1)', 'data:text/html,hello',
  'https://catbox.moe/abc123.png', 'https://files.catbox.moe.evil.example/abc123.png',
  'https://evil.example/files.catbox.moe/abc123.png',
  'https://files.catbox.moe@evil.example/abc123.png',
  'https://user:private-pass@files.catbox.moe/abc123.png',
  'https://files.catbox.moe:443/abc123.png', 'https://files.catbox.moe:444/abc123.png',
  'https://files.catbox.moe/', 'https://files.catbox.moe/abc/def.png',
  'https://files.catbox.moe/abc123.png/', 'https://files.catbox.moe//abc123.png',
  'https://files.catbox.moe/../abc123.png', 'https://files.catbox.moe/a/../abc123.png',
  'https://files.catbox.moe/.', 'https://files.catbox.moe/..',
  'https://files.catbox.moe/%61bc123.png', 'https://files.catbox.moe/abc%2F123.png',
  'https://files.catbox.moe/abc123.png?', 'https://files.catbox.moe/abc123.png?token=private-token',
  'https://files.catbox.moe/abc123.png#', 'https://files.catbox.moe/abc123.png#private-fragment',
  'https://files.catbox.moe/has space.png', 'https://files.catbox.moe/abc\ndef.png',
  'https://files.catbox.moe/ümlaut.png', 'https://files.catbox.moe/<script>.png',
  'https://files.catbox.moe/abc\\def.png', `https://files.catbox.moe/${'a'.repeat(256)}`,
  '<html><script>private-script</script></html>',
]) {
  test(`Catbox URL validator rejects untrusted URL shape ${String(JSON.stringify(value)).slice(0, 95)}`, () => {
    assert.throws(() => validateCatboxURL(value), error => {
      assert.match(error.message, /Use a public file URL/);
      assert.doesNotMatch(error.message, /private-pass|private-token|private-fragment|private-script|evil\.example/);
      return true;
    });
  });
}

test('module import is DOM-free and calling the dialog outside a browser fails helpfully', async () => {
  await assert.rejects(requestCatboxUpload(), /requires the browser upload dialog/);
});
