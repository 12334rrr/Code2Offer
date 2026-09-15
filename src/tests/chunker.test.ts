import { test } from 'node:test';
import * as assert from 'node:assert';
import { loadChunks } from '../core/chunker';
import { splitFileLines } from '../core/profiler';
import { makeTempDir, write, cleanup } from './helpers';

test('splitFileLines:文件以换行结尾时不产生幽灵末行', () => {
  assert.strictEqual(splitFileLines('a\nb\n').length, 2);
  assert.strictEqual(splitFileLines('a\nb').length, 2);
  assert.strictEqual(splitFileLines('a\n\n').length, 2);
  assert.strictEqual(splitFileLines('').length, 0);
});

test('loadChunks:小文件单块,行数与编辑器一致(引用坐标系)', () => {
  const dir = makeTempDir();
  try {
    write(dir, 'a.ts', 'line1\nline2\nline3\n');
    const { chunks } = loadChunks(dir, ['a.ts']);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].startLine, 1);
    assert.strictEqual(chunks[0].endLine, 3); // 不是 4(split 尾空行已修正)
  } finally {
    cleanup(dir);
  }
});

test('loadChunks:按字符预算切块且每块不超限', () => {
  const dir = makeTempDir();
  try {
    // 40 行 × 1000 字符 ≈ 40000 字符,预算 14000 → 约 13 行/块,3 块读 39 行,第 40 行进 truncated
    const big = Array.from({ length: 40 }, () => `x`.repeat(1000)).join('\n');
    write(dir, 'big.ts', big);
    const { chunks, truncated } = loadChunks(dir, ['big.ts'], 14000, 3);
    assert.ok(chunks.length === 3, `块数 ${chunks.length}`);
    for (const c of chunks) {
      assert.ok(c.content.length <= 14000 + 4000, `块 ${c.startLine}-${c.endLine} 超限:${c.content.length}`); // 预算 + 单行截断余量
    }
    assert.strictEqual(truncated.length, 1, '超出 3 块的部分应记入 truncated');
    // 行号连续性
    for (let i = 1; i < chunks.length; i++) {
      assert.strictEqual(chunks[i].startLine, chunks[i - 1].endLine + 1);
    }
  } finally {
    cleanup(dir);
  }
});

test('loadChunks:超长单行被硬截断,不再打爆单块预算', () => {
  const dir = makeTempDir();
  try {
    write(dir, 'longline.js', 'const x = "' + 'y'.repeat(200000) + '";\nconsole.log(x);\n');
    const { chunks } = loadChunks(dir, ['longline.js'], 14000, 3);
    assert.strictEqual(chunks.length, 1);
    assert.ok(chunks[0].content.length < 6000, `内容 ${chunks[0].content.length} 应被截断`);
    assert.ok(chunks[0].content.includes('超长行已截断'));
    assert.strictEqual(chunks[0].endLine, 2);
  } finally {
    cleanup(dir);
  }
});

test('loadChunks:读取失败的文件记入 skipped 而非静默消失', () => {
  const dir = makeTempDir();
  try {
    write(dir, 'a.ts', 'ok\n');
    const { skipped } = loadChunks(dir, ['a.ts', 'missing.ts']);
    assert.deepStrictEqual(skipped, ['missing.ts']);
  } finally {
    cleanup(dir);
  }
});
