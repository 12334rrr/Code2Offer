import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { diagnoseDeepSeek } from '../core/diagnostics';

const cfg = { apiKey: 'sk-not-real', baseUrl: 'https://example.invalid', model: 'test-model', timeoutMs: 1000, sources: { apiKey: 'test-env', baseUrl: 'test-env', model: 'test-env' } };

test('diagnoseDeepSeek:使用最小 JSON 请求且不泄露密钥', async () => {
  const original = globalThis.fetch;
  let body = '';
  globalThis.fetch = async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await diagnoseDeepSeek(cfg);
    assert.equal(result.ok, true);
    assert.equal(result.steps[1].ok, true);
    assert.match(body, /Set the ok field to true/);
    assert.ok(!JSON.stringify(result).includes(cfg.apiKey));
  } finally { globalThis.fetch = original; }
});
