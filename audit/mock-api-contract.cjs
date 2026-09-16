/* 本地 OpenAI-compatible mock 合约测试，不使用真实密钥或付费 API。 */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { DeepSeekClient, DeepSeekError } = require('../dist/core/deepseek');

async function main() {
  const counts = { normal: 0, rate: 0, server: 0, auth: 0, truncated: 0, reasoning: 0, empty: 0, malformed: 0, timeout: 0, fallback: 0, partial: 0 };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const kind = body.includes('rate') ? 'rate' : body.includes('server') ? 'server' : body.includes('auth') ? 'auth' : body.includes('truncated') ? 'truncated' : body.includes('reasoning') ? 'reasoning' : body.includes('empty') ? 'empty' : body.includes('malformed') ? 'malformed' : body.includes('timeout') ? 'timeout' : body.includes('fallback') ? 'fallback' : body.includes('partial') ? 'partial' : 'normal';
    counts[kind]++;
    if (kind === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad mock key' } })); return; }
    if (kind === 'rate' && counts.rate === 1) { res.writeHead(429, { 'retry-after': '0.001' }); res.end('rate limited'); return; }
    if (kind === 'server' && counts.server === 1) { res.writeHead(500, { 'retry-after': '0.001' }); res.end('temporary'); return; }
    if (kind === 'fallback' && counts.fallback === 1) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'model not found' } })); return; }
    if (kind === 'timeout') { await new Promise((resolve) => setTimeout(resolve, 100)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '{"late":true}' }, finish_reason: 'stop' }] })); return; }
    if (kind === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not-json'); return; }
    if (kind === 'partial' && body.includes('partial-fail')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not-json'); return; }
    const truncated = kind === 'truncated' && counts.truncated === 1;
    const content = truncated ? '{"partial":' : kind === 'reasoning' ? '' : kind === 'empty' ? '' : '{"ok":true}';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content, ...(kind === 'reasoning' ? { reasoning_content: '{"from":"reasoning"}' } : {}) }, finish_reason: truncated ? 'length' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cfg = { apiKey: 'mock-key', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'mock', timeoutMs: 10000, sources: { apiKey: 'mock', baseUrl: 'mock', model: 'mock' } };
  const call = (text, opts = {}) => new DeepSeekClient(cfg).chat([{ role: 'user', content: text }], { maxTokens: 100, hardMaxTokens: 400, retries: 2, ...opts });
  const callWith = (model, text, opts = {}) => new DeepSeekClient({ ...cfg, model }).chat([{ role: 'user', content: text }], { maxTokens: 100, hardMaxTokens: 400, retries: 2, ...opts });
  assert.equal(await call('normal'), '{"ok":true}');
  assert.equal(await call('rate'), '{"ok":true}');
  assert.equal(await call('server'), '{"ok":true}');
  await assert.rejects(call('auth'), (err) => err instanceof DeepSeekError && err.status === 401);
  assert.equal(await call('truncated'), '{"ok":true}');
  await assert.rejects(call('reasoning', { retries: 0 }), (err) => err instanceof DeepSeekError && err.code === 'empty');
  await assert.rejects(call('empty', { retries: 0 }), (err) => err instanceof DeepSeekError && err.code === 'empty');
  await assert.rejects(call('malformed', { retries: 0 }), (err) => err instanceof DeepSeekError && err.code === 'invalid-json');
  await assert.rejects(call('timeout', { timeoutMs: 20, retries: 0, policy: { timeout: 20 } }), (err) => err instanceof DeepSeekError && err.code === 'timeout');
  assert.equal(await callWith('deepseek-v4-pro', 'fallback'), '{"ok":true}');
  const partial = await call('partial-ok');
  assert.equal(partial, '{"ok":true}', '部分成功的前一批结果应保持可用');
  await assert.rejects(call('partial-fail', { retries: 0 }), (err) => err instanceof DeepSeekError && err.code === 'invalid-json', '独立失败不应改写前一批结果');
  assert.deepEqual(counts, { normal: 1, rate: 2, server: 2, auth: 1, truncated: 2, reasoning: 1, empty: 1, malformed: 1, timeout: 1, fallback: 2, partial: 2 });
  console.log(JSON.stringify({ passed: true, counts, cases: ['normal JSON', 'reasoning_content rejected', 'empty content', 'malformed JSON', 'timeout + AbortSignal', '429 + Retry-After', '500 + Retry-After', '401 no retry', 'model-not-found fallback', 'finish_reason=length request-local expansion', 'partial success isolation'] }, null, 2));
  await new Promise((resolve) => server.close(resolve));
}

main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
