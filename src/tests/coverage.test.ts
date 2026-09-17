import { test } from 'node:test';
import * as assert from 'node:assert';
import { CATEGORIES, totalQuota, trimToQuotaDetailed, computeDeficitSlots, buildSlots, questionTargetFor, categoriesFor } from '../core/coverage';
import { Question } from '../core/schemas';

const mkQ = (id: string, category: string, difficulty: Question['difficulty']): Question => ({
  id,
  category,
  difficulty,
  question: `问题 ${id}`,
  考察点: 'x',
  答案要点: ['a', 'b', 'c'],
  代码依据: [{ file: 'a.ts', lines: '1-9' }],
  追问链: [{ 问题: 'x', 参考要点: '参考要点说明内容' }, { 问题: 'y', 参考要点: '参考要点说明内容' }],
  加分回答: 'g',
  常见错误回答: 'w',
});

const emptyCards: never[] = [];

test('配额合计恒为 100', () => {
  assert.strictEqual(totalQuota(), 100);
  const sum = CATEGORIES.reduce((s, c) => {
    const d = c.difficulties.reduce((x, y) => x + y.count, 0);
    assert.strictEqual(d, c.quota, `类别 ${c.name} 的难度配额与类别配额不一致`);
    return s + c.quota;
  }, 0);
  assert.strictEqual(sum, 100);
});

test('trimToQuotaDetailed:未知类别被裁掉且计数透明', () => {
  const qs = [
    mkQ('Q1', '架构设计与分层', '基础'),
    mkQ('Q2', '历史遗留类别', '基础'), // 不在矩阵内
  ];
  const { keep, droppedUnknownCategory } = trimToQuotaDetailed(qs);
  assert.strictEqual(keep.length, 1);
  assert.strictEqual(droppedUnknownCategory, 1);
});

test('computeDeficitSlots:按类别×难度计算缺口,未知类别不占配额', () => {
  // 架构设计与分层|基础 配额 3,只给 1 题 → 缺 2
  const existing = [mkQ('Q1', '架构设计与分层', '基础')];
  const deficit = computeDeficitSlots(existing, emptyCards);
  const archBasic = deficit.filter((s) => s.category === '架构设计与分层' && s.difficulty === '基础');
  assert.strictEqual(archBasic.length, 2);
  // 未知类别的题不占用任何配额(会被 trim 裁掉)
  const withUnknown = [mkQ('Q1', '架构设计与分层', '基础'), mkQ('Q2', '不存在类别', '基础')];
  const deficit2 = computeDeficitSlots(withUnknown, emptyCards);
  assert.strictEqual(
    deficit2.filter((s) => s.category === '架构设计与分层' && s.difficulty === '基础').length,
    2
  );
});

test('computeDeficitSlots:满配额时无缺口', () => {
  const arch = CATEGORIES.find((c) => c.name === '架构设计与分层')!;
  const qs: Question[] = [];
  let n = 1;
  for (const d of arch.difficulties) {
    for (let i = 0; i < d.count; i++) qs.push(mkQ(`Q${n++}`, arch.name, d.level));
  }
  const deficit = computeDeficitSlots(qs, emptyCards).filter((s) => s.category === arch.name);
  assert.strictEqual(deficit.length, 0);
});

/* ---------------- 0.8.2 自适应题量 ---------------- */

test('questionTargetFor:模式默认与 --questions 覆盖钳制', () => {
  assert.strictEqual(questionTargetFor('economy'), 30);
  assert.strictEqual(questionTargetFor('balanced'), 60);
  assert.strictEqual(questionTargetFor('deep'), 80);
  assert.strictEqual(questionTargetFor(undefined), 100);
  assert.strictEqual(questionTargetFor('deep', 15), 15);
  assert.strictEqual(questionTargetFor('economy', 5), 11); // 下限 = 类别数(每类保底 1)
  assert.strictEqual(questionTargetFor('balanced', 500), 100); // 上限 100
});

test('scaledCategories(30):矩阵按比例缩放,每类保底 1 题,总数恰为 30', () => {
  const cats = categoriesFor(30);
  assert.strictEqual(cats.reduce((s, c) => s + c.quota, 0), 30);
  assert.ok(cats.every((c) => c.quota >= 1));
  assert.ok(cats.every((c) => c.difficulties.reduce((s, d) => s + d.count, 0) === c.quota), '类别内难度和 = 类配额');
  // 广度:全部类别保留
  assert.strictEqual(cats.length, CATEGORIES.length);
  // 缩放保序:原配额最大的类别(核心模块深挖,24)缩放后仍是最大
  const top = cats.find((c) => c.name === '核心模块深挖')!;
  assert.strictEqual(top.quota, Math.max(...cats.map((c) => c.quota)));
});

test('totalQuota/buildSlots/computeDeficitSlots 按 target 生效', () => {
  assert.strictEqual(totalQuota(30), 30);
  assert.strictEqual(totalQuota(60), 60);
  assert.strictEqual(totalQuota(100), 100, '默认 target=100 与旧行为一致');
  const slots = buildSlots(emptyCards, undefined, 30);
  assert.strictEqual(slots.length, 30);
  // 缺口计算:占满 30 题后无缺口
  const filled = slots.map((s, i) => ({ ...mkQ(`Q${String(i + 1).padStart(2, '0')}`, s.category, s.difficulty as Question['difficulty']) }));
  assert.strictEqual(computeDeficitSlots(filled, emptyCards, undefined, 30).length, 0);
  // 旧默认调用(不传 target)行为不变
  assert.strictEqual(buildSlots(emptyCards, undefined).length, 100);
});

test('trimToQuotaDetailed:按 target 裁剪', () => {
  const slots = buildSlots(emptyCards, undefined, 30);
  const qs = slots.map((s, i) => ({ ...mkQ(`Q${String(i + 1).padStart(2, '0')}`, s.category, s.difficulty as Question['difficulty']) }));
  // 再塞 5 题超配额(复制第一题挤占其配额位)
  const over = [...qs, ...Array.from({ length: 5 }, (_, i) => ({ ...qs[0], question: `extra${i}` }))];
  const { keep, droppedOverQuota } = trimToQuotaDetailed(over, 30);
  assert.strictEqual(keep.length, 30);
  assert.strictEqual(droppedOverQuota, 5);
});
