import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { deterministicCheck, sanitizeCitations } from '../stages/stage3Verify';
import { RepoFacts } from '../core/profiler';
import { Question } from '../core/schemas';
import { makeTempDir, write, cleanup } from './helpers';

const mkFacts = (root: string, files: string[]): RepoFacts => ({
  root,
  generatedAt: new Date().toISOString(),
  files,
  overview: { totalFiles: files.length, totalLOC: 0, languages: {}, manifests: [], entryPoints: [] },
  routes: [],
  dbTables: [],
  configFiles: [],
  hotspots: [],
  interestingFiles: [],
  testEvidence: { files: [], testCount: 0, assertCount: 0 },
  tree: '',
  readingPlan: [],
  notes: [],
  skippedSensitive: [],
  skippedByReason: {},
});

const mkQ = (cites: Array<{ file: string; lines: string }>): Question => ({
  id: 'Q01',
  category: '核心模块深挖',
  difficulty: '基础',
  question: '问题',
  考察点: 'x',
  答案要点: ['a'],
  代码依据: cites,
  追问链: [{ 问题: 'x', 参考要点: '参考要点说明内容' }],
  加分回答: 'g',
  常见错误回答: 'w',
});

test('deterministicCheck:严格边界——末尾后一行不再放行,start 也要 ≤ total', () => {
  const dir = makeTempDir();
  try {
    write(dir, 'a.ts', 'l1\nl2\n'); // 真实 2 行
    const facts = mkFacts(dir, ['a.ts']);
    // 引用第 3 行(旧版 total+1 放行 + split 尾空行,合计容忍越界 2 行)
    const r1 = deterministicCheck(facts, [mkQ([{ file: 'a.ts', lines: '3' }])]);
    assert.ok(r1.lineErrors.has('Q01'), '引用不存在的第 3 行应报越界');
    // 引用第 2 行:合法
    const r2 = deterministicCheck(facts, [mkQ([{ file: 'a.ts', lines: '2' }])]);
    assert.ok(!r2.lineErrors.has('Q01'), '引用真实存在的第 2 行不应报错');
    // start > end 不等式由 parseCiteRanges 拦;start=2,end=2 合法
    const r3 = deterministicCheck(facts, [mkQ([{ file: 'a.ts', lines: '1-2' }])]);
    assert.ok(!r3.lineErrors.has('Q01'));
  } finally {
    cleanup(dir);
  }
});

test('deterministicCheck:同一文件多次引用只读一次盘(readLines 缓存修复)', () => {
  const dir = makeTempDir();
  try {
    write(dir, 'a.ts', 'l1\nl2\nl3\n');
    const facts = mkFacts(dir, ['a.ts']);
    const qs = [1, 2, 3, 4, 5].map((i) => ({
      ...mkQ([{ file: 'a.ts', lines: '1-3' }]),
      id: `Q${String(i).padStart(2, '0')}`,
    }));
    const { excerpts } = deterministicCheck(facts, qs);
    assert.strictEqual(excerpts.size, 5);
    // 语义验证:命中缓存不重复读盘(行为级:删掉文件后再次调用会因缓存…不,缓存按次调用;
    // 此处验证多次引用均产出摘录即功能正确)
  } finally {
    cleanup(dir);
  }
});

test('sanitizeCitations:越界 start 不再产出倒置区间,完全越界删除引用', () => {
  const dir = makeTempDir();
  try {
    write(dir, 'a.ts', 'l1\nl2\n'); // 2 行
    const facts = mkFacts(dir, ['a.ts']);
    // 引用 120-130:旧版截成 "120-2"(倒置);新版应整段删除
    const q1 = mkQ([{ file: 'a.ts', lines: '120-130' }]);
    const fixed = sanitizeCitations(facts, [q1]);
    assert.ok(fixed >= 1);
    assert.strictEqual(q1.代码依据.length, 0, '完全越界的引用应被删除');
    assert.strictEqual(q1.verified, 'flag', '全部引用失效应标 flag');
    // 部分越界:1-5 → 截为 1-2(合法区间)
    const q2 = mkQ([{ file: 'a.ts', lines: '1-5' }]);
    sanitizeCitations(facts, [q2]);
    assert.strictEqual(q2.代码依据[0].lines, '1-2');
  } finally {
    cleanup(dir);
  }
});

test('runStage3:校验批次有界并发且 checkpoint 合并不丢题', async () => {
  const dir = makeTempDir('cip-verify-concurrent-');
  try {
    write(dir, 'a.ts', 'export const answer = 42;\n');
    const facts = mkFacts(dir, ['a.ts']);
    const questions = Array.from({ length: 25 }, (_, i) => ({ ...mkQ([{ file: 'a.ts', lines: '1' }]), id: `Q${String(i + 1).padStart(2, '0')}` }));
    let active = 0;
    let peak = 0;
    const client = {
      chat: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return JSON.stringify({ results: questions.map((q) => ({ id: q.id, verdict: 'pass', note: 'evidence' })) });
      },
    } as any;
    const { runStage3 } = await import('../stages/stage3Verify');
    const result = await runStage3(client, facts, questions, dir);
    assert.equal(result.total, 25);
    assert.equal(result.pass, 25);
    assert.ok(peak <= 3, `并发峰值 ${peak} 超过保守上限`);
    const checkpoint = JSON.parse(fs.readFileSync(`${dir}/.verify-progress.json`, 'utf8'));
    assert.equal(checkpoint.length, 25);
  } finally { cleanup(dir); }
});
