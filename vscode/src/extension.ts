import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runPipeline, StageEvent } from '../../src/core/runner';
import { loadConfig, AppConfig } from '../../src/core/config';
import { setLogger } from '../../src/core/logger';
import { RunMode, estimatedCalls, modeLabel } from '../../src/core/policy';
import { latestRunDir } from '../../src/core/runs';
import { diagnoseDeepSeek } from '../../src/core/diagnostics';

/**
 * 「Code2Offer(代码转面试)」VSCode 扩展薄壳。
 *
 * 0.4.0 面板升级(用户需求:误点多次可逐个叉掉 + 阶段时间轴):
 * - 多任务并发:不同仓库各跑各的,同一仓库去重(弹「查看进度 / 取消并重新开始」)
 * - 每个任务在侧栏展开为「阶段节点时间轴」:开始时刻/用时/门控命中/跳过,一目了然
 * - 运行中任务条目上内联 ✕ 取消(保留缓存),完成任务条目 ✕ 仅从列表移除;标题栏可全部取消
 * - 1s ticker 实时刷新用时显示,无任务时自动停
 * 0.3.0 既有保障:配置一次一解析、可取消管线、统一输出通道、运行锁、Webview nonce CSP。
 * 0.5.2 输出分离(用户要求:前一次与后一次不堆在一起):
 * - 每次生成自动开启一个新输出通道「代码转面试 · 仓库名 · 启动时刻」并自动弹出;
 *   主通道保留全部运行的完整历史,任务 🗑 移除时连同其专属通道一起清掉
 * - 默认每次生成落入独立产物目录 runs/run-NNNN(增量缓存/断点自动接续,产物互不覆盖)
 */

const LAST_OUTDIR_KEY = 'codeInterviewPrep.lastOutDir';
const LAST_RUN_KEY = 'codeInterviewPrep.lastRunAt';

/** 与 runner StageEvent.id 对应的时间轴节点顺序(扩展侧渲染 pending 用) */
const STAGE_ORDER: Array<{ id: StageEvent['id']; label: string }> = [
  { id: 'profile', label: '仓库画像' },
  { id: 'read', label: '模块精读' },
  { id: 'questions', label: '出题(含修复环)' },
  { id: 'verify', label: '对抗校验' },
  { id: 'rewrite', label: '标红题重写' },
  { id: 'jd', label: 'JD 加权' },
  { id: 'assemble', label: '总装输出' },
  { id: 'done', label: '完成' },
];

type NodeStatus = 'pending' | 'start' | 'done' | 'cached' | 'skip' | 'error' | 'cancelled';
interface StageNode {
  id: string;
  label: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  elapsedMs?: number;
  note?: string;
}
interface LiveTask {
  key: string; // 输出根(同仓库去重键):显式目录或默认 <仓库>/interview-output
  repoName: string;
  repoPath: string;
  hasJd: boolean;
  jdPath?: string;
  model: string;
  mode: RunMode;
  maxFiles: number;
  outRoot: string; // 去重/锁定用的输出根
  explicitOutDir?: string; // 用户指定的固定目录(fixed/custom);自动独立目录模式为 undefined
  outDir: string; // 本次实际产物目录;自动模式在管线启动时分配,完成后回填
  channel: vscode.LogOutputChannel; // 本次运行专属输出通道(前一次/后一次不堆在一起)
  startedAt: number;
  abort: AbortController;
  stages: Map<string, StageNode>;
  currentLabel: string;
  lastMsg: string;
  usage: { totalCalls: number; promptTokens: number; completionTokens: number; retries: number; truncations: number };
  finishedAt?: number;
  needsReview?: boolean;
  error?: string;
  cancelled?: boolean;
  promise: Promise<void>;
  settle: () => void;
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
const STATUS_ICON: Record<NodeStatus, string> = {
  pending: '$(dot)',
  start: '$(sync~spin)',
  done: '$(check)',
  cached: '$(database)',
  skip: '$(circle-slash)',
  error: '$(error)',
  cancelled: '$(debug-stop)',
};

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('代码转面试', { log: true });
  context.subscriptions.push(channel);
  setLogger(
    (line) => channel.appendLine(line),
    (line) => channel.appendLine(/^\s*\[警告\]/.test(line) ? line : `[警告] ${line}`)
  );

