/*
 * 可重复的本地 OpenAI-compatible 性能回归：不触碰付费 API。
 * 运行: npm run build && node audit/performance-mock.cjs
 * 统计真实请求数、重复 prompt 字节、最大单请求输入、峰值并发和增量重跑调用量。
 */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runStage3 } = require('../dist/stages/stage3Verify');

function makeQuestion(i) {
  return {
    id: `Q${String(i).padStart(2, '0')}`, category: '核心模块深挖', difficulty: '基础',
    question: `如何验证核心流程第 ${i} 个边界行为？`, 考察点: '证据与边界',
    答案要点: ['答案必须对应源码实现', '失败分支需要可验证', '引用范围不能越界'],
    代码依据: [{ file: 'src/a.ts', lines: '1-2' }], 追问链: ['为什么?', '如何测试?'],
    加分回答: '说明权衡与恢复路径。', 常见错误回答: '只说用了某个框架。',
  };
}

async function main() {
  const requests = [];
  let active = 0, peak = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ bytes: Buffer.byteLength(body), body });
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active--;
    const ids = [...body.matchAll(/题目 (Q\d+)/g)].map((m) => m[1]);
    const payload = JSON.stringify({ results: ids.map((id) => ({ id, verdict: 'pass', note: 'mock evidence' })) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: payload }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: Math.ceil(payload.length / 4) } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-perf-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const answer = 42;\nexport const edge = true;\n');
  const facts = { root, generatedAt: new Date().toISOString(), files: ['src/a.ts'], overview: { totalFiles: 1, totalLOC: 2, languages: {}, manifests: [], entryPoints: [] }, routes: [], dbTables: [], configFiles: [], hotspots: [], interestingFiles: [], testEvidence: { files: [], testCount: 0, assertCount: 0 }, tree: '', readingPlan: ['src/a.ts'], notes: [], skippedSensitive: [], skippedByReason: {} };
  const questions = Array.from({ length: 25 }, (_, i) => makeQuestion(i + 1));
  const client = { chat: async () => { throw new Error('unused'); } };
  // Use a real DeepSeekClient so request policy, HTTP parsing, usage and concurrency are exercised.
  const { DeepSeekClient } = require('../dist/core/deepseek');
  const cfg = { apiKey: 'mock-key', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'mock', timeoutMs: 10000, sources: { apiKey: 'mock', baseUrl: 'mock', model: 'mock' } };
  const realClient = new DeepSeekClient(cfg);
  const outDir = path.join(root, 'output'); fs.mkdirSync(outDir);
  await runStage3(realClient, facts, questions, outDir);
  const firstCalls = requests.length;
  const firstBytes = requests.reduce((n, r) => n + r.bytes, 0);
  const firstMaxBody = Math.max(...requests.map((r) => r.bytes));
  const beforeIncremental = requests.length;
  await runStage3(realClient, facts, questions, outDir);
  const incrementalCalls = requests.length - beforeIncremental;
  assert.equal(firstCalls, 3, '25 题应装入 3 个校验批次');
  assert.ok(peak <= 3, `peak concurrency ${peak} > 3`);
  assert.equal(incrementalCalls, 0, '内容不变的重跑应完全命中 checkpoint');
  console.log(JSON.stringify({ fixture: '25 questions / 1 source file', firstCalls, firstPromptBytes: firstBytes, maxRequestBytes: firstMaxBody, peakConcurrency: peak, incrementalCalls, usage: realClient.usage(), note: 'local mock only; not a production cost quote' }, null, 2));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
