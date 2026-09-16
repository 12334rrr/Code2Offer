import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isSourceLikePath, languageForPath, languageStatsFor } from '../core/languages';

test('languages:覆盖常见多语言扩展名与无扩展名工程文件', () => {
  assert.equal(languageForPath('lib/main.dart'), 'Dart');
  assert.equal(languageForPath('src/main.rs'), 'Rust');
  assert.equal(languageForPath('api/routes.php'), 'PHP');
  assert.equal(languageForPath('build.gradle.kts'), 'Kotlin');
  assert.equal(languageForPath('Dockerfile'), 'Dockerfile');
  assert.equal(languageForPath('CMakeLists.txt'), 'CMake');
  assert.equal(isSourceLikePath('scripts/deploy.ps1'), true);
  assert.equal(isSourceLikePath('README.md'), true);
  assert.equal(isSourceLikePath('photo.png'), false);
});

test('languages:同一语言的多个扩展名合并统计并保留扩展名明细', () => {
  const contents = new Map([
    ['a.ts', 'const a = 1;\n'],
    ['b.tsx', 'export const B = () => null;\n'],
    ['main.py', 'print(1)\n'],
  ]);
  const stats = languageStatsFor([...contents.keys()], contents, (text) => text.split(/\r?\n/).filter(Boolean).length);
  assert.deepEqual(stats.TypeScript, { files: 2, loc: 2, extensions: ['.ts', '.tsx'] });
  assert.deepEqual(stats.Python, { files: 1, loc: 1, extensions: ['.py'] });
});
