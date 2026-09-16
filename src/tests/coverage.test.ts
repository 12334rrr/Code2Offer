import { test } from 'node:test';
import * as assert from 'node:assert';
import { CATEGORIES, totalQuota, trimToQuotaDetailed, computeDeficitSlots } from '../core/coverage';
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
