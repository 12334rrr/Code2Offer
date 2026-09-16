/*
 * 缺陷回归门禁:0.3.0 全面审计的 15 个缺陷探针(core-regressions.cjs)必须**全部不可复现**。
 * 探针语义:PASS = 缺陷存在(被复现);FAIL = 缺陷保持修复状态。
 * 本门禁在 CI 中运行:任何一条探针重新复现 → 退出码 1,发布被拦截。
 * 运行:node audit/regression-gate.cjs(需先 npm run build)
 */
'use strict';
const { execFileSync } = require('child_process');

let out = '';
try {
  out = execFileSync(process.execPath, ['audit/core-regressions.cjs'], { encoding: 'utf8' });
} catch (err) {
  out = String((err && err.stdout) || '') + String((err && err.stderr) || '');
}
const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ fail (\d+)/);
if (!m) {
  console.error('✗ 无法解析探针输出(测试运行器崩溃?):\n' + out.slice(-2000));
  process.exit(1);
}
const total = Number(m[1]);
const reproduced = total - Number(m[2]); // fail = 不可复现 = 已修复;pass = 复现 = 回归
if (reproduced > 0) {
  console.error(`✗ 回归!${reproduced}/${total} 个历史缺陷探针重新复现(修复被破坏):`);
  for (const line of out.split('\n')) if (/^✔\s+C\d/.test(line.trim())) console.error('  ' + line.trim());
  process.exit(1);
}
console.log(`✓ 全部 ${total} 个历史缺陷探针保持"不可复现"——0.3.0 审计缺陷无一回归`);
