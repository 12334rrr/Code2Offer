import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { allocateRunDir, carryForwardIncrement, latestRunDir, repoRootOfOutput, runsRootOf } from '../core/runs';
import { log, setLogger, withLogSink } from '../core/logger';
import { makeTempDir, write, cleanup } from './helpers';

/* ---------------- allocateRunDir:独立目录编号 ---------------- */

test('allocateRunDir:首次运行分配 run-0001;之后顺序递增', () => {
  const root = makeTempDir();
  try {
    const first = allocateRunDir(root);
    assert.strictEqual(path.basename(first.runDir), 'run-0001');
    assert.strictEqual(first.index, 1);
    assert.strictEqual(first.previousRunDir, undefined);

    const second = allocateRunDir(root);
    assert.strictEqual(path.basename(second.runDir), 'run-0002');
    assert.strictEqual(path.basename(second.previousRunDir!), 'run-0001');
  } finally {
    cleanup(root);
  }
});

test('allocateRunDir:忽略非 run-NNNN 的杂项目录;编号只看合法目录的最大值', () => {
  const root = makeTempDir();
  try {
    write(path.join(root, 'runs', 'run-0005'), 'index.html', 'x'); // 最高合法编号 5
    write(path.join(root, 'runs', 'not-a-run'), 'index.html', 'x'); // 杂项目录,忽略
    fs.writeFileSync(path.join(root, 'runs', 'run-0002'), 'placeholder', 'utf-8'); // 同名文件而非目录,忽略
    const next = allocateRunDir(root);
    assert.strictEqual(path.basename(next.runDir), 'run-0006');
    assert.strictEqual(path.basename(next.previousRunDir!), 'run-0005');
  } finally {
    cleanup(root);
  }
});

test('allocateRunDir:跨 9999 后编号不丢位数', () => {
  const root = makeTempDir();
  try {
    write(root, 'runs/run-9999/index.html', 'x');
    const next = allocateRunDir(root);
    assert.strictEqual(path.basename(next.runDir), 'run-10000');
  } finally {
    cleanup(root);
  }
});

/* ---------------- carryForwardIncrement:增量接续清单 ---------------- */

test('carryForwardIncrement:携带门控状态/缓存/断点,绝不携带最终产物与锁', () => {
  const root = makeTempDir();
  try {
    const prev = path.join(root, 'runs', 'run-0001');
    write(prev, 'index.html', '旧报告');
    write(prev, 'state.json', '{"stages":{}}');
    write(prev, 'repo_facts.json', '{}');
    write(prev, 'module_cards.json', '[]');
    write(prev, 'knowledge.json', '{}');
    write(prev, 'questions.json', '[]');
    write(prev, '.verify-progress.json', '[]');
    write(prev, '.cache/stage1/abc.json', '{}');
    write(prev, '.run-lock', '{"pid":1}');
    write(prev, '01_项目讲解.md', '# 旧讲解');
    write(prev, '校验报告.md', '旧报告');

    const runDir = path.join(root, 'runs', 'run-0002');
    fs.mkdirSync(runDir, { recursive: true });
    const { carried } = carryForwardIncrement(prev, runDir);

    // 携带:门控与断点
    for (const f of ['state.json', 'repo_facts.json', 'module_cards.json', 'knowledge.json', 'questions.json', '.verify-progress.json']) {
      assert.ok(fs.existsSync(path.join(runDir, f)), `应携带 ${f}`);
    }
    // 携带:LLM 缓存(递归)
    assert.ok(fs.existsSync(path.join(runDir, '.cache', 'stage1', 'abc.json')));
    // 不携带:最终产物、运行锁(前后两次的产物正是要不混在一起的)
    for (const f of ['index.html', '01_项目讲解.md', '校验报告.md', '.run-lock']) {
      assert.ok(!fs.existsSync(path.join(runDir, f)), `不应携带 ${f}`);
    }
    // carried 报告可读
    assert.ok(carried.includes('state.json') && carried.includes('.cache/'));
  } finally {
    cleanup(root);
  }
});

