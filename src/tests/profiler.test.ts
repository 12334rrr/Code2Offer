import { test } from 'node:test';
import * as assert from 'node:assert';
import { compileGitignorePattern, isIgnoredPath, profileRepo, IgnoreRule } from '../core/profiler';
import { makeTempDir, write, cleanup } from './helpers';

const rule = (pattern: string, base = ''): IgnoreRule | null => {
  const c = compileGitignorePattern(pattern);
  return c ? { ...c, base } : null;
};

const ignored = (path: string, patterns: string[]): boolean => {
  const rules = patterns.map((p) => rule(p)).filter((r): r is IgnoreRule => r !== null);
  return isIgnoredPath(path, rules);
};

test('gitignore:前导 / 锚定根路径(旧版静默失效)', () => {
  assert.strictEqual(ignored('build/out.js', ['/build']), true);
  assert.strictEqual(ignored('src/build/out.js', ['/build']), false); // 锚定:子目录不命中
  assert.strictEqual(ignored('dist/app.js', ['/dist/']), true);
});

test('gitignore:字符组(旧版整行跳过)', () => {
  assert.strictEqual(ignored('secret1.ts', ['secret[0-9].ts']), true);
  assert.strictEqual(ignored('secretX.ts', ['secret[0-9].ts']), false);
  assert.strictEqual(ignored('file_a.txt', ['file_[abc].txt']), true);
});

test('gitignore:globstar 与普通通配', () => {
  assert.strictEqual(ignored('a/b/c/secret.ts', ['**/secret.ts']), true);
  assert.strictEqual(ignored('logs/debug.log', ['*.log']), true);
  assert.strictEqual(ignored('src/logs/debug.log', ['*.log']), true); // 未锚定任意深度
  assert.strictEqual(ignored('dir/file.ts', ['dir/']), true); // 目录规则匹配其内容
});

test('gitignore:取反规则覆盖前面的忽略', () => {
  assert.strictEqual(ignored('logs/keep.log', ['*.log', '!keep.log']), false);
  assert.strictEqual(ignored('logs/drop.log', ['*.log', '!keep.log']), true);
});

test('gitignore:子目录规则只作用于其下(层叠 base)', () => {
  const inner = rule('*.tmp', 'sub');
  const outer = rule('*.log');
  assert.ok(inner && outer);
  assert.strictEqual(isIgnoredPath('sub/a.tmp', [inner, outer]), true);
  assert.strictEqual(isIgnoredPath('root/a.tmp', [inner, outer]), false); // 内层规则不越界
});

test('profileRepo:敏感文件绝不进入画像与精读清单', () => {
  const dir = makeTempDir('cip-sec-');
  try {
    write(dir, 'app.js', 'module.exports = { run() { return 1; } };\n');
    write(dir, '.env', 'DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n');
    write(dir, '.env.local', 'OTHER=1\n');
    write(dir, 'id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    write(dir, 'cert.pem', '-----BEGIN PRIVATE KEY-----\n');
    write(dir, 'db/credentials.json', '{"token":"abc"}\n');
    const facts = profileRepo(dir, 10);
    const all = [...facts.files, ...facts.readingPlan];
    assert.ok(!all.includes('.env'), '.env 不得进入画像');
    assert.ok(!all.includes('.env.local'));
    assert.ok(!all.includes('id_rsa'));
    assert.ok(!all.includes('cert.pem'));
    assert.ok(!all.includes('db/credentials.json'));
    assert.ok(facts.files.includes('app.js'));
    assert.ok(facts.skippedSensitive.length >= 4, `敏感清单:${facts.skippedSensitive.join(',')}`);
  } finally {
    cleanup(dir);
  }
});

test('profileRepo:内容级密钥特征的文件被跳过(改名也拦)', () => {
  const dir = makeTempDir('cip-sec2-');
  try {
    write(dir, 'config.js', 'module.exports = { key: "sk-abcdefghijklmnopqrst" };\n');
    write(dir, 'normal.js', 'module.exports = { ok: true };\n');
    const facts = profileRepo(dir, 10);
    assert.ok(!facts.files.includes('config.js'), '含 sk- 密钥特征的文件不得进入画像');
    assert.ok(facts.files.includes('normal.js'));
  } finally {
    cleanup(dir);
  }
});

test('profileRepo:gitignore 规则生效(根目录)', () => {
  const dir = makeTempDir('cip-gi-');
  try {
    write(dir, '.gitignore', '/build\n*.log\n');
    write(dir, 'src/app.js', 'console.log(1);\n');
    write(dir, 'build/gen.js', 'console.log(2);\n');
    write(dir, 'debug.log', 'log\n');
    const facts = profileRepo(dir, 10);
    assert.ok(facts.files.includes('src/app.js'));
    assert.ok(!facts.files.includes('build/gen.js'), '/build 规则应生效');
    assert.ok(!facts.files.includes('debug.log'));
  } finally {
    cleanup(dir);
  }
});
