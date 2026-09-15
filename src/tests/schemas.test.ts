import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  parseCiteRanges,
  isValidComparison,
  coerceQuestion,
  validateQuestion,
} from '../core/schemas';

const files = new Set(['src/a.ts', 'src/b.ts']);

test('parseCiteRanges:合法单行/区间/多段', () => {
  assert.deepStrictEqual(parseCiteRanges('12'), [[12, 12]]);
  assert.deepStrictEqual(parseCiteRanges('12-34'), [[12, 34]]);
  assert.deepStrictEqual(parseCiteRanges('103,107-127'), [
    [103, 103],
    [107, 127],
  ]);
});

test('parseCiteRanges:非法输入返回 null', () => {
  assert.strictEqual(parseCiteRanges(''), null);
  assert.strictEqual(parseCiteRanges('abc'), null);
  assert.strictEqual(parseCiteRanges('0-5'), null); // start < 1
  assert.strictEqual(parseCiteRanges('10-3'), null); // end < start
  assert.strictEqual(parseCiteRanges('12-'), null);
});

const goodCmp = {
  候选方案: ['SQLite', 'PostgreSQL'],
  维度: ['性能', '复杂度', '运维'],
  对比表: [
    ['SQLite', '高', '低', '低'],
    ['PostgreSQL', '中', '中', '中'],
  ],
  结论: '单机嵌入式场景选 SQLite;高并发多写场景应反过来选 PostgreSQL。',
};

test('isValidComparison:合格对比块通过', () => {
  assert.strictEqual(isValidComparison(goodCmp), true);
});

test('isValidComparison:空对象/空行/非矩形表不再通过', () => {
  assert.strictEqual(isValidComparison({}), false);
  assert.strictEqual(isValidComparison({ ...goodCmp, 对比表: [[], []] }), false); // 审计复现过的空行
  assert.strictEqual(isValidComparison({ ...goodCmp, 对比表: [['SQLite', '高'], ['PostgreSQL', '中']] }), false); // 非矩形
  assert.strictEqual(isValidComparison({ ...goodCmp, 对比表: [['SQLite', '高', '低', ''], ['PostgreSQL', '中', '中', '中']] }), false); // 空单元格
  assert.strictEqual(isValidComparison({ ...goodCmp, 候选方案: ['only-one'] }), false);
  assert.strictEqual(isValidComparison({ ...goodCmp, 维度: ['性能', '复杂度'] }), false); // <3
});

test('coerceQuestion:类别/难度/目标一律以题位为准,不信模型回显', () => {
  const q = coerceQuestion(
    { category: '安全性', difficulty: '刁钻', question: '为什么这样设计缓存?', 考察点: '缓存',
      答案要点: ['a', '', 'b'], 代码依据: [{ file: 'src/a.ts', lines: '1-9' }], 追问链: ['x', 'y'],
      加分回答: 'g', 常见错误回答: 'w' },
    'Q01',
    '技术选型对比',
    '基础',
    '数据存储:SQLite'
  );
  assert.strictEqual(q.category, '技术选型对比'); // 模型漂移的类别被强制纠正
  assert.strictEqual(q.difficulty, '基础');
  assert.deepStrictEqual(q.答案要点, ['a', 'b']); // 空条目被清理
});

test('validateQuestion:引用文件不存在报错', () => {
  const q = coerceQuestion(
    { question: '这是一个足够长的问题吗是的', 考察点: 'x', 答案要点: ['a', 'b', 'c'],
      代码依据: [{ file: 'src/nope.ts', lines: '1-9' }], 追问链: ['x', 'y'],
      加分回答: 'g', 常见错误回答: 'w' },
    'Q01', '架构设计与分层', '基础', '项目整体'
  );
  const errors = validateQuestion(q, files);
  assert.ok(errors.some((e) => e.includes('不存在')), errors.join(';'));
});

test('validateQuestion:技术选型对比类缺合格对比块报错', () => {
  const q = coerceQuestion(
    { question: '为什么选 SQLite 而不是 PostgreSQL?', 考察点: '选型',
      答案要点: ['a', 'b', 'c'], 代码依据: [{ file: 'src/a.ts', lines: '1-9' }], 追问链: ['x', 'y'],
      加分回答: 'g', 常见错误回答: 'w' },
    'Q01', '技术选型对比', '基础', '数据存储:SQLite'
  );
  const errors = validateQuestion(q, files);
  assert.ok(errors.some((e) => e.includes('对比')), errors.join(';'));
});