  const treeChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(treeChanged);
  /** 当前/最近任务,key = 输出目录。完成的任务保留在列表里供回看,✕ 可移除 */
  const tasks = new Map<string, LiveTask>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastFire = 0;

  const runningCount = () => [...tasks.values()].filter((t) => !t.finishedAt).length;
  const fire = () => {
    lastFire = Date.now();
    treeChanged.fire();
    vscode.commands.executeCommand('setContext', 'codeInterviewPrep.hasRunning', runningCount() > 0);
  };
  /** 事件高频路径上的节流刷新(ticker 兜底 1s) */
  const fireSoon = () => {
    if (Date.now() - lastFire >= 500) fire();
  };
  const ensureTicker = () => {
    if (runningCount() > 0 && !ticker) {
      ticker = setInterval(fire, 1000);
    } else if (runningCount() === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
      fire();
    }
  };
  context.subscriptions.push({ dispose: () => ticker && clearInterval(ticker) });

  const lastOutDir = (): string | undefined => context.globalState.get<string>(LAST_OUTDIR_KEY);

  const resolveConfig = (repoFsPath: string): AppConfig => {
    const modelSetting = vscode.workspace.getConfiguration('codeInterviewPrep').get<string>('model');
    return loadConfig({
      trustedDirs: [
        ...(vscode.workspace.workspaceFolders ?? []).map((w) => w.uri.fsPath),
        context.globalStorageUri.fsPath,
      ],
      repoDir: repoFsPath,
      overrides: { model: modelSetting?.trim() || undefined },
    });
  };

  /** 把 runner 的结构化阶段事件折算进任务时间轴 */
  const applyStage = (task: LiveTask, e: StageEvent): void => {
    let n = task.stages.get(e.id);
    if (!n) {
      n = { id: e.id, label: e.label, status: 'pending', startedAt: Date.now() };
      task.stages.set(e.id, n);
    }
    n.label = e.label;
    if (e.status === 'start') {
      n.status = 'start';
      n.startedAt = Date.now();
      task.currentLabel = e.label;
    } else {
      n.status = e.status;
      n.endedAt = Date.now();
      n.elapsedMs = e.elapsedMs ?? (n.endedAt - n.startedAt);
      if (e.note) n.note = e.note;
    }
    fireSoon();
  };

