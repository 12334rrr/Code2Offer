import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DeepSeekClient, DeepSeekError } from '../core/deepseek';

const config = {
  apiKey: 'sk-test-not-a-real-key',
  baseUrl: 'https://example.invalid',
  model: 'deepseek-test',
  timeoutMs: 1000,
  sources: { apiKey: 'test', baseUrl: 'test', model: 'test' },
};

function response(content: string, finish = 'stop', status = 200, headers: Record<string, string> = {}): Response {
  return new Response(
    status === 200
      ? JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      : JSON.stringify({ error: { message: content } }),
    { status, headers: { 'content-type': 'application/json', ...headers } }
  );
}

function installFetch(fn: typeof globalThis.fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = original; };
}

test('DeepSeekClient:截断扩容只影响当前逻辑请求且不缓存半截响应', async () => {
  const maxTokens: number[] = [];
  let call = 0;
  const restore = installFetch(async (_url, init) => {
    maxTokens.push(Number(JSON.parse(String(init?.body)).max_tokens));
    call++;
    return call === 1 ? response('{"half":', 'length') : response('{"ok":true}');
  });
  try {
    const client = new DeepSeekClient(config);
    assert.equal(await client.chat([{ role: 'user', content: 'one' }], { requestType: 'stage2-question', maxTokens: 100, hardMaxTokens: 400 }), '{"ok":true}');
    assert.equal(await client.chat([{ role: 'user', content: 'two' }], { requestType: 'stage2-question', maxTokens: 100, hardMaxTokens: 400 }), '{"ok":true}');
    assert.deepEqual(maxTokens, [100, 200, 100]);
    assert.equal(client.usage().truncations, 1);
  } finally { restore(); }
});

test('DeepSeekClient:到达单请求硬上限不接受非空截断 JSON', async () => {
  let calls = 0;
  const restore = installFetch(async () => { calls++; return response('{"half":', 'length'); });
  try {
    const client = new DeepSeekClient(config);
    await assert.rejects(
      client.chat([{ role: 'user', content: 'x' }], { requestType: 'stage2-question', maxTokens: 100, hardMaxTokens: 200, retries: 3 }),
      (err: unknown) => err instanceof DeepSeekError && err.code === 'truncated'
    );
    assert.equal(calls, 2, '只扩容当前请求,到硬上限后不应把截断响应当作普通网络错误反复请求');
  } finally { restore(); }
});

