import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels, generateReply, normalizeEndpoint } from '../api.js';

const key = 'private-diagnostic-key';
const unauthorized = (json = true) => new Response(json ? JSON.stringify({ error: { message: `Invalid credential ${key}` } }) : '<html>Unauthorized</html>', { status: 401, headers: { 'Content-Type': json ? 'application/json' : 'text/html' } });

for (const protocol of ['gemini', 'openai']) {
  for (const json of [true, false]) {
    test(`${protocol} ${json ? 'JSON' : 'HTML'} 401 explains discovery authentication without exposing credentials`, async () => {
      await assert.rejects(fetchModels({ protocol, endpoint: protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://generativelanguage.googleapis.com/v1beta', key, fetchImpl: async () => unauthorized(json) }), error => {
        assert.match(error.message, /API error 401/);
        assert.match(error.message, /Authentication rejected/);
        assert.match(error.message, new RegExp(protocol === 'gemini' ? 'Gemini' : 'OpenAI-compatible'));
        assert.match(error.message, /model discovery/);
        assert.match(error.message, /Switching API format clears the saved key/);
        assert.ok(!error.message.includes(key));
        if (json) assert.match(error.message, /\[redacted\]/);
        return true;
      });
    });
  }
}

test('keyless OpenAI 401 identifies the missing key rather than claiming a key was sent', async () => {
  await assert.rejects(fetchModels({ protocol: 'openai', endpoint: 'http://localhost:1234/v1', key: '', fetchImpl: async (_, init) => {
    assert.equal(init.headers.Authorization, undefined);
    return unauthorized();
  } }), /No API key was sent/);
});

test('OpenAI chat 401 distinguishes generation from discovery', async () => {
  await assert.rejects(generateReply({ protocol: 'openai', endpoint: 'https://api.openai.com/v1', model: 'org/chat', key, contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], fetchImpl: async () => unauthorized(false) }), /API error 401.*chat generation/);
});

test('local endpoint validation matches CSP without broadening plain HTTP access', () => {
  assert.equal(normalizeEndpoint('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(normalizeEndpoint('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  assert.throws(() => normalizeEndpoint('http://[::1]:1234/v1'), /localhost:PORT.*127\.0\.0\.1:PORT/);
  assert.throws(() => normalizeEndpoint('http://192.168.1.5:1234/v1'), /HTTPS/);
  assert.equal(normalizeEndpoint('https://[::1]:1234/v1'), 'https://[::1]:1234/v1');
});
