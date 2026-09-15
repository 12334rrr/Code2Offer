// 断言式测试:node tests/store.test.js
'use strict';

const assert = require('assert');
const { TaskStore } = require('../store');
const { LRUCache } = require('../cache');
const { TokenBucketLimiter } = require('../ratelimit');
const { validateTaskInput } = require('../validate');

function testStoreIndexes() {
  const s = new TaskStore();
  const a = s.create({ title: 'a', status: 'todo' });
  s.create({ title: 'b', status: 'done' });
  assert.strictEqual(s.list({ status: 'todo' }).total, 1);
  s.update(a.id, { status: 'doing' });
  assert.strictEqual(s.list({ status: 'todo' }).total, 0, '旧索引应被清理');
  assert.strictEqual(s.list({ status: 'doing' }).total, 1);
  assert.ok(s.remove(a.id));
  assert.strictEqual(s.count(), 1);
}

function testLRU() {
  const c = new LRUCache(2, 60_000);
  c.set('k1', 1);
  c.set('k2', 2);
  assert.strictEqual(c.get('k1'), 1); // k1 变为最新
  c.set('k3', 3); // 淘汰 k2
  assert.strictEqual(c.get('k2'), undefined);
  assert.strictEqual(c.get('k1'), 1);
  assert.strictEqual(c.get('k3'), 3);
  assert.ok(c.stats().hitRate > 0.5);
}

function testLRUTTL() {
  const c = new LRUCache(10, 5); // ttl=5ms
  c.set('k', 'v');
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.strictEqual(c.get('k'), undefined, '过期后应未命中');
      resolve();
    }, 20);
  });
}

function testRateLimiter() {
  const l = new TokenBucketLimiter(2, 1);
  const t0 = 1_000_000;
  assert.ok(l.take('ip1', t0).allowed);
  assert.ok(l.take('ip1', t0).allowed);
  const blocked = l.take('ip1', t0);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // 补充 1 秒后恢复 1 个令牌
  assert.ok(l.take('ip1', t0 + 1000).allowed);
  // 不同 IP 互不影响
  assert.ok(l.take('ip2', t0).allowed);
}

function testValidate() {
  assert.deepStrictEqual(validateTaskInput({ title: 'ok', status: 'todo' }), []);
  assert.ok(validateTaskInput({}).length > 0, '缺 title 应报错');
  assert.ok(validateTaskInput({ title: 'x', status: 'bad' }).length > 0);
  assert.ok(validateTaskInput({ title: 'x', dueAt: 'not-a-date' }).length > 0);
  assert.deepStrictEqual(validateTaskInput({ status: 'doing' }, true).length, 0, 'partial 模式可不带 title');
}

(async () => {
  testStoreIndexes();
  testLRU();
  testRateLimiter();
  testValidate();
  await testLRUTTL();
  console.log('全部测试通过 ✓');
})().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