  const spawnTask = (repoPath: string, jdPath: string | undefined, config: AppConfig, mode: RunMode, maxFiles: number, explicitOutDir?: string): LiveTask => {
    const outRoot = path.resolve(explicitOutDir ?? path.join(repoPath, 'interview-output'));
    const key = outRoot;
    // 每次生成一个独立输出通道(0.5.2,用户要求:前一次与后一次的输出不堆在同一个控制台)。
    // 通道名 = 代码转面试 · 仓库名 · 启动时刻;开始时自动弹出该通道;主通道保留完整历史。
    const taskChannel = vscode.window.createOutputChannel(`代码转面试 · ${path.basename(repoPath)} · ${new Date().toLocaleTimeString()}`, { log: true });
    context.subscriptions.push(taskChannel);
    const abort = new AbortController();
    let settle!: () => void;
    const promise = new Promise<void>((r) => (settle = r));
    const task: LiveTask = {
      key,
      repoName: path.basename(repoPath),
      repoPath,
      hasJd: Boolean(jdPath),
      jdPath,
      model: config.model,
      mode,
      maxFiles,
      outRoot,
      explicitOutDir,
      outDir: outRoot, // 自动独立目录模式:管线启动时分配 runs/run-NNNN,完成后回填
      channel: taskChannel,
      startedAt: Date.now(),
      abort,
      stages: new Map(),
      currentLabel: '准备中',
      lastMsg: '',
      usage: { totalCalls: 0, promptTokens: 0, completionTokens: 0, retries: 0, truncations: 0 },
      promise,
      settle,
    };
    tasks.set(key, task);
    ensureTicker();
    fire();

    const banner = (l: string): void => {
      channel.appendLine(l); // 主通道:保留全部运行的完整历史
      taskChannel.appendLine(l); // 本次运行专属通道
    };
    banner(`\n===== 开始生成:${repoPath}(${new Date(task.startedAt).toLocaleString()}) =====`);
    taskChannel.show(true); // 自动开启新的输出端口:输出面板直接切到本次专属通道

    (async () => {
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `代码转面试 · ${task.repoName}`,
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              banner('[取消] 收到取消请求,正在立即中止当前请求;已完成阶段缓存保留。');
              abort.abort();
            });
            progress.report({ message: '正在生成(侧栏面板可见阶段时间轴,可随时取消)…' });
            return runPipeline({
              repoPath,
              jdPath,
              onProgress: (m) => {
                task.lastMsg = m;
                progress.report({ message: m.slice(0, 120) });
                fireSoon();
              },
              onUsage: (u) => {
                task.usage = u;
                task.lastMsg = `调用 ${u.totalCalls} 次 · 输入 ${u.promptTokens} · 输出 ${u.completionTokens} tok · 重试 ${u.retries}`;
                fireSoon();
              },
              onStage: (e) => applyStage(task, e),
              abort: abort.signal,
              host: 'vscode',
              config,
              mode: task.mode,
              maxFiles: task.maxFiles,
              outDir: task.explicitOutDir, // undefined = 自动独立目录(每次生成互不覆盖,增量接续)
              logSink: {
                // 本次运行的所有阶段日志 → 专属通道(与全局通道同时收到,互不影响)
                log: (l) => taskChannel.appendLine(l),
                warn: (l) => taskChannel.appendLine(/^\s*\[警告\]/.test(l) ? l : `[警告] ${l}`),
              },
            });
          }
        );
        task.outDir = result.outDir; // 自动模式下即本次专属 runs/run-NNNN
        task.finishedAt = Date.now();
        let qualityLabel = '已完成';
        try {
          const quality = JSON.parse(fs.readFileSync(path.join(task.outDir, 'quality-report.json'), 'utf8')) as { grade?: string; score?: number; aPlusEligible?: boolean };
          task.needsReview = !quality.aPlusEligible;
          qualityLabel = `${quality.grade ?? 'partial'} ${quality.score ?? 0}/100${quality.aPlusEligible ? ' · A+ 门禁通过' : ' · 需复核'}`;
        } catch { task.needsReview = true; qualityLabel = '部分完成 · 质量报告缺失'; }
        task.currentLabel = qualityLabel;
        context.globalState.update(LAST_OUTDIR_KEY, task.outDir);
        context.globalState.update(LAST_RUN_KEY, new Date().toISOString());
        const pick = await vscode.window.showInformationMessage(
          `${task.repoName}:${qualityLabel}(用时 ${fmtDur(task.finishedAt - task.startedAt)})`,
          '打开报告',
          '打开质量报告',
          '打开文件夹'
        );
        if (pick === '打开报告') openReportPanel(context, path.join(task.outDir, 'index.html'));
        else if (pick === '打开质量报告') openQualityReport(task.outDir);
        else if (pick === '打开文件夹') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(task.outDir));
      } catch (err) {
        task.finishedAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        if (/已取消/.test(msg)) {
          task.cancelled = true;
          task.currentLabel = '已取消';
          for (const n of task.stages.values()) if (n.status === 'start') n.status = 'cancelled';
          vscode.window.showInformationMessage(`${task.repoName}:已取消。已完成阶段保留缓存,重跑从断点继续。`);
        } else {
          task.error = msg;
          task.currentLabel = '失败';
          for (const n of task.stages.values()) if (n.status === 'start') n.status = 'error';
          const pick = await vscode.window.showErrorMessage(`生成失败(${task.repoName}):${msg}`, '查看日志');
          if (pick === '查看日志') taskChannel.show();
        }
      } finally {
        ensureTicker();
        fire();
        settle();
        banner(`===== ${task.repoName} 结束(用时 ${fmtDur(Date.now() - task.startedAt)}) =====\n`);
      }
    })();
    return task;
  };

  async function handleExistingTask(existing: LiveTask, repoPath: string): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `「${existing.repoName}」的生成任务正在运行(${fmtDur(Date.now() - existing.startedAt)},当前阶段:${existing.currentLabel})。再次点击不会产生第二个任务。`,
      '查看进度',
      '取消并重新开始'
    );
    if (pick === '查看进度') {
      await vscode.commands.executeCommand('codeInterviewPrep.panel.focus');
    } else if (pick === '取消并重新开始') {
      existing.abort.abort();
      await existing.promise; // 等它把取消收尾(请求级中止,秒级)
      tasks.delete(existing.key);
      try {
        const cfg = resolveConfig(repoPath);
        // 自动独立目录模式沿用(重新开始 = 再开一个新 run,已完成的增量照常接续)
        spawnTask(repoPath, existing.jdPath, cfg, existing.mode, existing.maxFiles, existing.explicitOutDir);
      } catch (err) {
        vscode.window.showErrorMessage(`代码转面试:${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** 生成命令主体。reuseJd = 取消并重新开始时代已选过 JD,直接沿用 */
  async function runGenerateCommand(item?: vscode.Uri, reuseJd?: { jdPath?: string; mode?: RunMode; maxFiles?: number; outDir?: string }): Promise<void> {
    let folder: vscode.Uri | undefined = item;
    if (!folder) {
      const wss = vscode.workspace.workspaceFolders;
      if (!wss || wss.length === 0) {
        vscode.window.showErrorMessage('请先打开一个包含代码的文件夹');
        return;
      }
      if (wss.length === 1) folder = wss[0].uri;
      else
        folder = (await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要分析的仓库' }))?.uri;
    }
    if (!folder) return;

    // 同仓库去重:误点 N 次也只有一条管线;提供「查看进度 / 取消并重新开始」
    const guessKey = path.join(folder.fsPath, 'interview-output');
    const existing = tasks.get(guessKey);
    if (existing && !existing.finishedAt) {
      await handleExistingTask(existing, folder.fsPath);
      return;
    }

    let mode: RunMode = 'balanced';
    let maxFiles = 40;
    let explicitOutDir: string | undefined;
    if (reuseJd?.mode) {
      mode = reuseJd.mode;
      maxFiles = reuseJd.maxFiles ?? maxFiles;
      explicitOutDir = reuseJd.outDir;
    } else {
      const modePick = await vscode.window.showQuickPick(
        [
          { label: '平衡模式(推荐)', description: '100 题 + 证据校验', value: 'balanced' as RunMode },
          { label: '经济模式(预览)', description: '约 40 题 + 轻量校验,不代表完整题库', value: 'economy' as RunMode },
          { label: '深度模式', description: '100 题 + 全量对抗校验 + 严格门禁', value: 'deep' as RunMode },
        ],
        { placeHolder: '选择生成模式 · 预计调用和成本会随模式变化' }
      );
      if (!modePick) return;
      mode = modePick.value;
      const estimate = estimatedCalls(mode);
      const maxFilesText = await vscode.window.showInputBox({
        prompt: `最大精读文件数 · ${modeLabel(mode)}模式预计 ${estimate.min}~${estimate.max} 次调用`,
        value: String(maxFiles),
        validateInput: (v) => /^\d+$/.test(v.trim()) && Number(v) > 0 && Number(v) <= 500 ? undefined : '请输入 1~500 的整数',
      });
      if (maxFilesText === undefined) return;
      maxFiles = Number(maxFilesText);
      // 输出方式(0.5.2):默认每次生成自动新建独立目录,前后两次产物互不覆盖
      const outPick = await vscode.window.showQuickPick(
        [
          { label: '自动独立目录(推荐)', description: '每次生成新建 runs/run-000N,前后两次互不覆盖;增量缓存自动接续', value: 'auto' },
          { label: '固定 interview-output', description: '旧模式:所有生成写同一目录,后一次覆盖前一次', value: 'fixed' },
          { label: '自定义目录…', description: '输入相对仓库的目录名(同样每次固定写该目录)', value: 'custom' },
        ],
        { placeHolder: '输出方式 · 前一次与后一次的产物分开存放,还是共用固定目录?' }
      );
      if (!outPick) return;
      if (outPick.value === 'fixed') {
        explicitOutDir = path.join(folder.fsPath, 'interview-output');
      } else if (outPick.value === 'custom') {
        const outText = await vscode.window.showInputBox({
          prompt: '输出目录(相对于仓库)',
          value: 'interview-output',
          validateInput: (v) => v.trim() && path.basename(path.resolve(folder!.fsPath, v.trim())) !== '.cache' ? undefined : '请输入有效目录名',
        });
        if (outText === undefined) return;
        explicitOutDir = path.resolve(folder.fsPath, outText.trim() || 'interview-output');
      } // auto → undefined,由管线分配 runs/run-NNNN
      vscode.window.showInformationMessage(`${modeLabel(mode)}模式: ${estimate.note} · 最大精读 ${maxFiles} 文件`, { modal: false });
    }

    const taskKey = path.resolve(explicitOutDir ?? path.join(folder.fsPath, 'interview-output'));
    const selectedExisting = tasks.get(taskKey);
    if (selectedExisting && !selectedExisting.finishedAt) {
      await handleExistingTask(selectedExisting, folder.fsPath);
      return;
    }

    let jdPath: string | undefined;
    if (reuseJd) {
      jdPath = reuseJd.jdPath;
    } else {
      const useJd = await vscode.window.showQuickPick(
        [{ label: '不使用 JD', value: false }, { label: '选择 JD 文件(岗位定制)', value: true }],
        { placeHolder: '是否按岗位描述加权?(Esc 取消本次生成)' }
      );
      if (!useJd) return;
      if (useJd.value) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { '文本文件': ['txt', 'md'] },
          title: '选择岗位描述(JD)文件',
        });
        if (!picked) return;
        jdPath = picked[0].fsPath;
      }
    }

    let config: AppConfig;
    try {
      config = resolveConfig(folder.fsPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const pick = await vscode.window.showErrorMessage(`代码转面试:${msg}`, '打开设置说明');
      if (pick) vscode.commands.executeCommand('codeInterviewPrep.openSettings');
      return;
    }
    spawnTask(folder.fsPath, jdPath, config, mode, maxFiles, explicitOutDir);
  }

  const resolveTask = (arg: unknown): LiveTask | undefined => {
    if (arg && typeof (arg as TaskTreeItem).task === 'object') return (arg as TaskTreeItem).task;
    if (typeof arg === 'string') return tasks.get(arg);
    return undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeInterviewPrep.generate', (item?: vscode.Uri) => runGenerateCommand(item)),

    vscode.commands.registerCommand('codeInterviewPrep.diagnose', async () => {
      const wss = vscode.workspace.workspaceFolders;
      if (!wss?.length) {
        vscode.window.showErrorMessage('请先打开一个工作区，以确定 DeepSeek 配置来源。');
        return;
      }
      const folder = wss.length === 1 ? wss[0].uri : (await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要测试配置的工作区' }))?.uri;
      if (!folder) return;
      let cfg: AppConfig;
      try { cfg = resolveConfig(folder.fsPath); }
      catch (err) { vscode.window.showErrorMessage(`DeepSeek 配置无效:${err instanceof Error ? err.message : String(err)}`); return; }
      const diagnosticChannel = vscode.window.createOutputChannel(`代码转面试诊断 · ${path.basename(folder.fsPath)} · ${new Date().toLocaleTimeString()}`, { log: true });
      context.subscriptions.push(diagnosticChannel);
      diagnosticChannel.show(true);
      diagnosticChannel.appendLine('开始 DeepSeek 最小连接诊断：不读取或发送仓库源码。');
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '代码转面试：测试 DeepSeek 连接' }, () => diagnoseDeepSeek(cfg));
      diagnosticChannel.appendLine(JSON.stringify(result, null, 2));
      const detail = result.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.id} (${s.elapsedMs}ms)：${s.detail}`).join('\n');
      if (result.ok) vscode.window.showInformationMessage(`DeepSeek 连接成功。${detail}`);
      else vscode.window.showErrorMessage(`DeepSeek 连接失败。请查看“${diagnosticChannel.name}”输出。`);
    }),

    // 内联 ✕:取消运行中任务(缓存保留)/ 中止后条目转为「已取消」可回看
    vscode.commands.registerCommand('codeInterviewPrep.cancelTask', async (arg: unknown) => {
      const t = resolveTask(arg);
      if (!t) return;
      if (t.finishedAt) {
        vscode.window.showInformationMessage('该任务已结束,无需取消(点垃圾桶图标可从列表移除)。');
        return;
      }
      t.abort.abort();
      vscode.window.showInformationMessage(`${t.repoName}:已请求取消,当前模型请求将立即中止;已完成阶段缓存保留,重跑自动续。`);
    }),

    // 内联 🗑:从列表移除已完成任务
    vscode.commands.registerCommand('codeInterviewPrep.dismissTask', (arg: unknown) => {
      const t = resolveTask(arg);
      if (!t) return;
      if (!t.finishedAt) {
        vscode.window.showWarningMessage('任务还在运行,请先用 ✕ 取消再移除。');
        return;
      }
      tasks.delete(t.key);
      t.channel.dispose(); // 连同本次运行专属的输出通道一起清掉
      fire();
    }),

    // 标题栏:全部取消(误点后想一键清场)
    vscode.commands.registerCommand('codeInterviewPrep.cancelAll', () => {
      const running = [...tasks.values()].filter((t) => !t.finishedAt);
      if (!running.length) {
        vscode.window.showInformationMessage('没有进行中的生成任务。');
        return;
      }
      running.forEach((t) => t.abort.abort());
      vscode.window.showInformationMessage(`已对 ${running.length} 个任务发出取消:当前请求将立即中止,缓存保留。`);
    }),

    vscode.commands.registerCommand('codeInterviewPrep.openReport', async () => {
      // 定位顺序:上次生成的目录 → 工作区最近一次完成的 run(runs/run-NNNN)→ 旧布局根目录
      const wss = vscode.workspace.workspaceFolders ?? [];
      const wsRoot = wss.length ? path.join(wss[0].uri.fsPath, 'interview-output') : undefined;
      const candidates = [lastOutDir(), wsRoot && latestRunDir(wsRoot), wsRoot];
      for (const dir of candidates) {
        if (!dir) continue;
        const html = path.join(dir, 'index.html');
        if (fs.existsSync(html)) {
          openReportPanel(context, html);
          return;
        }
      }
      vscode.window.showErrorMessage('未找到面试报告 index.html,请先生成(命令面板 →「代码转面试:生成面试材料」)');
    }),

    vscode.commands.registerCommand('codeInterviewPrep.openOutput', async () => {
      const wss = vscode.workspace.workspaceFolders ?? [];
      const wsRoot = wss.length ? path.join(wss[0].uri.fsPath, 'interview-output') : undefined;
      const candidates = [lastOutDir(), wsRoot && latestRunDir(wsRoot), wsRoot];
      for (const dir of candidates) {
        if (!dir) continue;
        if (fs.existsSync(dir)) {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
          return;
        }
      }
      vscode.window.showErrorMessage('未找到 interview-output 产物文件夹,请先生成');
    }),

    vscode.commands.registerCommand('codeInterviewPrep.openQuality', async () => {
      const wss = vscode.workspace.workspaceFolders ?? [];
      const wsRoot = wss.length ? path.join(wss[0].uri.fsPath, 'interview-output') : undefined;
      const dir = lastOutDir() ?? (wsRoot && latestRunDir(wsRoot)) ?? wsRoot;
      if (dir) await openQualityReport(dir);
      else vscode.window.showErrorMessage('未找到质量报告,请先生成');
    }),

    vscode.commands.registerCommand('codeInterviewPrep.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    })
  );

  class TaskTreeItem extends vscode.TreeItem {
    constructor(public readonly task: LiveTask) {
      super('', vscode.TreeItemCollapsibleState.Expanded);
    }
  }
  class StageTreeItem extends vscode.TreeItem {
    constructor(public readonly task: LiveTask, public readonly node: StageNode, index: number) {
      super(`${index + 1}. ${node.label}`, vscode.TreeItemCollapsibleState.None);
    }
  }

  const taskItem = (t: LiveTask): TaskTreeItem => {
    const it = new TaskTreeItem(t);
    const total = fmtDur((t.finishedAt ?? Date.now()) - t.startedAt);
    const doneN = [...t.stages.values()].filter((n) => ['done', 'cached', 'skip'].includes(n.status)).length;
    if (!t.finishedAt) {
      it.label = `$(sync~spin) ${t.repoName}`;
      it.description = `${total} · 阶段:${t.currentLabel} · 节点 ${doneN}/${STAGE_ORDER.length}`;
      it.iconPath = new vscode.ThemeIcon('sync~spin');
      it.contextValue = 'cip-task-running';
      it.command = { command: 'codeInterviewPrep.panel.focus', title: '查看进度' };
    } else if (t.cancelled) {
      it.label = `$(debug-stop) ${t.repoName}(已取消)`;
      it.description = `${total} · 缓存保留,重跑续接`;
      it.contextValue = 'cip-task-finished';
      it.command = { command: 'codeInterviewPrep.generate', title: '重新生成', arguments: [vscode.Uri.file(t.repoPath)] };
    } else if (t.error) {
      it.label = `$(error) ${t.repoName}(失败)`;
      it.description = t.error.slice(0, 80);
      it.contextValue = 'cip-task-finished';
      it.command = { command: 'codeInterviewPrep.generate', title: '重试', arguments: [vscode.Uri.file(t.repoPath)] };
    } else if (t.needsReview) {
      it.label = `$(warning) ${t.repoName}(需复核)`;
      it.description = `部分完成 · ${total} · 打开质量报告查看门禁原因`;
      it.contextValue = 'cip-task-finished';
      it.command = { command: 'codeInterviewPrep.openQuality', title: '打开质量报告' };
    } else {
      it.label = `$(check) ${t.repoName}`;
      it.description = `完成 · ${total} · ${path.basename(t.outDir)} · 点开展开看各节点用时`;
      it.contextValue = 'cip-task-finished';
      it.command = { command: 'codeInterviewPrep.openReport', title: '打开报告' };
    }
    const lines = [
      `**${t.repoName}** — ${modeLabel(t.mode)}模式 · 模型 ${t.model}${t.hasJd ? ' · 带 JD' : ''}`,
      `调用 ${t.usage.totalCalls} 次 · 输入 ${t.usage.promptTokens} tok · 输出 ${t.usage.completionTokens} tok · 重试 ${t.usage.retries} · 截断 ${t.usage.truncations}`,
      `仓库:${t.repoPath}`,
      `产物:${t.outDir}`,
      `日志通道:${t.channel.name}`,
      `开始:${new Date(t.startedAt).toLocaleString()}`,
      '',
      ...STAGE_ORDER.map((s) => {
        const n = t.stages.get(s.id);
        if (!n) return `- ${s.label}:未执行`;
        const dur = n.elapsedMs !== undefined ? ` ${fmtDur(n.elapsedMs)}` : n.status === 'start' ? ` ${fmtDur(Date.now() - n.startedAt)}…` : '';
        return `- ${n.status} ${s.label}${dur}${n.note ? `(${n.note})` : ''}`;
      }),
      '',
      '✕ = 取消(已完成阶段缓存保留);🗑 = 从列表移除',
    ];
    const md = new vscode.MarkdownString(lines.join('\n'));
    md.supportThemeIcons = true; // tooltip 里如带 $(icon) 文本可正常渲染
    (md as { supportNewline?: boolean }).supportNewline = true; // 逐行显示(较新 API,老宿主自动忽略)
    it.tooltip = md;
    return it;
  };

  const stageItems = (t: LiveTask): StageTreeItem[] =>
    STAGE_ORDER.map((s, i) => {
      const node: StageNode = t.stages.get(s.id) ?? {
        id: s.id,
        label: s.label,
        status: t.finishedAt ? 'skip' : 'pending',
        startedAt: 0,
      };
      if (t.finishedAt && !t.stages.has(s.id)) node.note = '未执行到';
      const it = new StageTreeItem(t, node, i);
      it.iconPath = new vscode.ThemeIcon(
        node.status === 'start' ? 'sync~spin'
          : node.status === 'done' ? 'check'
          : node.status === 'cached' ? 'database'
          : node.status === 'skip' ? 'circle-slash'
          : node.status === 'error' ? 'error'
          : node.status === 'cancelled' ? 'debug-stop'
          : 'circle-large-outline'
      );
      if (node.status === 'start' && node.startedAt) it.description = `进行中 ${fmtDur(Date.now() - node.startedAt)}`;
      else if (node.elapsedMs !== undefined) it.description = `${node.status === 'cached' ? '缓存复用' : node.status === 'skip' ? '跳过' : '用时'} ${fmtDur(node.elapsedMs)}`;
      else it.description = node.status === 'pending' ? '等待中' : '';
      if (node.note) it.description = it.description ? `${it.description} · ${node.note}` : node.note;
      it.contextValue = 'cip-stage';
      it.command = undefined;
      return it;
    });

  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem: (it) => it,
    getChildren: (element?) => {
      if (element instanceof TaskTreeItem) return Promise.resolve(stageItems(element.task));
      if (element) return Promise.resolve([]);
      const roots: vscode.TreeItem[] = [...tasks.values()].map(taskItem);
      const anyRunning = runningCount() > 0;
      const mk = (label: string, cmd: string, icon: string, tooltip: string, description?: string): vscode.TreeItem => {
        const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        it.command = { command: cmd, title: label };
        it.iconPath = new vscode.ThemeIcon(icon);
        it.tooltip = tooltip;
        it.description = description;
        return it;
      };
      roots.push(
        mk(
          anyRunning ? '再加一个仓库的生成…' : '生成面试材料…',
          'codeInterviewPrep.generate',
          'play',
          anyRunning ? '不同仓库可并行,各自独立取消;同仓库误点不会产生第二个任务' : '对当前工作区仓库运行完整管线(画像→精读→出题→校验→总装)'
        ),
        mk('打开面试报告', 'codeInterviewPrep.openReport', 'book', '在编辑器内打开可搜索的自测报告 index.html'),
        mk('查看质量门禁', 'codeInterviewPrep.openQuality', 'verified', '打开确定性 quality-report.json 与质量门禁报告.md'),
        mk('打开产物文件夹', 'codeInterviewPrep.openOutput', 'folder-opened', '打开最近一次生成的产物目录(自动独立目录模式下为 runs/run-000N;每次生成互不覆盖)'),
        mk('配置模型 / 密钥说明', 'codeInterviewPrep.openSettings', 'gear', '扩展设置与 .env 配置说明')
      );
      if (!anyRunning && tasks.size) {
        roots.unshift(mk('清空已结束的任务记录', 'codeInterviewPrep.dismissAll', 'trash', '从侧栏移除所有已完成/已取消的条目'));
      }
      return Promise.resolve(roots);
    },
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('codeInterviewPrep.dismissAll', () => {
      for (const [k, t] of [...tasks]) {
        if (!t.finishedAt) continue;
        tasks.delete(k);
        t.channel.dispose();
      }
      fire();
    }),
    vscode.window.createTreeView('codeInterviewPrep.panel', { treeDataProvider: provider, showCollapseAll: true })
  );
}

