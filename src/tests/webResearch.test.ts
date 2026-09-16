import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TavilyResearch, validatePublicQuery } from '../core/webResearch';
import { makeTempDir, cleanup } from './helpers';

test('TavilyResearch:未配置密钥时不发起请求，基础流程可离线运行', async () => {
  const dir = makeTempDir();
  try {
    const research = new TavilyResearch({ cacheDir: dir });
    assert.equal(research.enabled(), false);
    assert.deepEqual(await research.searchPublicTechnicalFact('TypeScript decorators official documentation'), []);
  } finally { cleanup(dir); }
});

test('validatePublicQuery:拒绝把私有代码、路径或密钥送往 Tavily', () => {
  assert.equal(validatePublicQuery('  Node.js AbortSignal timeout  '), 'Node.js AbortSignal timeout');
  for (const unsafe of ['C:\\Users\\hp\\private.ts', '/home/user/project', 'const secret = sk-abcdefghijk', 'line one\nline two']) {
    assert.throws(() => validatePublicQuery(unsafe), /不能包含代码、路径或密钥/);
  }
});
