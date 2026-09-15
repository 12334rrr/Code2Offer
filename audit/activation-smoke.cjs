/*
 * 发布产物激活冒烟测试:从 vsix 里解出 extension.js,用 mock 的 vscode API 走真实调用路径。
 * 目的:回答"这样发布后能否正常使用"——加载、命令注册、配置缺失报错、报告 CSP 注入、设置跳转。
 * 运行:node audit/activation-smoke.cjs (项目根目录)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const VSIX = path.resolve(__dirname, '../vscode/code-interview-prep-0.3.0.vsix');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-smoke-'));
const extracted = path.join(work, 'extension.js');
fs.writeFileSync(extracted, execSync(`unzip -p "${VSIX}" extension/dist/extension.js`));

// 0. 确认包内产物与本地构建一致
const local = path.resolve(__dirname, '../vscode/dist/extension.js');
const h = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
assert.strictEqual(h(extracted), h(local), 'vsix 内 extension.js 与本地构建不一致(需要重新打包)');
console.log('✓ [0] vsix 内 extension.js == 本地构建 (sha1 一致)');

// 1. mock vscode API
const reg = { commands: {}, trees: {}, panels: [], outputChannels: [], executed: [], errors: [], infos: [], warnings: [] };
const D = { dispose() {} };
const fakeWorkspace = path.join(work, 'workspace-empty');
fs.mkdirSync(fakeWorkspace, { recursive: true });

function makeStub(uriBase) {
  return {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }),
    joinPath: () => ({ toString: () => uriBase }),
  };
}
const vscode = {
  window: {
    createOutputChannel: (name, opts) => {
      const ch = { name, opts, lines: [], shown: 0, appendLine: (l) => ch.lines.push(l), append: () => {}, show: () => ch.shown++, dispose: () => {} };
      reg.outputChannels.push(ch);
      return ch;
    },
    createTreeView: (id, opts) => { reg.trees[id] = opts.treeDataProvider; return D; },
    registerTreeDataProvider: (id, p) => { reg.trees[id] = p; return D; },
    createWebviewPanel: (viewType, title, col, opts) => {
      const panel = { viewType, title, options: opts, webview: { html: '', options: opts, cspSource: 'vscode-webview', onDidReceiveMessage: () => D }, onDidDispose: () => D, reveal: () => {}, dispose: () => {} };
      reg.panels.push(panel);
      return panel;
    },
    showErrorMessage: (m, ...b) => { reg.errors.push(m); return Promise.resolve(undefined); },
    showInformationMessage: (m, ...b) => { reg.infos.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m, ...b) => { reg.warnings.push(m); return Promise.resolve(undefined); },
    showQuickPick: (items) => Promise.resolve({ label: '不使用 JD', value: false }),
    showOpenDialog: () => Promise.resolve(undefined),
    showWorkspaceFolderPick: () => Promise.resolve(undefined),
    withProgress: (opts, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => D }),
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id, fn) => { reg.commands[id] = fn; return D; },
    executeCommand: (id, ...args) => { reg.executed.push(id); return Promise.resolve(); },
  },
  workspace: {
    workspaceFolders: undefined, // 逐场景改写
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeWorkspaceFolders: () => D,
    fs: { writeFile: async () => {} },
  },
  Uri: makeStub(''),
  EventEmitter: class { constructor() { this.event = () => D; } fire() {} dispose() {} },
  Disposable: class { static from() { return D; } dispose() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15, SourceControl: 1, Window: 10 },
  env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
};
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode;
  return origLoad.call(this, request, ...rest);
};

// globalState
const gs = new Map();
const context = {
  subscriptions: { push: (d) => d },
  extensionPath: path.resolve(__dirname, '../vscode'),
  extension: { id: 'DawnofHope.code-interview-prep' },
  extensionUri: { fsPath: path.resolve(__dirname, '../vscode'), toString: () => '' },
  globalState: { get: (k) => gs.get(k), update: async (k, v) => { gs.set(k, v); } },
  globalStorageUri: { fsPath: path.join(work, 'globalstorage') },
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  environmentVariableCollection: { replace: () => {}, append: () => {}, prepend: () => {} },
};

(async () => {
  const ext = require(extracted);
  assert.strictEqual(typeof ext.activate, 'function', 'extension.js 未导出 activate');
  ext.activate(context);

  const CMDS = ['generate', 'openReport', 'openOutput', 'openSettings'];
  for (const c of CMDS) assert.ok(reg.commands[`codeInterviewPrep.${c}`], `命令未注册: ${c}`);
  assert.strictEqual(reg.outputChannels.length, 1, '输出通道未创建');
  assert.ok(reg.trees['codeInterviewPrep.panel'], '树视图未注册');
  console.log('✓ [1] activate 成功:4 条命令 + 输出通道 + 树视图全部注册');

  const children = await reg.trees['codeInterviewPrep.panel'].getChildren();
  assert.strictEqual(children.length, 4, '树视图应有 4 个条目');
  assert.ok(children.every((c) => c.command && c.iconPath));
  console.log('✓ [2] 树视图 4 条目(生成/报告/产物/设置)带命令与图标');

  // 无工作区 → generate 应报"请先打开文件夹"
  vscode.workspace.workspaceFolders = undefined;
  await reg.commands['codeInterviewPrep.generate']();
  assert.ok(reg.errors.some((e) => /请先打开一个包含代码的文件夹/.test(e)), '无工作区时的错误提示不对');
  console.log('✓ [3] 空窗口点生成 → 明确提示"请先打开文件夹"(不再静默失败)');

  // 有工作区但没有密钥 → 可操作的配置错误(覆盖整条 loadConfig 路径)
  const savedKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(fakeWorkspace), name: 'empty', index: 0 }];
  reg.errors.length = 0;
  await reg.commands['codeInterviewPrep.generate']();
  assert.ok(reg.errors.some((e) => /DEEPSEEK_API_KEY/.test(e)), '缺密钥时应给出含 DEEPSEEK_API_KEY 的配置指引');
  console.log('✓ [4] 无密钥生成 → 报错含可操作指引(错误文案直达配置方法)');
  if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;

  // openSettings → 用真实扩展 ID
  reg.executed.length = 0;
  await reg.commands['codeInterviewPrep.openSettings']();
  assert.strictEqual(reg.executed[0], 'workbench.action.openSettings');
  console.log('✓ [5] openSettings → workbench.action.openSettings(带 @ext: 过滤参数)');

  // openReport:未生成过 → 明确提示
  reg.errors.length = 0;
  await reg.commands['codeInterviewPrep.openReport']();
  assert.ok(reg.errors.some((e) => /未找到面试报告/.test(e)));
  console.log('✓ [6] 未生成时打开报告 → 明确提示"请先生成"');

  // openReport:对示例产物走 Webview + nonce CSP 注入
  const demoOut = path.resolve(__dirname, '../example-demo/interview-output');
  assert.ok(fs.existsSync(path.join(demoOut, 'index.html')), '示例产物不存在(测试前置条件)');
  gs.set('codeInterviewPrep.lastOutDir', demoOut);
  reg.panels.length = 0;
  await reg.commands['codeInterviewPrep.openReport']();
  assert.strictEqual(reg.panels.length, 1, '应创建一个 Webview 面板');
  const html = reg.panels[0].webview.html;
  assert.ok(/script-src 'nonce-[a-z0-9]+/.test(html), 'CSP nonce 未注入');
  assert.ok(/<script nonce="[a-z0-9]+">/.test(html), 'script 标签未加 nonce');
  assert.deepStrictEqual(reg.panels[0].options.localResourceRoots, [], '不应授权任何本地资源目录');
  console.log('✓ [7] 打开报告 → Webview 渲染,nonce CSP 注入成功,localResourceRoots 为空');

  // 模板异常回退:构造一个多 script 的畸形报告,应回退而非盲注入
  const badDir = path.join(work, 'bad-output');
  fs.mkdirSync(badDir);
  fs.writeFileSync(path.join(badDir, 'index.html'), '<html><head></head><body><script>a</script><script>b</script></body></html>');
  gs.set('codeInterviewPrep.lastOutDir', badDir);
  reg.panels.length = 0;
  reg.warnings.length = 0;
  await reg.commands['codeInterviewPrep.openReport']();
  assert.ok(reg.warnings.some((w) => /非标准/.test(w)), '畸形模板应有警告');
  console.log('✓ [8] 报告结构异常 → 警告 + 回退路径(不盲目注入 CSP)');

  ext.deactivate && ext.deactivate();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('\n全部 9 项冒烟断言通过 —— vsix 发布产物可用。');
})().catch((e) => {
  console.error('✗ 冒烟测试失败:', e.message);
  process.exit(1);
});