async function openQualityReport(outDir: string): Promise<void> {
  const markdown = path.join(outDir, '质量门禁报告.md');
  const json = path.join(outDir, 'quality-report.json');
  const target = fs.existsSync(markdown) ? markdown : json;
  if (!fs.existsSync(target)) {
    vscode.window.showErrorMessage('未找到质量门禁报告,请先生成');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
}

/**
 * 用 Webview 打开单文件报告。nonce CSP 注入(模板无内联事件,授权可生效);
 * 结构异常时回退系统浏览器,不给未知脚本授权。
 */
function openReportPanel(context: vscode.ExtensionContext, htmlPath: string): void {
  let html = fs.readFileSync(htmlPath, 'utf-8');
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  const headMatch = html.match(/<head[^>]*>/i);
  if (scriptTags.length !== 1 || !headMatch) {
    vscode.window
      .showWarningMessage('报告结构非标准(可能被修改过),为保护工作区已改用系统浏览器打开。')
      .then(() => vscode.env.openExternal(vscode.Uri.file(htmlPath)));
    return;
  }
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
  html = html.replace(headMatch[0], `${headMatch[0]}${csp}`);
  html = html.replace(scriptTags[0], `<script nonce="${nonce}">`);
  const panel = vscode.window.createWebviewPanel(
    'codeInterviewReport',
    '面试材料报告',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] }
  );
  panel.webview.html = html;
}

export function deactivate(): void {
  /* subscriptions 已接管 */
}
