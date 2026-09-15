/** Offline extension audit. No VS Code host, network, real secrets, or repository writes. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const esbuild = require('../vscode/node_modules/esbuild');
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'vscode/src/extension.ts');

function zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw Error('ZIP directory missing');
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw Error('ZIP entry invalid');
    const nameLength = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString();
    const compressedSize = buf.readUInt32LE(at + 20);
    const method = buf.readUInt16LE(at + 10);
    const offset = buf.readUInt32LE(at + 42);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const compressed = buf.subarray(start, start + compressedSize);
    const bytes = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    entries.set(name, bytes);
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

const A = path.join(path.parse(root).root, 'audit-virtual-only', 'workspace-a');
const B = path.join(path.parse(root).root, 'audit-virtual-only', 'workspace-b');
const GLOBAL = path.join(path.parse(root).root, 'audit-virtual-only', 'global');
const uri = (fsPath) => ({ fsPath, scheme: 'file' });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function host(code, bundled, options = {}) {
  const commands = new Map();
  const calls = { pipeline: [], errors: [], information: [], executed: [], progress: [], panels: [], configurations: 0, outputChannels: 0 };
  const env = {};
  const files = new Map(Object.entries(options.files || {}));
  let active = 0, maxActive = 0;
  const vscode = {
    commands: {
      registerCommand: (name, fn) => (commands.set(name, fn), { dispose() {} }),
      executeCommand: async (...args) => { calls.executed.push(args); },
    },
    workspace: {
      workspaceFolders: (options.workspaces || [A]).map((p) => ({ uri: uri(p), name: path.basename(p) })),
      getConfiguration: () => { calls.configurations++; return { get: () => 'configured-model' }; },
    },
    window: {
      showQuickPick: async () => options.cancelQuickPick ? undefined : { value: !!options.useJd },
      showOpenDialog: async () => options.cancelDialog ? undefined : [uri(path.join(A, 'jd.txt'))],
      showWorkspaceFolderPick: async () => ({ uri: uri(options.selectedWorkspace || A) }),
      showErrorMessage: (m) => { calls.errors.push(m); },
      showInformationMessage: async (...args) => { calls.information.push(args); return options.informationPick; },
      withProgress: async (opts, fn) => { calls.progress.push(opts); return fn({ report() {} }, { isCancellationRequested: false }); },
      createTreeView: (_id, opts) => { calls.tree = opts.treeDataProvider; return { dispose() {} }; },
      createOutputChannel: () => { calls.outputChannels++; return { appendLine() {}, dispose() {} }; },
      createWebviewPanel: (...args) => { const panel = { args, webview: {} }; calls.panels.push(panel); return panel; },
    },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { One: 1 },
    TreeItemCollapsibleState: { None: 0 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    Uri: { file: uri },
  };
  const mockFs = {
    existsSync: (p) => files.has(path.normalize(p)),
    readFileSync: (p) => { if (!files.has(path.normalize(p))) throw Error('Mock file missing: ' + p); return files.get(path.normalize(p)); },
  };
  const runPipeline = async (opts) => {
    calls.pipeline.push({ repoPath: opts.repoPath, jdPath: opts.jdPath ?? null, env: { ...env }, optionNames: Object.keys(opts) });
    maxActive = Math.max(maxActive, ++active);
    if (options.pipelineGate) await options.pipelineGate;
    active--;
    return { outDir: path.join(opts.repoPath, 'interview-output') };
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports,
    require: (name) => {
      if (name === 'vscode') return vscode;
      if (name === 'fs') return mockFs;
      if (name === 'path') return path;
      if (name === '../../src/core/runner') return { runPipeline };
      if (name === 'crypto') return crypto;
      if (name === 'child_process') return { execSync() { throw Error('Audit blocks subprocess execution'); } };
      throw Error('Unexpected require blocked: ' + name);
    },
    process: { env, cwd: () => path.join(GLOBAL, 'empty-cwd') },
    console: { log() {}, warn() {}, error() {} },
    __dirname: path.join(GLOBAL, 'extension', 'dist'),
    __auditRunPipeline: runPipeline,
    setTimeout, clearTimeout,
  };
  if (bundled) code += '\nrunPipeline = __auditRunPipeline;';
  vm.runInNewContext(code, context, { filename: bundled ? 'published-extension.js' : 'source-extension.js' });
  const extensionContext = { subscriptions: [], globalStorageUri: uri(GLOBAL) };
  module.exports.activate(extensionContext);
  return { commands, calls, files, env, get maxActive() { return maxActive; } };
}

async function exercise(label, code, bundled) {
  const result = { label };
  const normal = host(code, bundled, { files: { [path.join(A, '.env')]: 'DEEPSEEK_API_KEY=audit-key-A\nDEEPSEEK_MODEL=model-A\nDEEPSEEK_BASE_URL=https://endpoint-a.invalid\n', [path.join(B, '.env')]: 'DEEPSEEK_API_KEY=audit-key-B\nDEEPSEEK_MODEL=model-B\nDEEPSEEK_BASE_URL=https://endpoint-b.invalid\n' } });
  await normal.commands.get('codeInterviewPrep.generate')(uri(A));
  await normal.commands.get('codeInterviewPrep.generate')(uri(B));
  result.crossRepositoryConfiguration = { expectedKeys: ['audit-key-A', 'audit-key-B'], actualKeys: normal.calls.pipeline.map((x) => x.env.DEEPSEEK_API_KEY), actualModels: normal.calls.pipeline.map((x) => x.env.DEEPSEEK_MODEL), actualEndpoints: normal.calls.pipeline.map((x) => x.env.DEEPSEEK_BASE_URL) };
  const canceled = host(code, bundled, { cancelQuickPick: true });
  await canceled.commands.get('codeInterviewPrep.generate')();
  result.cancelQuickPick = { expectedPipelineRuns: 0, actualPipelineRuns: canceled.calls.pipeline.length };
  const canceledDialog = host(code, bundled, { useJd: true, cancelDialog: true });
  await canceledDialog.commands.get('codeInterviewPrep.generate')();
  result.cancelJdFilePicker = { expectedPipelineRuns: 0, actualPipelineRuns: canceledDialog.calls.pipeline.length, passedJd: canceledDialog.calls.pipeline[0]?.jdPath };
  let release;
  const pipelineGate = new Promise((resolve) => { release = resolve; });
  const concurrent = host(code, bundled, { pipelineGate });
  const one = concurrent.commands.get('codeInterviewPrep.generate')(uri(A));
  const two = concurrent.commands.get('codeInterviewPrep.generate')(uri(A));
  await new Promise((resolve) => setImmediate(resolve));
  result.sameRepositoryConcurrency = { expectedMaximumActive: 1, actualMaximumActive: concurrent.maxActive, progressIsCancellable: concurrent.calls.progress[0].cancellable };
  release();
  await Promise.all([one, two]);
  const multi = host(code, bundled, { workspaces: [A, B], selectedWorkspace: B, files: { [path.join(B, 'interview-output/index.html')]: '<html><head></head><body><script>void 0;</script></body></html>' } });
  await multi.commands.get('codeInterviewPrep.generate')();
  await multi.commands.get('codeInterviewPrep.openReport')();
  await multi.commands.get('codeInterviewPrep.openOutput')();
  result.multiRootReopen = { generatedRepository: multi.calls.pipeline[0].repoPath, openedPanels: multi.calls.panels.length, errors: multi.calls.errors };
  const nested = path.join(A, 'nested-project');
  const nestedHost = host(code, bundled, { files: { [path.join(nested, 'interview-output/index.html')]: '<html><head></head><body></body></html>' } });
  await nestedHost.commands.get('codeInterviewPrep.generate')(uri(nested));
  await nestedHost.commands.get('codeInterviewPrep.openReport')();
  result.nestedFolderReopen = { generatedRepository: nestedHost.calls.pipeline[0].repoPath, openedPanels: nestedHost.calls.panels.length, errors: nestedHost.calls.errors };
  await normal.commands.get('codeInterviewPrep.openSettings')();
  result.settings = { settingsCommand: normal.calls.executed[0], expectedExtensionId: 'DawnofHope.code-interview-prep', getConfigurationCalls: normal.calls.configurations, pipelineOptionNames: normal.calls.pipeline[0].optionNames };
  result.statusAndLogs = { treeHasChangeEvent: 'onDidChangeTreeData' in normal.calls.tree, outputChannels: normal.calls.outputChannels };
  const malformed = host(code, bundled, { files: { [path.join(A, 'interview-output/index.html')]: '<html><HEAD></HEAD><body><script>globalThis.auditProof=true;</script></body></html>' } });
  await malformed.commands.get('codeInterviewPrep.openReport')();
  result.webviewCapitalHead = { scriptsEnabled: malformed.calls.panels[0].args[3].enableScripts, containsCsp: malformed.calls.panels[0].webview.html.includes('Content-Security-Policy'), firstScriptReceivesNonce: malformed.calls.panels[0].webview.html.includes('<script nonce=') };
  return result;
}

(async () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transformed = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node', target: 'node18' }).code;
  const vsixPath = path.join(root, 'vscode/code-interview-prep-0.2.3.vsix');
  const entries = zipEntries(vsixPath);
  const manifest = JSON.parse(entries.get('extension/package.json').toString());
  const bundle = entries.get('extension/dist/extension.js').toString();
  const sourceMap = JSON.parse(entries.get('extension/dist/extension.js.map').toString());
  const packagedSource = entries.get('extension/src/extension.ts').toString();
  const output = {
    executedAt: new Date().toISOString(),
    runtime: process.version,
    scope: 'Offline VM mocks; no genuine VS Code extension host and no network requests. All keys/endpoints above are synthetic.',
    package: {
      file: path.relative(root, vsixPath), sha256: sha(fs.readFileSync(vsixPath)),
      version: manifest.version, extensionId: manifest.publisher + '.' + manifest.name,
      entries: [...entries].map(([name, bytes]) => ({ name, bytes: bytes.length })),
      packageSourceEqualsWorkingSource: source === packagedSource,
      packagedBundleEqualsCurrentDist: bundle === fs.readFileSync(path.join(root, 'vscode/dist/extension.js'), 'utf8'),
      sourceMapFiles: sourceMap.sources,
      sourceMapEmbeddedSources: sourceMap.sourcesContent?.length,
      hasLicense: !!manifest.license || [...entries.keys()].some((x) => /license/i.test(x)),
      hasRepository: !!manifest.repository,
      hasCapabilities: !!manifest.capabilities,
    },
    results: [await exercise('working-source', transformed, false), await exercise('local-published-vsix-0.2.3', bundle, true)],
  };
  const report = path.join(__dirname, 'extension-regressions.json');
  fs.writeFileSync(report, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
