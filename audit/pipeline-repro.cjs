'use strict';
// Offline audit only: source is transpiled in memory; no business code is changed.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(__dirname, 'pipeline-run-'));
const originalRead = fs.readFileSync;
fs.readFileSync = function (name, ...args) {
  if (typeof name === 'string' && /^\.env(?:\.|$)/.test(path.basename(name))) throw new Error('AUDIT: .env reads blocked');
  return originalRead.call(this, name, ...args);
};
global.fetch = async () => { throw new Error('AUDIT: network blocked'); };
for (const name of ['http', 'https']) {
  const mod = require(name);
  mod.request = mod.get = () => { throw new Error('AUDIT: network blocked'); };
}
require.extensions['.ts'] = (mod, name) => {
  const result = ts.transpileModule(fs.readFileSync(name, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: name,
  });
  mod._compile(result.outputText, name);
};
const schemas = require('../src/core/schemas.ts');
const coverage = require('../src/core/coverage.ts');
const { DiskCache } = require('../src/core/cache.ts');
const s1 = require('../src/stages/stage1Read.ts');
const s2 = require('../src/stages/stage2Questions.ts');
const s3 = require('../src/stages/stage3Verify.ts');
const s4 = require('../src/stages/stage4JD.ts');
const s5 = require('../src/stages/stage5Assemble.ts');
const evaluation = require('../src/stages/evaluate.ts');
const results = [];
const logs = [];
for (const name of ['log', 'warn']) console[name] = (...args) => logs.push(args.join(' '));
function dir(name) { const value = path.join(output, name); fs.mkdirSync(value, { recursive: true }); return value; }
const repo = dir('repo');
fs.writeFileSync(path.join(repo, 'code.js'), 'const answer = 1;\nmodule.exports = answer;');
function factsFor(repoRoot = repo) {
  return { root: repoRoot, generatedAt: new Date().toISOString(), files: ['code.js'],
    overview: { totalFiles: 1, totalLOC: 2, languages: { js: { files: 1, loc: 2 } }, manifests: [], entryPoints: [] },
    routes: [], dbTables: [], configFiles: [], hotspots: [], interestingFiles: [],
    testEvidence: { files: [], testCount: 0, assertCount: 0 }, tree: 'code.js', readingPlan: ['code.js'], notes: [] };
}
const facts = factsFor();
const knowledge = { 一句话定位: 'Offline fixture', 业务背景: 'fixture', 架构描述: 'one module', 数据流: 'input to output', 技术栈: [], 亮点: [], 缺点: [] };
const cards = [{ name: 'module', files: ['code.js'], 职责: 'fixture', 关键实现: [], 设计决策: [], 亮点: [], 缺点: [], 面试深挖点: [] }];
const chunks = [{ file: 'code.js', startLine: 1, endLine: 2, content: 'const answer = 1;\nmodule.exports = answer;' }];
function question(overrides = {}) {
  return { id: 'Q01', category: '安全', difficulty: '基础', question: '这段代码具体实现了什么行为？', 考察点: 'code behavior',
    答案要点: ['返回结果', '单模块', '可扩展'], 代码依据: [{ file: 'code.js', lines: '1-2' }],
    追问链: ['边界如何处理？', '怎样测试？'], 加分回答: 'add tests', 常见错误回答: 'wrong claim', ...overrides };
}
function comparison() { return { 候选方案: ['A', 'B'], 维度: ['D1', 'D2', 'D3'], 对比表: [['A', 'x', 'x', 'x'], ['B', 'x', 'x', 'x']], 结论: '不同条件选择不同方案并明确适用边界。' }; }
function mockClient(fn) { return { model: 'offline-audit', calls: 0, async chat(messages, opts) { this.calls++; return fn(messages, opts, this.calls); }, printUsage() {} }; }
async function test(name, fn) {
  try { const detail = await fn(); results.push({ name, reproduced: true, detail }); }
  catch (error) { results.push({ name, reproduced: false, error: String(error.stack || error) }); }
}
function distributions(qs) {
  const counts = {};
  for (const q of qs) { const k = `${q.category}|${q.difficulty}`; counts[k] = (counts[k] || 0) + 1; }
  return counts;
}
(async () => {
  await test('valid baseline: slots produce exactly 100 with declared quotas', async () => {
    const slots = coverage.buildSlots(cards, knowledge);
    assert.equal(slots.length, 100);
    for (const c of coverage.CATEGORIES) assert.equal(slots.filter(s => s.category === c.name).length, c.quota);
    return { slots: slots.length, categories: coverage.CATEGORIES.length };
  });
  await test('P2: empty comparison rows accepted as valid', async () => {
    const cmp = { ...comparison(), 对比表: [[], []] };
    const q = question({ category: '技术选型对比', 对比: cmp });
    const errs = schemas.validateQuestion(q, new Set(facts.files));
    assert.equal(schemas.isValidComparison(cmp), true); assert.deepEqual(errs, []);
    return { isValidComparison: true, validationErrors: errs, rows: cmp.对比表 };
  });
  await test('P2: module grouping silently discards the 13th top-level module', async () => {
    const grouped = s1.groupByModule(Array.from({ length: 13 }, (_, i) => ({ file: `module${i}/index.ts`, startLine: 1, endLine: 2, content: 'x' })));
    assert.equal(grouped.length, 12); return { inputModules: 13, outputModules: grouped.length };
  });
  await test('P2: syntactically valid empty cards accepted and cached', async () => {
    const folder = dir('empty-cards'); const cache = new DiskCache(folder); const client = mockClient(() => '{}');
    const first = await s1.runStage1(client, cache, facts, chunks);
    const second = await s1.runStage1(client, cache, facts, chunks);
    assert.equal(first.cards[0].职责, ''); assert.equal(first.knowledge.一句话定位, ''); assert.equal(client.calls, 2);
    return { callsAcrossTwoRuns: client.calls, cachedFiles: fs.readdirSync(folder).length, responsibility: second.cards[0].职责, positioning: second.knowledge.一句话定位 };
  });
  await test('P1: one dropped early question is replaced from wrong quota bucket', async () => {
    let unique = 0;
    const client = mockClient((messages, _opts, call) => {
      const slots = [...messages[1].content.matchAll(/^\d+\. 类别=(.*?) \| 难度=(.*?) \| 目标=(.*?) \|/gm)];
      assert.ok(slots.length);
      let qs = slots.map(m => question({ id: '', category: m[1], difficulty: m[2], target: m[3], question: `生成第 ${++unique} 个不同的代码问题，请解释？`, 对比: comparison() }));
      if (call === 1) qs = qs.slice(0, 4);
      return JSON.stringify({ questions: qs });
    });
    const qs = await s2.runStage2(client, new DiskCache(dir('quota-cache')), facts, cards, knowledge, chunks, dir('quota-output'));
    const expected = distributions(coverage.buildSlots(cards, knowledge)); const actual = distributions(qs);
    const mismatches = Object.keys(expected).filter(k => expected[k] !== actual[k]).map(k => ({ bucket: k, expected: expected[k], actual: actual[k] || 0 }));
    assert.equal(qs.length, 100); assert.ok(mismatches.length);
    return { questions: qs.length, calls: client.calls, mismatches, trimWouldLeave: coverage.trimToQuota(qs).length };
  });
  await test('P1: unavailable verification service produces pass', async () => {
    const qs = [question()]; const client = mockClient(() => { throw new Error('offline simulated 503'); });
    const stats = await s3.runStage3(client, facts, qs, dir('verify-failure'));
    assert.equal(qs[0].verified, 'pass'); return { stats, verified: qs[0].verified, note: qs[0].verifyNote };
  });
  await test('P1: no code citations and no LLM coverage still produces pass', async () => {
    const qs = [question({ 代码依据: [] })];
    const stats = await s3.runStage3(mockClient(() => '{"results":[]}'), facts, qs, dir('verify-empty'));
    assert.equal(qs[0].verified, 'pass'); return { stats, citations: qs[0].代码依据, verified: qs[0].verified };
  });
  await test('P1: model pass overrules deterministic missing-file error', async () => {
    const qs = [question({ 代码依据: [{ file: 'missing.js', lines: '1' }] })];
    const client = mockClient(() => '{"results":[{"id":"Q01","verdict":"pass","note":"model says pass"}]}');
    const stats = await s3.runStage3(client, facts, qs, dir('verify-missing-file'));
    assert.equal(qs[0].verified, 'pass'); assert.equal(stats.deterministicIssues, 1);
    return { stats, verified: qs[0].verified, note: qs[0].verifyNote };
  });
  await test('P1: checkpoint applies old corrected answer to changed question without recheck', async () => {
    const folder = dir('verify-checkpoint'); const oldAnswer = ['OLD ANSWER A', 'OLD ANSWER B', 'OLD ANSWER C'];
    await s3.runStage3(mockClient(() => JSON.stringify({ results: [{ id: 'Q01', verdict: 'fix', note: 'old repair', 修正答案要点: oldAnswer }] })), facts, [question()], folder);
    const replacement = question({ question: '新的完全不同代码题目应该怎样回答？', 答案要点: ['NEW A', 'NEW B', 'NEW C'] });
    const second = mockClient(() => { throw new Error('must revalidate'); });
    await s3.runStage3(second, facts, [replacement], folder);
    assert.equal(second.calls, 0); assert.deepEqual(replacement.答案要点, oldAnswer);
    return { secondRunApiCalls: second.calls, changedQuestionAnswer: replacement.答案要点, checkpointStillExists: fs.existsSync(path.join(folder, '.verify-progress.json')) };
  });
  await test('P2: invalid verdict accepted as persisted verification status', async () => {
    const qs = [question()]; const stats = await s3.runStage3(mockClient(() => '{"results":[{"id":"Q01","verdict":"green","note":""}]}'), facts, qs, dir('invalid-verdict'));
    assert.equal(qs[0].verified, 'green'); assert.equal(stats.pass, 1); return { verified: qs[0].verified, stats };
  });
  await test('P2: citation clamp creates inverted range and next-line citation passes', async () => {
    const qs = [question({ 代码依据: [{ file: 'code.js', lines: '100-110' }] })];
    s3.sanitizeCitations(facts, qs);
    assert.equal(qs[0].代码依据[0].lines, '100-2');
    const oneBeyond = s3.deterministicCheck(facts, [question({ 代码依据: [{ file: 'code.js', lines: '3' }] })]);
    assert.equal(oneBeyond.lineErrors.size, 0);
    return { sanitizedRange: qs[0].代码依据[0].lines, nextLineErrors: oneBeyond.lineErrors.size, nextLineExcerpt: [...oneBeyond.excerpts.values()][0] };
  });
  await test('P1: flagged answer loses warning after shape-only rewrite without evidence', async () => {
    const q = question({ verified: 'flag', verifyNote: 'all evidence missing; unsupported original claim', 代码依据: [] });
    const client = mockClient(() => JSON.stringify({ 答案要点: ['这里部署了不存在的分布式服务。', '系统达到没有实测的百万吞吐。', '代码有不存在的鉴权策略。'] }));
    const count = await s2.rewriteFlaggedAnswers(client, new DiskCache(dir('flag-cache')), facts, [q], dir('flag-output'));
    assert.equal(count, 1); assert.equal(q.verified, 'fix'); assert.equal(q.代码依据.length, 0);
    return { repaired: count, verified: q.verified, citations: q.代码依据.length, note: q.verifyNote };
  });
  await test('P2: JD cache keys only list length and reuses relevance for changed questions', async () => {
    const cache = new DiskCache(dir('jd-cache')); const folder = dir('jd-output');
    const client = mockClient(() => JSON.stringify({ 关键词: ['A'], 能力要求: [], 高相关主题: [], 必考ID: ['Q01'], 开场白STAR: 'A project', 复述侧重: { 多讲: [], 少讲: [] } }));
    await s4.runStage4(client, cache, 'JD', [question({ question: 'AAAA AAAA' })], folder);
    const changed = [question({ question: 'BBBB BBBB' })]; await s4.runStage4(client, cache, 'JD', changed, folder);
    assert.equal(client.calls, 1); return { callsAcrossTwoDifferentQuestionLists: client.calls, staleMustAsk: changed[0].必考 };
  });
  await test('P2: out-of-range model evaluation scores yield total above 10', async () => {
    const folder = dir('evaluation');
    fs.writeFileSync(path.join(folder, 'questions.json'), JSON.stringify([question({ 对比: comparison() })]));
    fs.writeFileSync(path.join(folder, 'repo_facts.json'), JSON.stringify(facts));
    const client = mockClient((_messages, _opts, call) => JSON.stringify(call === 1 ? { items: [{ id: 'Q01', cite: 100, consistency: 100 }] } : call === 2 ? { items: [{ id: 'Q01', dims: 100, objectivity: 100, boundary: 100 }] } : call === 3 ? { STAR可信度: 100, 亮点防守: 100, 缺点话术: 100, 对比章节: 100, problems: [], strengths: [] } : { 易用性: 100, problems: [], strengths: [] }));
    const result = await evaluation.runEvaluation(client, folder); assert.ok(result.total > 10);
    return { advertisedScale: '0-10', actualTotal: result.total, deterministicFailures: result.detFailures.length };
  });
  await test('P1: runner misses equal-length edit, new file and changed question verification', async () => {
    // Isolate runner orchestration; replace network/config and expensive stages with deterministic doubles.
    const config = require('../src/core/config.ts'); const deepseek = require('../src/core/deepseek.ts'); const profiler = require('../src/core/profiler.ts');
    const original = { loadConfig: config.loadConfig, DeepSeekClient: deepseek.DeepSeekClient, profileRepo: profiler.profileRepo,
      runStage1: s1.runStage1, runStage2: s2.runStage2, repairComparisons: s2.repairComparisons,
      repairAnnotationAnswers: s2.repairAnnotationAnswers, rewriteFlaggedAnswers: s2.rewriteFlaggedAnswers, runStage3: s3.runStage3, runStage5: s5.runStage5 };
    const counts = { profile: 0, read: 0, questions: 0, verify: 0, assemble: 0 };
    config.loadConfig = () => ({ apiKey: 'offline-fixture', model: 'offline-fixture', baseUrl: 'http://invalid.invalid' });
    deepseek.DeepSeekClient = class { model = 'offline-fixture'; printUsage() {} async chat() { throw new Error('offline API is blocked'); } };
    profiler.profileRepo = (r) => { counts.profile++; return factsFor(r); };
    s1.runStage1 = async () => { counts.read++; return { cards, knowledge }; };
    s2.runStage2 = async (_client, _cache, _facts, _cards, _knowledge, _chunks, out) => {
      counts.questions++; const qs = coverage.buildSlots(cards, knowledge).map((slot, i) => question({ ...slot, id: `Q${String(i + 1).padStart(2, '0')}`, question: `离线问题序号 ${i} 的具体代码行为？`, 对比: comparison() }));
      fs.writeFileSync(path.join(out, 'questions.json'), JSON.stringify(qs)); return qs;
    };
    s2.repairComparisons = s2.repairAnnotationAnswers = s2.rewriteFlaggedAnswers = async () => 0;
    s3.runStage3 = async () => { counts.verify++; return { total: 100, pass: 100, fix: 0, flag: 0, deterministicIssues: 0 }; };
    s5.runStage5 = async () => { counts.assemble++; };
    try {
      const runner = require('../src/core/runner.ts'); const source = dir('runner-repo'); const out = dir('runner-output');
      fs.writeFileSync(path.join(source, 'code.js'), 'const answer = 1;\nmodule.exports = answer;');
      await runner.runPipeline({ repoPath: source, outDir: out });
      fs.writeFileSync(path.join(source, 'code.js'), 'const answer = 2;\nmodule.exports = answer;');
      fs.writeFileSync(path.join(source, 'new-module.js'), 'module.exports = 42;');
      const qs = JSON.parse(fs.readFileSync(path.join(out, 'questions.json'), 'utf8')); qs[0].答案要点 = ['A CHANGED UNSUPPORTED ANSWER', 'B', 'C'];
      fs.writeFileSync(path.join(out, 'questions.json'), JSON.stringify(qs));
      await runner.runPipeline({ repoPath: source, outDir: out });
      assert.deepEqual(counts, { profile: 1, read: 1, questions: 1, verify: 1, assemble: 2 });
      const savedFacts = JSON.parse(fs.readFileSync(path.join(out, 'repo_facts.json'), 'utf8'));
      assert.equal(savedFacts.files.includes('new-module.js'), false);
      return { stageExecutionsAcrossTwoRuns: counts, newFilePresentInSavedFacts: false, sourceEqualLengthEditSkipped: true, changedAnswerReverificationSkipped: true };
    } finally {
      config.loadConfig = original.loadConfig; deepseek.DeepSeekClient = original.DeepSeekClient; profiler.profileRepo = original.profileRepo;
      for (const key of ['runStage2', 'repairComparisons', 'repairAnnotationAnswers', 'rewriteFlaggedAnswers']) s2[key] = original[key];
      s1.runStage1 = original.runStage1; s3.runStage3 = original.runStage3; s5.runStage5 = original.runStage5;
    }
  });
  for (const rel of ['interview-output', 'example-demo/interview-output']) {
    const file = path.join(root, rel, 'questions.json'); if (!fs.existsSync(file)) continue;
    const qs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const invalidComparisons = qs.filter(q => q.category === '技术选型对比' && !schemas.isValidComparison(q.对比)).map(q => q.id);
    const expected = distributions(coverage.buildSlots(cards, knowledge)); const actual = distributions(qs);
    const mismatches = Object.keys(expected).filter(k => expected[k] !== actual[k]).map(k => ({ bucket: k, expected: expected[k], actual: actual[k] || 0 }));
    results.push({ name: `existing artifact snapshot: ${rel}`, reproduced: true, detail: { count: qs.length, statuses: qs.reduce((a, q) => { a[q.verified || 'unset'] = (a[q.verified || 'unset'] || 0) + 1; return a; }, {}), quotaMismatches: mismatches, invalidComparisons, noCitations: qs.filter(q => !q.代码依据?.length).map(q => q.id) } });
  }
  const resultFile = path.join(__dirname, 'pipeline-results.json');
  fs.writeFileSync(resultFile, JSON.stringify({ generatedAt: new Date().toISOString(), output, network: 'blocked', envReads: 'blocked', results }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'pipeline-execution.log'), logs.join('\n'));
  process.stdout.write(JSON.stringify({ output, totalChecks: results.length, reproduced: results.filter(r => r.reproduced).length, results }, null, 2) + '\n');
  // Remove only this script's verified direct child fixture directory.
  assert.equal(path.dirname(path.resolve(output)), path.resolve(__dirname));
  assert.ok(path.basename(output).startsWith('pipeline-run-'));
  fs.rmSync(output, { recursive: true, force: true });
  if (results.some(r => !r.reproduced)) process.exitCode = 1;
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
