import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseEnvFile, loadConfig } from '../core/config';
import { makeTempDir, write, cleanup } from './helpers';

test('parseEnvFile:整行注释与空行跳过', () => {
  const out = parseEnvFile('# 注释\n\nDEEPSEEK_API_KEY=sk-x\n');
  assert.deepStrictEqual(out, { DEEPSEEK_API_KEY: 'sk-x' });
});

test('parseEnvFile:行内注释不并入未加引号的值', () => {
  const out = parseEnvFile('DEEPSEEK_API_KEY=sk-abc123 # 生产密钥\n');
  assert.strictEqual(out.DEEPSEEK_API_KEY, 'sk-abc123');
});

test('parseEnvFile:成对引号剥除,单侧引号保留', () => {
  const out = parseEnvFile('A="hello"\nB=\'world\'\nC="unbalanced\n');
  assert.strictEqual(out.A, 'hello');
  assert.strictEqual(out.B, 'world');
  assert.strictEqual(out.C, '"unbalanced');
});

test('loadConfig:受信目录 .env 提供密钥,仓库 .env 不得重定向端点(端点与凭据同源绑定)', () => {
  const host = makeTempDir('cip-host-');
  const repo = makeTempDir('cip-repo-');
  try {
    write(host, '.env', 'DEEPSEEK_API_KEY=sk-host-key\n');
    write(repo, '.env', 'DEEPSEEK_API_KEY=sk-repo-key\nDEEPSEEK_BASE_URL=http://evil.invalid\n');
    const cfg = loadConfig({ env: {}, trustedDirs: [host], repoDir: repo });
    assert.strictEqual(cfg.apiKey, 'sk-host-key');
    // 仓库的 BASE_URL 层级低于密钥来源 → 忽略,回落默认
    assert.strictEqual(cfg.baseUrl, 'https://api.deepseek.com');
  } finally {
    cleanup(host);
    cleanup(repo);
  }
});

test('loadConfig:仓库自带完整凭据对(key+url 同源)时其端点生效', () => {
  const repo = makeTempDir('cip-repo-');
  try {
    write(repo, '.env', 'DEEPSEEK_API_KEY=sk-repo-key\nDEEPSEEK_BASE_URL=https://gateway.example.com\n');
    const cfg = loadConfig({ env: {}, trustedDirs: [], repoDir: repo });
    assert.strictEqual(cfg.apiKey, 'sk-repo-key');
    assert.strictEqual(cfg.baseUrl, 'https://gateway.example.com');
  } finally {
    cleanup(repo);
  }
});

test('loadConfig:明文 HTTP 端点被拒绝(localhost 例外)', () => {
  const host = makeTempDir('cip-host-');
  const local = makeTempDir('cip-local-');
  try {
    write(host, '.env', 'DEEPSEEK_API_KEY=sk-x\nDEEPSEEK_BASE_URL=http://evil.invalid\n');
    assert.throws(() => loadConfig({ env: {}, trustedDirs: [host] }), /HTTPS/);
    write(local, '.env', 'DEEPSEEK_API_KEY=sk-x\nDEEPSEEK_BASE_URL=http://localhost:8000\n');
    const cfg = loadConfig({ env: {}, trustedDirs: [local] });
    assert.strictEqual(cfg.baseUrl, 'http://localhost:8000');
  } finally {
    cleanup(host);
    cleanup(local);
  }
});

test('loadConfig:overrides 模型名优先于一切文件', () => {
  const host = makeTempDir('cip-host-');
  const repo = makeTempDir('cip-repo-');
  try {
    write(host, '.env', 'DEEPSEEK_API_KEY=sk-x\nDEEPSEEK_MODEL=host-model\n');
    write(repo, '.env', 'DEEPSEEK_MODEL=repo-model\n');
    const cfg = loadConfig({ env: {}, trustedDirs: [host], repoDir: repo, overrides: { model: 'user-setting-model' } });
    assert.strictEqual(cfg.model, 'user-setting-model');
  } finally {
    cleanup(host);
    cleanup(repo);
  }
});

test('loadConfig:缺密钥给出可操作错误', () => {
  assert.throws(() => loadConfig({ env: {}, trustedDirs: [], repoDir: undefined }), /DEEPSEEK_API_KEY/);
});

test('loadConfig:Tavily 密钥只从环境变量或受信目录读取，不信任被分析仓库 .env', () => {
  const host = makeTempDir('cip-host-');
  const repo = makeTempDir('cip-repo-');
  try {
    write(host, '.env', 'DEEPSEEK_API_KEY=sk-host\nTAVILY_API_KEY=tvly-host\n');
    write(repo, '.env', 'TAVILY_API_KEY=tvly-untrusted\n');
    assert.equal(loadConfig({ env: {}, trustedDirs: [host], repoDir: repo }).tavilyApiKey, 'tvly-host');
    assert.equal(loadConfig({ env: { DEEPSEEK_API_KEY: 'sk-env' }, trustedDirs: [], repoDir: repo }).tavilyApiKey, undefined);
  } finally { cleanup(host); cleanup(repo); }
});
