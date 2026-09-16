import { test } from 'node:test';
import * as assert from 'node:assert';
import { compileGitignorePattern, isIgnoredPath, profileRepo, snapshotRepo, IgnoreRule } from '../core/profiler';
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

test('snapshotRepo:新增/删除/重命名会让画像门控失效,不读取文件内容', () => {
  const dir = makeTempDir('cip-snapshot-');
  try {
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const before = snapshotRepo(dir).hash;
    write(dir, 'src/new.ts', 'export const n = 2;\n');
    const after = snapshotRepo(dir).hash;
    assert.notEqual(after, before);
    assert.ok(snapshotRepo(dir).entries >= 3, '快照应包含目录与文件元数据');
  } finally { cleanup(dir); }
});

test('profileRepo:100-300KB 文本也必须经过分段密钥扫描', () => {
  const dir = makeTempDir('cip-large-secret-');
  try {
    const secret = 'sk-' + 'A'.repeat(24);
    // 放在 64KB 读取边界附近,覆盖分段扫描的跨块拼接场景。
    const filler = 'x'.repeat(65_530);
    write(dir, 'renamed-source.ts', `${filler}${secret}\n${'// filler\n'.repeat(16_000)}`);
    write(dir, 'normal.ts', 'export const safe = true;\n');
    const facts = profileRepo(dir, 10);
    assert.ok(!facts.files.includes('renamed-source.ts'));
    assert.ok(facts.skippedSensitive.includes('renamed-source.ts'));
    assert.equal(facts.skippedByReason['内容命中密钥特征'], 1);
  } finally { cleanup(dir); }
});

test('profileRepo:浏览器 profile/构建产物过滤,但不粗暴忽略有效 _devtools 脚本', () => {
  const dir = makeTempDir('cip-noise-');
  try {
    write(dir, 'edge_profile2/Default/Extensions/noise.js', 'const thirdPartyBundle = true;\n');
    write(dir, '_build_dist/generated.js', 'const generated = true;\n');
    write(dir, '_build_tmp/generated.json', '{"generated":true}\n');
    write(dir, '_devtools/bak_round2/old.js', 'const old = true;\n');
    write(dir, '_devtools/browsertest/npmcache/blob', 'cache\n');
    write(dir, 'old.js.bak_20260916', 'const old = true;\n');
    write(dir, 'scratch.tmp', 'temporary\n');
    write(dir, '_devtools/edge_profile_notes.ts', 'export const useful = true;\n');
    const facts = profileRepo(dir, 20);
    assert.ok(!facts.files.some((f) => f.startsWith('edge_profile2/')));
    assert.ok(!facts.files.some((f) => f.startsWith('_build_dist/')));
    assert.ok(!facts.files.some((f) => f.startsWith('_build_tmp/')));
    assert.ok(!facts.files.some((f) => f.startsWith('_devtools/bak_round2/')));
    assert.ok(!facts.files.some((f) => f.startsWith('_devtools/browsertest/npmcache/')));
    assert.ok(!facts.files.includes('old.js.bak_20260916'));
    assert.ok(!facts.files.includes('scratch.tmp'));
    assert.ok(facts.files.includes('_devtools/edge_profile_notes.ts'));
    assert.ok(facts.skippedByReason['浏览器用户目录/缓存'] >= 1);
    assert.ok(facts.skippedByReason['构建产物或工具缓存'] >= 1);
  } finally { cleanup(dir); }
});

test('profileRepo:多语言画像、manifest、路由和数据表线索', () => {
  const dir = makeTempDir('cip-languages-');
  try {
    write(dir, 'pubspec.yaml', 'name: demo\ndependencies:\n  flutter:\n  dio: ^5.0.0\n');
    write(dir, 'lib/main.dart', 'void main() {}\n');
    write(dir, 'src/main.rs', '#[get("/health")]\nfn health() {}\n');
    write(dir, 'routes/web.php', "Route::get('/users', fn () => 'ok');\nprotected $table = 'users';\n");
    write(dir, 'schema.prisma', 'model User {\n  id Int @id\n}\n');
    write(dir, 'Dockerfile', 'FROM node:22\n');
    const facts = profileRepo(dir, 20);
    assert.equal(facts.overview.languageNames?.Dart.files, 1);
    assert.equal(facts.overview.languageNames?.Rust.files, 1);
    assert.equal(facts.overview.languageNames?.PHP.files, 1);
    assert.equal(facts.overview.languageNames?.Dockerfile.files, 1);
    assert.ok(facts.overview.manifests.some((m) => m.kind === 'dart'));
    assert.ok(facts.routes.some((r) => r.method === 'GET' && r.route === '/users'));
    assert.ok(facts.routes.some((r) => r.method === 'GET' && r.route === '/health'));
    assert.ok(facts.dbTables.some((t) => t.table === 'users'));
    assert.ok(facts.dbTables.some((t) => t.table === 'User'));
  } finally { cleanup(dir); }
});
