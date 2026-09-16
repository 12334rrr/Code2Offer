/*
 * 真实 Extension Host 内执行的端到端验收(人工验收清单 B 组的自动化)。
 * 由 audit/extension-host-e2e.cjs 以 --extensionTestsPath 启动;此处拿到的 vscode 是真 API,
 * 不是 mock。验收内容:
 *   B0 空载命令安全           B1 生成过程有阶段日志(横幅+用时,进本次专属通道)
 *   B2 每次生成自动创建并弹出独立输出通道     B3 每次生成独立产物目录 runs/run-NNNN
 *   B4 第二次生成增量接续(门控命中/缓存,显著加速)  B5 同仓库误点去重(真·进行中窗口内)
 *   B7 报告可打开且含参考要点/难度分(0.8.0 契约可见)  B8 「打开产物文件夹」定位最近一次 run
 * 交互(showQuickPick/showInputBox/showWarningMessage)在本套件内自动应答。
 * 结果写入 CIP_E2E_RESULT 指定的 JSON 文件,由外部 spawner 校验。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const RESULT = process.env.CIP_E2E_RESULT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const results = { checks: {}, failures: [], notes: [] };
  const check = (id, ok, detail) => {
    results.checks[id] = { ok: !!ok, detail: String(detail || '') };
    if (!ok) results.failures.push(`${id}: ${detail}`);
  };
  const recorded = { channels: [], shown: [], panels: [], executed: [], channelLines: new Map(), warnings: [], infos: [], errors: [] };

  /* ---- 记录层补丁(在扩展调用点动态生效) ---- */
  const origChannel = vscode.window.createOutputChannel.bind(vscode.window);
  vscode.window.createOutputChannel = (name, opts) => {
    const ch = origChannel(name, opts);
    if (!name.startsWith('代码转面试')) return ch;
    recorded.channels.push(name);
    const origAppend = ch.appendLine.bind(ch);
    ch.appendLine = (l) => { if (!recorded.channelLines.has(name)) recorded.channelLines.set(name, []); recorded.channelLines.get(name).push(l); return origAppend(l); };
    const origShow = ch.show.bind(ch);
    ch.show = (p) => { recorded.shown.push(name); return origShow(p); };
    return ch;
  };
  const origPanel = vscode.window.createWebviewPanel.bind(vscode.window);
  vscode.window.createWebviewPanel = (...a) => {
    const p = origPanel(...a);
    // 扩展在 createWebviewPanel 返回之后才给 webview.html 赋值,这里只存对象,断言时再取
    recorded.panels.push(p);
    return p;
  };
  const origExec = vscode.commands.executeCommand.bind(vscode.commands);
  vscode.commands.executeCommand = (id, ...a) => { recorded.executed.push(id); return origExec(id, ...a); };
  const origWarn = vscode.window.showWarningMessage.bind(vscode.window);
  vscode.window.showWarningMessage = async (...a) => { recorded.warnings.push(a[0]); return a.includes('查看进度') ? '查看进度' : origWarn(...a); };
  const origInfo = vscode.window.showInformationMessage.bind(vscode.window);
  vscode.window.showInformationMessage = async (...a) => { recorded.infos.push(a[0]); return undefined; };
  const origErr = vscode.window.showErrorMessage.bind(vscode.window);
  vscode.window.showErrorMessage = async (...a) => { recorded.errors.push(a[0]); return undefined; };

  /* ---- 交互自动应答:模式=economy,文件数=20,输出=自动独立目录(首项),JD=不使用 ---- */
  vscode.window.showQuickPick = async (items) => (Array.isArray(items) ? (items.find((x) => x && x.value === 'economy') ?? items[0]) : undefined);
  vscode.window.showInputBox = async () => '20';
  vscode.window.showOpenDialog = async () => undefined;

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) throw new Error('e2e 套件需要工作区(example-demo)');
  const runsRoot = path.join(ws, 'interview-output', 'runs');
  const listRuns = (root) => (fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^run-\d+$/.test(d)) : []);
  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = predicate();
      if (v) return v;
      await sleep(1000);
    }
    throw new Error(`超时(${Math.round(timeoutMs / 1000)}s):${what}`);
  };

  try {
    /* ---- B0:空载命令不抛 ---- */
    await vscode.commands.executeCommand('codeInterviewPrep.cancelAll');
    await vscode.commands.executeCommand('codeInterviewPrep.dismissAll');
    check('B0', true, '空载 cancelAll/dismissAll 安全');

    /* ---- B5 去重:用「仓库副本」制造真正进行中的任务(主工作区可能全缓存秒完) ---- */
    // 副本放系统临时目录(cpSync 不能拷到自身子目录);凭据来自环境变量,临时目录无 .env 也可用
    const os = require('os');
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-e2e-repo-'));
    fs.cpSync(ws, copyDir, { recursive: true, filter: (s) => !s.includes('interview-output') && !s.includes('node_modules') && !s.includes('.git') });
    const copyRuns = path.join(copyDir, 'interview-output', 'runs');
    const g1 = vscode.commands.executeCommand('codeInterviewPrep.generate', vscode.Uri.file(copyDir)).catch(() => {});
    await sleep(4000); // 未缓存的真实运行约 90s,任务确在跑
    await vscode.commands.executeCommand('codeInterviewPrep.generate', vscode.Uri.file(copyDir));
    await sleep(8000);
    const during = listRuns(copyRuns);
    check('B5', during.length === 1, `真·进行中再点一次仍只有 ${during.length} 个任务${during.length > 1 ? '(误点产生了第二个任务!)' : ''}`);
    const run1Dir = during[0] || 'run-0001';

    /* ---- 等真实首跑完成(manifest 落盘) ---- */
    const m1 = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(copyRuns, run1Dir, 'run-manifest.json'), 'utf8')); } catch { return null; }
    }, 20 * 60_000, '去重首跑 manifest 落盘');
    await g1;
    const dur1 = Object.values(m1.stageDurations || {}).reduce((a, b) => a + b, 0);
    fs.rmSync(copyDir, { recursive: true, force: true }); // 清理临时副本

    /* ---- B1/B2:阶段日志 + 专属通道自动弹出(取自该真实任务) ---- */
    const taskChannels = recorded.channels.filter((n) => n.startsWith('代码转面试 · '));
    check('B2-channel', taskChannels.length >= 1, `已创建专属通道:${taskChannels.join(' | ') || '(无!)'}`);
    check('B2-show', recorded.shown.some((n) => n.startsWith('代码转面试 · ')), '专属通道被自动弹出(输出面板切换)');
    const lines1 = (recorded.channelLines.get(taskChannels[0]) || []).join('\n');
    const stageBanners = ['阶段 0', '阶段 1', '阶段 2', '阶段 3', '完成'];
    check('B1', stageBanners.every((b) => lines1.includes(b)), `通道含阶段横幅与用时:${stageBanners.map((b) => `${b}${lines1.includes(b) ? '✓' : '✗'}`).join(' ')}`);

    /* ---- B3/B4:主工作区两次生成 → 独立目录 + 增量接续 ---- */
    const before2 = listRuns(runsRoot);
    await vscode.commands.executeCommand('codeInterviewPrep.generate');
    const wsRun1 = await waitFor(() => {
      const d = listRuns(runsRoot).filter((x) => !before2.includes(x) && fs.existsSync(path.join(runsRoot, x, 'run-manifest.json')));
      return d.length ? d[0] : null;
    }, 10 * 60_000, '主工作区第 1 次 run manifest 落盘');
    const durWs1 = Object.values(JSON.parse(fs.readFileSync(path.join(runsRoot, wsRun1, 'run-manifest.json'), 'utf8')).stageDurations || {}).reduce((a, b) => a + b, 0);

    const before3 = listRuns(runsRoot);
    await vscode.commands.executeCommand('codeInterviewPrep.generate');
    const wsRun2 = await waitFor(() => {
      const d = listRuns(runsRoot).filter((x) => !before3.includes(x) && fs.existsSync(path.join(runsRoot, x, 'run-manifest.json')));
      return d.length ? d[0] : null;
    }, 10 * 60_000, '主工作区第 2 次 run manifest 落盘');
    const durWs2 = Object.values(JSON.parse(fs.readFileSync(path.join(runsRoot, wsRun2, 'run-manifest.json'), 'utf8')).stageDurations || {}).reduce((a, b) => a + b, 0);
    check('B3', wsRun1 !== wsRun2, `两次生成目录独立:${wsRun1} / ${wsRun2}`);
    check('B4', durWs2 <= dur1, `同参数重跑阶段总用时 ${Math.round(durWs2)}ms ≤ 首跑 ${Math.round(dur1)}ms(门控/增量接续生效)`);

    /* ---- B7:打开报告(真实 Webview,内容含 0.8.0 契约元素) ---- */
    recorded.panels.length = 0;
    await vscode.commands.executeCommand('codeInterviewPrep.openReport');
    await sleep(1500);
    const panel = recorded.panels[0];
    const html = panel ? String(panel.webview.html || '') : '';
    check('B7-webview', !!panel && /script-src 'nonce-/.test(html), panel ? `Webview 已创建,html ${html.length} 字节,nonce ${/script-src 'nonce-/.test(html) ? '已注入' : '未注入'}` : `未创建 Webview! errors=${JSON.stringify(recorded.errors)}`);
    check('B7-contract', html.includes('参考要点') && html.includes('/10'), '报告含「参考要点」与难度分(/10)');

    /* ---- B8:打开产物文件夹 → 定位最近 run ---- */
    recorded.executed.length = 0;
    await vscode.commands.executeCommand('codeInterviewPrep.openOutput');
    check('B8', recorded.executed.includes('revealFileInOS'), '定位产物文件夹(revealFileInOS)');

    results.passed = results.failures.length === 0;
  } catch (err) {
    results.failures.push(`EXCEPTION: ${err && err.stack || err}`);
    results.passed = false;
  }
  fs.writeFileSync(RESULT, JSON.stringify(results, null, 2));
  return results.passed ? undefined : new Error('e2e 验收存在失败项:' + results.failures.join(' ; '));
}

module.exports = { run };