test('carryForwardIncrement:没有上一次(首次/来源不存在)时为空操作', () => {
  const root = makeTempDir();
  try {
    const runDir = path.join(root, 'runs', 'run-0001');
    fs.mkdirSync(runDir, { recursive: true });
    const a = carryForwardIncrement(undefined, runDir);
    const b = carryForwardIncrement(path.join(root, 'runs', 'run-0099'), runDir);
    assert.deepStrictEqual(a.carried, []);
    assert.deepStrictEqual(b.carried, []);
  } finally {
    cleanup(root);
  }
});

/* ---------------- latestRunDir / repoRootOfOutput ---------------- */

test('latestRunDir:返回最近一次完成的 run;没有 runs 布局时为 undefined', () => {
  const root = makeTempDir();
  try {
    assert.strictEqual(latestRunDir(root), undefined);
    write(root, 'runs/run-0001/questions.json', '[]'); // 未完成(无 index.html)
    write(root, 'runs/run-0002/index.html', 'x');
    assert.strictEqual(path.basename(latestRunDir(root)!), 'run-0002');
  } finally {
    cleanup(root);
  }
});

test('repoRootOfOutput:优先 run-manifest 的快照记录,旧产物回退父目录', () => {
  const root = makeTempDir();
  try {
    // 旧布局:<repo>/interview-output → 父目录即仓库根
    write(root, 'repoA/interview-output/questions.json', '[]');
    assert.strictEqual(path.basename(repoRootOfOutput(path.join(root, 'repoA', 'interview-output'))), 'repoA');
    // 新布局:runs/run-0007 里带 manifest.repository.root
    const repoB = path.join(root, 'repoB');
    const runDir = path.join(repoB, 'interview-output', 'runs', 'run-0007');
    write(runDir, 'questions.json', '[]');
    write(runDir, 'run-manifest.json', JSON.stringify({ repository: { root: repoB } }));
    assert.strictEqual(path.basename(repoRootOfOutput(runDir)), 'repoB');
  } finally {
    cleanup(root);
  }
});

/* ---------------- logger:每次运行独立日志出口 ---------------- */

test('withLogSink:上下文内的行同时进专属 sink 与全局 sink;跨 await 传播', async () => {
  const globalLines: string[] = [];
  const scoped: string[] = [];
  setLogger((l) => globalLines.push(l));
  try {
    const sink = { log: (l: string) => scoped.push(l), warn: () => scoped.push('W') };
    await withLogSink(sink, async () => {
      log('in-context');
      await new Promise((r) => setTimeout(r, 5)); // 跨 await 仍应保持上下文
      log('after-await');
    });
    log('out-of-context');
    assert.deepStrictEqual(scoped, ['in-context', 'after-await']);
    assert.deepStrictEqual(globalLines, ['in-context', 'after-await', 'out-of-context']);
  } finally {
    setLogger((l) => console.log(l)); // 恢复默认,不污染其他测试
  }
});

test('withLogSink:并行两个上下文互不串线', async () => {
  const globalLines: string[] = [];
  setLogger((l) => globalLines.push(l));
  const a: string[] = [];
  const b: string[] = [];
  try {
    await Promise.all([
      withLogSink({ log: (l) => a.push(l), warn: () => {} }, async () => {
        log('A1');
        await new Promise((r) => setTimeout(r, 10));
        log('A2');
      }),
      withLogSink({ log: (l) => b.push(l), warn: () => {} }, async () => {
        log('B1');
        await new Promise((r) => setTimeout(r, 2));
        log('B2');
      }),
    ]);
    assert.deepStrictEqual(a, ['A1', 'A2']);
    assert.deepStrictEqual(b, ['B1', 'B2']);
    // 全局通道收到全部 4 行(顺序按实际完成穿插)
    assert.deepStrictEqual(globalLines.slice().sort(), ['A1', 'A2', 'B1', 'B2']);
  } finally {
    setLogger((l) => console.log(l));
  }
});

test('runsRootOf:输出根下的 runs 容器路径', () => {
  assert.strictEqual(runsRootOf(path.join('x', 'interview-output')), path.join('x', 'interview-output', 'runs'));
});
