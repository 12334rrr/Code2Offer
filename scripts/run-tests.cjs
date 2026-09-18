/*
 * 跨 Node 版本的测试启动器(0.9.2):
 * `node --test "glob"` 需要 Node ≥21(20.x 报 "Could not find"),目录参数又在 24.x 失效——
 * 这里用 fs 显式列出 dist/tests/*.test.js 再交给 --test,任何 ≥18 的 Node 行为一致。
 * 运行:npm test(等价于 node scripts/run-tests.cjs)
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../dist/tests');
if (!fs.existsSync(dir)) {
  console.error('dist/tests 不存在——先运行 npm run build');
  process.exit(1);
}
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));
if (!files.length) {
  console.error('dist/tests 下没有 *.test.js——先运行 npm run build');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
