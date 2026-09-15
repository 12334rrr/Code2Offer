import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runPipeline, StageEvent } from '../../src/core/runner';
import { loadConfig, AppConfig } from '../../src/core/config';
import { setLogger } from '../../src/core/logger';

/**
 * 「Code2Offer(代码转面试)」VSCode 扩展薄壳。
 *
 * 0.4.0 面板升级(用户需求:误点多次可逐个叉掉 + 阶段时间轴):
 * - 多任务并发:不同仓库各跑各的,同一仓库去重(弹「查看进度 / 取消并重新开始」)
 * - 每个任务在侧栏展开为「阶段节点时间轴」:开始时刻/用时/门控命中/跳过,一目了然
 * - 运行中任务条目上内联 ✕ 取消(保留缓存),完成任务条目 ✕ 仅从列表移除;标题栏可全部取消
 * - 1s ticker 实时刷新用时显示,无任务时自动停
 * 0.3.0 既有保障:配置一次一解析、可取消管线、统一输出通道、运行锁、Webview nonce CSP。
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
  key: string; // outDir(同仓库去重键)
  repoName: string;
  repoPath: string;
  hasJd: boolean;
  jdPath?: string;
  model: string;
  startedAt: number;
  abort: AbortController;
  stages: Map<string, StageNode>;
  currentLabel: string;
  lastMsg: string;
  finishedAt?: number;
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
    (line) => channel.appendLine(`[警告] ${line}`)
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

  const spawnTask = (repoPath: string, jdPath: string | undefined, config: AppConfig): LiveTask => {
    const key = path.join(repoPath, 'interview-output');
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
      startedAt: Date.now(),
      abort,
      stages: new Map(),
      currentLabel: '准备中',
      lastMsg: '',
      promise,
      settle,
    };
    tasks.set(key, task);
    ensureTicker();
    fire();

    channel.appendLine(`\n===== 开始生成:${repoPath}(${new Date(task.startedAt).toLocaleString()}) =====`);
    channel.show(true);

    (async () => {
      try {
        const { outDir } = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `代码转面试 · ${task.repoName}`,
            cancellable: true,
          },
          async (progress, token) => {
            token.onCancellationRequested(() => {
              channel.appendLine('[取消] 收到取消请求,正在中止(当前请求完成后停止)…');
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
              onStage: (e) => applyStage(task, e),
              abort: abort.signal,
              host: 'vscode',
              config,
            });
          }
        );
        task.finishedAt = Date.now();
        task.currentLabel = '完成';
        context.globalState.update(LAST_OUTDIR_KEY, outDir);
        context.globalState.update(LAST_RUN_KEY, new Date().toISOString());
        const pick = await vscode.window.showInformationMessage(
          `${task.repoName}:面试材料生成完成(用时 ${fmtDur(task.finishedAt - task.startedAt)})!`,
          '打开报告',
          '打开文件夹'
        );
        if (pick === '打开报告') openReportPanel(context, path.join(outDir, 'index.html'));
        else if (pick === '打开文件夹') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
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
          if (pick === '查看日志') channel.show();
        }
      } finally {
        ensureTicker();
        fire();
        settle();
        channel.appendLine(`===== ${task.repoName} 结束(用时 ${fmtDur(Date.now() - task.startedAt)}) =====\n`);
      }
    })();
    return task;
  };

  /** 生成命令主体。reuseJd = 取消并重新开始时代已选过 JD,直接沿用 */
  async function runGenerateCommand(item?: vscode.Uri, reuseJd?: { jdPath?: string }): Promise<void> {
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
          const cfg = resolveConfig(folder.fsPath);
          spawnTask(folder.fsPath, existing.jdPath, cfg);
        } catch (err) {
          vscode.window.showErrorMessage(`代码转面试:${err instanceof Error ? err.message : err}`);
        }
      }
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
    spawnTask(folder.fsPath, jdPath, config);
  }

  const resolveTask = (arg: unknown): LiveTask | undefined => {
    if (arg && typeof (arg as TaskTreeItem).task === 'object') return (arg as TaskTreeItem).task;
    if (typeof arg === 'string') return tasks.get(arg);
    return undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeInterviewPrep.generate', (item?: vscode.Uri) => runGenerateCommand(item)),

    // 内联 ✕:取消运行中任务(缓存保留)/ 中止后条目转为「已取消」可回看
    vscode.commands.registerCommand('codeInterviewPrep.cancelTask', async (arg: unknown) => {
      const t = resolveTask(arg);
      if (!t) return;
      if (t.finishedAt) {
        vscode.window.showInformationMessage('该任务已结束,无需取消(点垃圾桶图标可从列表移除)。');
        return;
      }
      t.abort.abort();
      vscode.window.showInformationMessage(`${t.repoName}:已请求取消,当前模型请求完成后停止;已完成阶段的缓存保留,重跑自动续。`);
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
      vscode.window.showInformationMessage(`已对 ${running.length} 个任务发出取消:当前请求完成后停止,缓存保留。`);
    }),

    vscode.commands.registerCommand('codeInterviewPrep.openReport', async () => {
      const candidates = [lastOutDir()];
      const wss = vscode.workspace.workspaceFolders ?? [];
      if (wss.length) candidates.push(path.join(wss[0].uri.fsPath, 'interview-output'));
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
      const candidates = [lastOutDir()];
      const wss = vscode.workspace.workspaceFolders ?? [];
      if (wss.length) candidates.push(path.join(wss[0].uri.fsPath, 'interview-output'));
      for (const dir of candidates) {
        if (!dir) continue;
        if (fs.existsSync(dir)) {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
          return;
        }
      }
      vscode.window.showErrorMessage('未找到 interview-output 产物文件夹,请先生成');
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
    } else {
      it.label = `$(check) ${t.repoName}`;
      it.description = `完成 · ${total} · 点开展开看各节点用时`;
      it.contextValue = 'cip-task-finished';
      it.command = { command: 'codeInterviewPrep.openReport', title: '打开报告' };
    }
    const lines = [
      `**${t.repoName}** — 模型 ${t.model}${t.hasJd ? ' · 带 JD' : ''}`,
      `仓库:${t.repoPath}`,
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
        mk('打开产物文件夹', 'codeInterviewPrep.openOutput', 'folder-opened', '在系统文件管理器中打开 interview-output'),
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
      for (const [k, t] of [...tasks]) if (t.finishedAt) tasks.delete(k);
      fire();
    }),
    vscode.window.createTreeView('codeInterviewPrep.panel', { treeDataProvider: provider, showCollapseAll: true })
  );
}

/**
 * 用 Webview 打开单文件报告。nonce CSP 注入(模板无内联事件,授权可生效);
 * 结构异常时回退系统浏览器,不给未知脚本授权。
 */
function openReportPanel(context: vscode.ExtensionContext, htmlPath: string): void {
  let html = fs.readFileSync(htmlPath, 'utf-8');
  const scriptCount = (html.match(/<script>/g) ?? []).length;
  const headMatch = html.match(/<head[^>]*>/i);
  if (scriptCount !== 1 || !headMatch) {
    vscode.window
      .showWarningMessage('报告结构非标准(可能被修改过),已改用系统浏览器打开。', '仍要在 VSCode 内打开')
      .then((pick) => {
        if (pick === '仍要在 VSCode 内打开') {
          const panel = vscode.window.createWebviewPanel(
            'codeInterviewReport',
            '面试材料报告',
            vscode.ViewColumn.One,
            { enableScripts: true }
          );
          panel.webview.html = html;
        } else {
          vscode.env.openExternal(vscode.Uri.file(htmlPath));
        }
      });
    return;
  }
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
  html = html.replace(headMatch[0], `${headMatch[0]}${csp}`);
  html = html.replace('<script>', `<script nonce="${nonce}">`);
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
