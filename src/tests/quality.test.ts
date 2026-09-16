import * as fs from 'fs';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildQualityReport } from '../core/quality';
import { RepoFacts } from '../core/profiler';
import { ModuleCard, Question } from '../core/schemas';
import { makeTempDir, write, cleanup } from './helpers';

function facts(root: string): RepoFacts {
  return {
    root, generatedAt: new Date().toISOString(), files: ['src/a.ts'],
    overview: { totalFiles: 1, totalLOC: 1, languages: {}, manifests: [], entryPoints: [] },
    routes: [], dbTables: [], configFiles: [], hotspots: [], interestingFiles: [],
    testEvidence: { files: [], testCount: 0, assertCount: 0 }, tree: '', readingPlan: ['src/a.ts'], notes: [],
    skippedSensitive: [], skippedByReason: {},
  };
}

const card: ModuleCard = {
  name: 'core', files: ['src/a.ts'], 职责: '核心职责', 关键实现: [], 设计决策: [], 亮点: ['x'], 缺点: [], 面试深挖点: [],
};

function question(over: Partial<Question> = {}): Question {
  return {
    id: 'Q01', category: '核心模块深挖', difficulty: '基础', question: '为什么这样实现核心流程?', 考察点: '流程',
    答案要点: ['依据源码的实现细节', '失败时有明确处理', '边界条件可验证'], 代码依据: [{ file: 'src/a.ts', lines: '1' }],
    追问链: [{ 问题: '为什么?', 参考要点: '标准答案方向说明' }, { 问题: '如何验证?', 参考要点: '标准答案方向说明' }], 加分回答: '可以继续解释权衡。', 常见错误回答: '只说用了某个框架。', verified: 'pass', ...over,
  };
}

test('quality gate:分数和 A+ 资格由确定性事实计算,不能被模型额外字段篡改', () => {
  const dir = makeTempDir('cip-quality-');
  try {
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const baseline = buildQualityReport(facts(dir), [card], [question()]).report;
    const tamperedQuestion = Object.assign(question(), { score: 100, confidence: 0 });
    const tampered = buildQualityReport(facts(dir), [card], [tamperedQuestion]).report;
    assert.equal(tampered.score, baseline.score);
    assert.equal(tampered.aPlusEligible, baseline.aPlusEligible);
    assert.equal(tampered.totalQuestions, 1);
  } finally { cleanup(dir); }
});

test('quality artifacts use deterministic field names and never include source secret text', () => {
  const dir = makeTempDir('cip-quality-secret-');
  try {
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const result = buildQualityReport(facts(dir), [card], [question({ 答案要点: ['safe claim'] })]);
    assert.ok(result.report && 'claimLedger' in result);
    assert.ok(!JSON.stringify(result).includes('sk-'));
    assert.ok(result.evidenceGraph.nodes.some((n: any) => n.type === 'file'));
    assert.ok(fs.existsSync(pathJoinSafe(dir, 'src/a.ts')));
  } finally { cleanup(dir); }
});

function pathJoinSafe(root: string, rel: string): string { return `${root}/${rel.replace(/\\/g, '/')}`; }
