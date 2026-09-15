import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseFlags } from '../cli/index';

test('布尔旗标在前不吞位置参数(旧版 rehearse --top20 <目录> 直接失败)', () => {
  const { flags, positional } = parseFlags(['--top20', './out']);
  assert.strictEqual(flags.top20, true);
  assert.strictEqual(positional, './out');
});

test('值旗标消耗下一个参数', () => {
  const { flags, positional } = parseFlags(['--jd', 'jd.txt', './repo']);
  assert.strictEqual(flags.jd, 'jd.txt');
  assert.strictEqual(positional, './repo');
});

test('--force 在路径前仍为 true(旧版 force 变字符串导致 === true 判假)', () => {
  const { flags, positional } = parseFlags(['--force', './repo']);
  assert.strictEqual(flags.force, true);
  assert.strictEqual(positional, './repo');
});

test('位置参数在前 + 布尔旗标在后', () => {
  const { flags, positional } = parseFlags(['./out', '--count', '5', '--top20']);
  assert.strictEqual(positional, './out');
  assert.strictEqual(flags.count, '5');
  assert.strictEqual(flags.top20, true);
});

test('值旗标缺参数时报错', () => {
  assert.throws(() => parseFlags(['--count']), /需要一个参数值/);
  assert.throws(() => parseFlags(['--count', '--top20']), /需要一个参数值/);
});

test('多位置参数取第一个', () => {
  const { positional } = parseFlags(['a', 'b']);
  assert.strictEqual(positional, 'a');
});
