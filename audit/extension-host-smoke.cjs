/*
 * 真正的 VS Code Extension Host 冒烟(不 require extension.js,不使用 mock vscode API)。
 * 运行: node audit/extension-host-smoke.cjs
 * 可用 CODE_EXE 覆盖 Code.exe 路径；该脚本只使用独立 user-data/extensions 临时目录。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// 顶层 Code.exe 在本机是转发壳(--version 吐 Node 版本),必须走 bin\code.cmd(真 VS Code CLI)
const candidates = [process.env.CODE_CMD, 'G:\\VSCode\\Microsoft VS Code\\bin\\code.cmd', 'C:\\Program Files\\Microsoft VS Code\\bin\\Code.cmd'].filter(Boolean);
const codeCmd = candidates.find((p) => fs.existsSync(p));
if (!codeCmd) { console.error('UNVERIFIED:未找到 VS Code CLI(code.cmd),请设置 CODE_CMD'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code2offer-extension-host-'));
const userData = path.join(work, 'user-data');
const extensions = path.join(work, 'extensions');
fs.mkdirSync(userData); fs.mkdirSync(extensions);
const args = [
  '--new-window', '--skip-welcome-page', '--disable-gpu',
  `--extensionDevelopmentPath=${path.join(root, 'vscode')}`,
  `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  path.join(root, 'example-demo'),
];
const child = spawn('cmd.exe', ['/c', codeCmd, ...args], { stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: false });
const deadline = Date.now() + 60_000; // 首次启动可能较慢

function allFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
function findLog() {
  return allFiles(path.join(userData, 'logs')).find((p) => /[\\/]exthost\.log$/.test(p));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

(async () => {
  let logPath;
  while (Date.now() < deadline) {
    logPath = findLog();
    if (logPath && /DawnofHope\.code-interview-prep/.test(fs.readFileSync(logPath, 'utf8'))) break;
    await sleep(250);
  }
  assert.ok(logPath, 'Extension Host 未生成 exthost.log');
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /ExtensionService#_doActivateExtension DawnofHope\.code-interview-prep/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vscode', 'package.json'), 'utf8'));
  const commands = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const command of ['codeInterviewPrep.generate', 'codeInterviewPrep.openReport', 'codeInterviewPrep.openQuality', 'codeInterviewPrep.cancelTask']) assert.ok(commands.has(command), `manifest 缺少命令 ${command}`);
  assert.ok(manifest.contributes.views.codeInterviewPrep.some((v) => v.id === 'codeInterviewPrep.panel'), 'manifest 缺少侧栏视图');
  console.log(JSON.stringify({ passed: true, realExtensionHost: true, extension: 'DawnofHope.code-interview-prep', activationLog: logPath, commands: commands.size, sidebar: 'codeInterviewPrep.panel', note: 'activation/manifest verified; interactive generation requires a user-selected mock endpoint in VS Code' }, null, 2));
  child.kill();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Code may still hold a log handle; temp path is disposable. */ }
})().catch((err) => { console.error(err.stack || err); child.kill(); process.exitCode = 1; });