test('DeepSeekClient:401 立即失败且错误信息不泄露 API Key', async () => {
  let calls = 0;
  const restore = installFetch(async () => { calls++; return response(`bad key ${config.apiKey}`, 'stop', 401); });
  try {
    const client = new DeepSeekClient(config);
    await assert.rejects(client.chat([{ role: 'user', content: 'x' }], { retries: 3 }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /401/);
      assert.ok(!err.message.includes(config.apiKey));
      return true;
    });
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('DeepSeekClient:429 和 5xx 按 Retry-After 退避重试', async () => {
  let calls = 0;
  const restore = installFetch(async () => {
    calls++;
    if (calls === 1) return response('rate limited', 'stop', 429, { 'retry-after': '0.001' });
    if (calls === 2) return response('temporary', 'stop', 503, { 'retry-after': '0.001' });
    return response('{"ok":true}');
  });
  try {
    const client = new DeepSeekClient(config);
    assert.equal(await client.chat([{ role: 'user', content: 'x' }], { requestType: 'stage3-verify', retries: 3 }), '{"ok":true}');
    assert.equal(calls, 3);
    assert.equal(client.usage().retries, 2);
  } finally { restore(); }
});

test('DeepSeekClient:AbortSignal 立即取消正在进行的 fetch', async () => {
  const ctrl = new AbortController();
  const restore = installFetch(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  try {
    const client = new DeepSeekClient(config);
    const pending = client.chat([{ role: 'user', content: 'x' }], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    await assert.rejects(pending, (err: unknown) => err instanceof DeepSeekError && err.code === 'cancelled');
  } finally { restore(); }
});

test('DeepSeekClient:响应头已到但正文挂起时，总超时仍会取消读取并释放 reader', async () => {
  let cancelled = false;
  const restore = installFetch(async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => { cancelled = true; },
    });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  });
  try {
    const client = new DeepSeekClient(config);
    const started = Date.now();
    await assert.rejects(
      client.chat([{ role: 'user', content: 'x' }], { retries: 0, policy: { timeout: 25 } }),
      (err: unknown) => err instanceof DeepSeekError && err.code === 'timeout'
    );
    assert.ok(Date.now() - started < 500, '正文挂起不能越过请求总超时');
    assert.equal(cancelled, true, '超时后应取消响应 reader');
  } finally { restore(); }
});

test('DeepSeekClient:超过响应体上限立即失败且不重试', async () => {
  let calls = 0;
  const restore = installFetch(async () => {
    calls++;
    return response('{"ok":true}', 'stop', 200, { 'content-length': String(9 * 1024 * 1024) });
  });
  try {
    const client = new DeepSeekClient(config);
    await assert.rejects(
      client.chat([{ role: 'user', content: 'x' }], { retries: 2 }),
      (err: unknown) => err instanceof DeepSeekError && err.code === 'response-too-large'
    );
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('DeepSeekClient:网络错误保留脱敏后的 Node 原因码', async () => {
  const restore = installFetch(async () => {
    const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    throw Object.assign(new TypeError('fetch failed'), { cause });
  });
  try {
    const client = new DeepSeekClient(config);
    await assert.rejects(
      client.chat([{ role: 'user', content: 'x' }], { retries: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof DeepSeekError);
        assert.match(err.message, /ECONNREFUSED/);
        assert.match(err.message, /端口拒绝连接/);
        assert.match(err.message, /example\.invalid/);
        assert.ok(!err.message.includes(config.apiKey));
        return true;
      }
    );
  } finally { restore(); }
});

test('DeepSeekClient:推理型模型的结构化请求路由到 chat,叙述请求仍使用原模型', async () => {
  const models: string[] = [];
  const restore = installFetch(async (_url, init) => {
    models.push(String(JSON.parse(String(init?.body)).model));
    return response('{"ok":true}');
  });
  try {
    const client = new DeepSeekClient({ ...config, model: 'deepseek-flash' });
    await client.chat([{ role: 'user', content: 'JSON' }], { requestType: 'stage1-module' });
    await client.chat([{ role: 'user', content: 'markdown' }], { requestType: 'stage5-narrative' });
    assert.deepEqual(models, ['deepseek-chat', 'deepseek-flash']);
  } finally { restore(); }
});

test('DeepSeekClient:推理模型叙述请求一旦截断立即切 chat,不翻倍重复 reasoning', async () => {
  const models: string[] = [];
  const maxTokens: number[] = [];
  const restore = installFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(String(body.model));
    maxTokens.push(Number(body.max_tokens));
    return models.length === 1 ? response('半截叙述', 'length') : response('完整叙述');
  });
  try {
    const client = new DeepSeekClient({ ...config, model: 'deepseek-flash' });
    assert.equal(await client.chat([{ role: 'user', content: 'markdown' }], { requestType: 'stage5-narrative', maxTokens: 100, hardMaxTokens: 400 }), '完整叙述');
    assert.deepEqual(models, ['deepseek-flash', 'deepseek-chat']);
    assert.deepEqual(maxTokens, [100, 100]);
  } finally { restore(); }
});

test('DeepSeekClient:只有 reasoning_content 不是可用面试材料', async () => {
  const restore = installFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: '{"internal":"trace"}' }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } }));
  try {
    const client = new DeepSeekClient(config);
    await assert.rejects(
      client.chat([{ role: 'user', content: 'x' }], { retries: 0 }),
      (err: unknown) => err instanceof DeepSeekError && err.code === 'empty' && /reasoning_content/.test(err.message)
    );
  } finally { restore(); }
});
