import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  parseCiteRanges,
  normalizeCiteLines,
  isValidComparison,
  coerceQuestion,
  hasPresentationIssue,
  validateQuestion,
  normalizeFollowUps,
  normalizeQuestionLegacy,
  MAX_CITE_SPAN,
  Question,
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

test('normalizeCiteLines:数字范围后的中文说明被丢进确定性规范化,散文不猜造', () => {
  assert.equal(normalizeCiteLines('204-239（实际为核心实现）'), '204-239');
  assert.equal(normalizeCiteLines('12-18, 25-31（见说明）'), '12-18,25-31');
  assert.equal(normalizeCiteLines('SERVER_MANAGED 定义及用途'), null);
  assert.equal(normalizeCiteLines('请查看相关代码'), null);
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

test('validateQuestion:拒绝不可背诵的占位符和模糊定位', () => {
  const q = {
    category: '安全', difficulty: '基础', question: '请解释 X 和 Y 在该项目中的关系', 考察点: '输入校验',
    答案要点: ['原文未完整展示，需补充后续逻辑', '正常要点', '正常要点二'],
    代码依据: [{ file: 'src/a.ts', lines: '1-2' }], 追问链: [{ 问题: 'server.ts:143附近做什么？', 参考要点: '标准答案方向说明内容' }, { 问题: '如何修复？', 参考要点: '标准答案方向说明内容' }], 加分回答: '正常', 常见错误回答: '正常',
  };
  const errors = validateQuestion(q, files);
  assert.ok(errors.some((e) => /不可背诵/.test(e)));
  assert.equal(hasPresentationIssue('第 70-140 行段内处理'), true);
  assert.equal(hasPresentationIssue('读取请求后校验 title 字段'), false);
  // 0.8.1:证据元话语型答案(讨论证据,不回答问题)确定性拒绝
  assert.equal(hasPresentationIssue('update 方法体未被任何引用行覆盖,其内部步骤无法从现有代码证实'), true);
  assert.equal(hasPresentationIssue('这属于未经验证的推断,不能作为答案陈述'), true);
  assert.equal(hasPresentationIssue('该字段当前未被任何路由使用,属于冗余配置'), false); // 正常的代码事实陈述不受影响
});

/* ---------------- 0.8.0 题库可背诵性契约 ---------------- */

const okFollowUps = [
  { 问题: '并发窗口在哪里?', 参考要点: '两个未加锁的读改写之间,典型在 take 与统计计数处。' },
  { 问题: '如何改成无锁?', 参考要点: '用原子计数或代际版本号,重试循环上限三次后降级。' },
];

test('0.8.0 追问链:旧 string 形态归一为 FollowUp;新形态保留参考要点', () => {
  assert.deepStrictEqual(normalizeFollowUps(['旧追问']), [{ 问题: '旧追问', 参考要点: '' }]);
  const legacy = normalizeQuestionLegacy({
    id: 'Q01', category: '核心模块深挖', difficulty: '进阶', question: 'q', 考察点: 'k',
    答案要点: ['a'], 代码依据: [{ file: 'src/a.ts', lines: '1-2' }],
    追问链: ['旧追问一', '旧追问二'] as unknown as Question['追问链'],
    加分回答: 'g', 常见错误回答: 'w',
  });
  assert.deepStrictEqual(legacy.追问链, [{ 问题: '旧追问一', 参考要点: '' }, { 问题: '旧追问二', 参考要点: '' }]);
  assert.strictEqual(legacy.难度分, 6); // 进阶 → 兜底 6
  const modern = normalizeFollowUps([{ 问题: 'a', 参考要点: 'b' }, { question: 'c', points: 'd' }]);
  assert.deepStrictEqual(modern, [{ 问题: 'a', 参考要点: 'b' }, { 问题: 'c', 参考要点: 'd' }]);
});

test('0.8.0 追问链:开放式追问缺参考要点 → 确定性报错(只问不答不合格)', () => {
  const q = coerceQuestion(
    { question: '这是一个足够长的问题吗是的', 考察点: 'x', 答案要点: ['a', 'b', 'c'],
      代码依据: [{ file: 'src/a.ts', lines: '1-9' }], 追问链: ['只问不答一', '只问不答二'],
      加分回答: 'g', 常见错误回答: 'w' },
    'Q01', '架构设计与分层', '基础', '项目整体'
  );
  const errors = validateQuestion(q, files);
  assert.ok(errors.every((e) => !/追问链 至少 2 条/.test(e)), '归一化后条数应达标');
  assert.strictEqual(errors.filter((e) => e.includes('缺少参考要点')).length, 2, errors.join(';'));

  const good = { ...q, 追问链: okFollowUps };
  const goodErrors = validateQuestion(good, files);
  assert.ok(goodErrors.every((e) => !/参考要点/.test(e)), goodErrors.join(';'));
});

test('0.8.0 难度分:模型值钳制 1-10;缺失时按标签确定性兜底', () => {
  assert.strictEqual(coerceQuestion({ 难度分: 99 }, 'Q1', 'x', '进阶', 't').难度分, 10);
  assert.strictEqual(coerceQuestion({ 难度分: 0 }, 'Q1', 'x', '刁钻', 't').难度分, 1);
  assert.strictEqual(coerceQuestion({}, 'Q1', 'x', '基础', 't').难度分, 3);
  assert.strictEqual(coerceQuestion({}, 'Q1', 'x', '进阶', 't').难度分, 6);
  assert.strictEqual(coerceQuestion({}, 'Q1', 'x', '刁钻', 't').难度分, 8);
  const bad = { category: '安全', difficulty: '基础', question: '足够长的问题文本', 考察点: 'k', 答案要点: ['a'], 代码依据: [{ file: 'src/a.ts', lines: '1-2' }], 追问链: okFollowUps, 加分回答: 'g', 常见错误回答: 'w', 难度分: 42 };
  assert.ok(validateQuestion(bad, files).some((e) => e.includes('难度分')));
});

test('0.8.0 行号精度:单条引用跨度 >80 行(文件级引用)被拒,精确区间通过', () => {
  const wide = { category: '安全', difficulty: '基础', question: '足够长的问题文本', 考察点: 'k', 答案要点: ['a'], 代码依据: [{ file: 'src/a.ts', lines: `1-${MAX_CITE_SPAN + 1}` }], 追问链: okFollowUps, 加分回答: 'g', 常见错误回答: 'w' };
  const wideErrors = validateQuestion(wide, files);
  assert.ok(wideErrors.some((e) => e.includes(`超过 ${MAX_CITE_SPAN} 行`)), wideErrors.join(';'));

  const precise = { ...wide, 代码依据: [{ file: 'src/a.ts', lines: `1-${MAX_CITE_SPAN}` }] };
  assert.ok(validateQuestion(precise, files).every((e) => !/超过/.test(e)));

  const multi = { ...wide, 代码依据: [{ file: 'src/a.ts', lines: '1-40,60-90' }] };
  assert.ok(validateQuestion(multi, files).every((e) => !/超过/.test(e)), '多段各自 ≤80 行应通过');
});
