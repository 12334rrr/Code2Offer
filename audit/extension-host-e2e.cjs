/*
 * 真实 Extension Host 端到端验收启动器(人工验收清单 B 组自动化):
 * 起一个隔离的 VS Code 窗口(独立 user-data/extensions,不碰用户会话),
 * 以 --extensionTestsPath 注入 vscode/test-host/suite.cjs,在真窗口里驱动扩展命令、
 * 跑真实生成(DeepSeek 凭据经环境变量传入,与 .env 同源,不落盘)。
 * 套件把结果 JSON 写到 CIP_E2E_RESULT,本脚本轮询并判定。
 * 运行:node audit/extension-host-e2e.cjs [--mode economy|deep]
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// 注意:顶层 Code.exe 在本机是转发壳(--version 会吐 Node 版本),必须走 bin\code.cmd(真 VS Code CLI)
const candidates = [process.env.CODE_CMD, 'G:\\VSCode\\Microsoft VS Code\\bin\\code.cmd', 'C:\\Program Files\\Microsoft VS Code\\bin\\Code.cmd'].filter(Boolean);
const codeCmd = candidates.find((p) => fs.existsSync(p));
if (!codeCmd) { console.error('UNVERIFIED:未找到 VS Code CLI(code.cmd),请设置 CODE_CMD'); process.exit(2); }

/* DeepSeek 凭据:从 .env 读进子进程环境(不打印、不落盘;与扩展 loadConfig 的 env 源同源绑定) */
const env = { ...process.env, CIP_E2E_RESULT: path.join(os.tmpdir(), `cip-e2e-result-${Date.now()}.json`) };
const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']) {
  const m = envText.match(new RegExp(`^${k}=(.*)$`, 'm'));
  if (m) env[k] = m[1].trim();
}
if (!env.DEEPSEEK_API_KEY) { console.error('UNVERIFIED:.env 无 DEEPSEEK_API_KEY'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code2offer-e2e-'));
const args = [
  '--new-window', '--skip-welcome-page', '--disable-gpu',
  `--extensionDevelopmentPath=${path.join(root, 'vscode')}`,
  `--user-data-dir=${path.join(work, 'user-data')}`,
  `--extensions-dir=${path.join(work, 'extensions')}`,
  `--extensionTestsPath=${path.join(root, 'vscode', 'test-host', 'suite.cjs')}`,
  path.join(root, 'example-demo'),
];
console.log('启动真实 Extension Host(隔离窗口):', codeCmd);
const child = spawn('cmd.exe', ['/c', codeCmd, ...args], { env, stdio: 'ignore', windowsVerbatimArguments: false });

const deadline = Date.now() + 30 * 60_000;
(async () => {
  let raw = null;
  while (Date.now() < deadline) {
    try { raw = fs.readFileSync(env.CIP_E2E_RESULT, 'utf8'); if (raw.trim()) break; } catch { /* 尚未写入 */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  try { child.kill(); } catch { /* 已退出 */ }
  if (!raw) { console.error('✗ e2e 超时(30 分钟)未得到结果'); process.exit(1); }
  const res = JSON.parse(raw);
  console.log('\n===== 真实 Extension Host 端到端验收 =====');
  for (const [id, c] of Object.entries(res.checks || {})) console.log(`${c.ok ? '✓' : '✗'} ${id} — ${c.detail}`);
  if (res.notes?.length) console.log('备注:', res.notes.join(' | '));
  if (res.passed) console.log(`\nB 组 ${Object.keys(res.checks).length} 项全部通过(真实宿主)`);
  else { console.error('\n✗ 存在失败项:', (res.failures || []).join(' ; ')); process.exit(1); }
})().catch((e) => { try { child.kill(); } catch { /* */ } console.error(e.stack || e); process.exit(1); });
