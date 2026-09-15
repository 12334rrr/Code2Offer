import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runPipeline } from '../../src/core/runner';
import { loadConfig } from '../../src/core/config';
import { setLogger } from '../../src/core/logger';

/**
 * 「代码转面试」VSCode 扩展薄壳:
 * - 资源管理器右键文件夹 / 命令面板 → 生成面试材料(复用纯 TS 核心库)
 * - 完成后用 Webview 打开单文件 index.html 报告
 *
 * 审计修复要点:
 * - 配置一次一解析,显式传参给管线,绝不写 process.env(跨仓库凭据污染 E-01/S-3)
 * - 进度可取消(CancellationToken → AbortSignal 贯穿全管线),取消即停止计费(E-02/R-7)
 * - 所有阶段日志进专属输出通道,用户看得见"跑到哪一步、花了多久"(E-06)
 * - 树视图实时刷新;openReport/openOutput 记住本次生成的目标目录(E-04)
 * - 设置里的模型名真实生效;openSettings 用正确扩展 ID(E-05/M4)
 * - Webview CSP 注入容错:模板结构异常时回退系统浏览器,不给未知脚本授权(E-07)
 */

const LAST_OUTDIR_KEY = 'codeInterviewPrep.lastOutDir';
const LAST_RUN_KEY = 'codeInterviewPrep.lastRunAt';

export function activate(context: vscode.ExtensionContext): void {
  // 专属输出通道:核心库的 log/warn 全部路由到这里(扩展宿主的 console 用户看不见)
  const channel = vscode.window.createOutputChannel('代码转面试', { log: true });
  context.subscriptions.push(channel);
  setLogger(
    (line) => channel.appendLine(line),
    (line) => channel.appendLine(`[警告] ${line}`)
  );

  const treeChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(treeChanged);
  let running = false;

  /** 记录/读取最近一次成功生成的产物目录 */
  const lastOutDir = (): string | undefined => context.globalState.get<string>(LAST_OUTDIR_KEY);

  const resolveConfig = (repoFsPath: string) => {
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeInterviewPrep.generate',
      async (item?: vscode.Uri) => {
        if (running) {
          vscode.window.showWarningMessage('代码转面试:已有生成任务进行中,请等它完成(或点通知栏的取消)。');
          return;
        }
        // 右键传入文件夹 Uri;命令面板则选工作区
        let folder: vscode.Uri | undefined = item;
        if (!folder) {
          const wss = vscode.workspace.workspaceFolders;
          if (!wss || wss.length === 0) {
            vscode.window.showErrorMessage('请先打开一个包含代码的文件夹');
            return;
          }
          if (wss.length === 1) folder = wss[0].uri;
          else
            folder = (
              await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要分析的仓库' })
            )?.uri;
        }
        if (!folder) return; // 用户取消选择

        // 可选:岗位描述文件(JD 加权)。选择器被取消 = 整个命令终止,不再"静默变成不用 JD"
        const useJd = await vscode.window.showQuickPick(
          [{ label: '不使用 JD', value: false }, { label: '选择 JD 文件(岗位定制)', value: true }],
          { placeHolder: '是否按岗位描述加权?(Esc 取消本次生成)' }
        );
        if (!useJd) return;
        let jdPath: string | undefined;
        if (useJd.value) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { '文本文件': ['txt', 'md'] },
            title: '选择岗位描述(JD)文件',
          });
          if (!picked) return; // 取消选择 JD = 取消生成
          jdPath = picked[0].fsPath;
        }

        // 配置:一次一解析(不污染全局 env);密钥缺失/端点非法在这里就报清楚
        let config;
        try {
          config = resolveConfig(folder.fsPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const pick = await vscode.window.showErrorMessage(`代码转面试:${msg}`, '打开设置说明');
          if (pick) vscode.commands.executeCommand('codeInterviewPrep.openSettings');
          return;
        }

        // 取消通道:VSCode 通知栏取消按钮 → AbortSignal → 贯穿每个模型请求
        const abortCtrl = new AbortController();
        running = true;
        treeChanged.fire();
        const startedAt = Date.now();
        channel.appendLine(`\n===== 开始生成:${folder.fsPath}(${new Date().toLocaleString()}) =====`);
        channel.show(true);

        try {
          const { outDir } = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: '代码转面试',
              cancellable: true,
            },
            async (progress, token) => {
              token.onCancellationRequested(() => {
                channel.appendLine('[取消] 收到取消请求,正在中止(当前请求完成后停止)…');
                abortCtrl.abort();
              });
              progress.report({ message: '正在生成(详细日志见「代码转面试」输出通道,可随时取消)…' });
              return runPipeline({
                repoPath: folder!.fsPath,
                jdPath,
                onProgress: (m) => progress.report({ message: m.slice(0, 120) }),
                abort: abortCtrl.signal,
                host: 'vscode',
                config,
              });
            }
          );
          context.globalState.update(LAST_OUTDIR_KEY, outDir);
          context.globalState.update(LAST_RUN_KEY, new Date().toISOString());
          const pick = await vscode.window.showInformationMessage(
            `面试材料生成完成(用时 ${Math.round((Date.now() - startedAt) / 1000)}s)!`,
            '打开报告',
            '打开文件夹'
          );
          if (pick === '打开报告') openReportPanel(context, path.join(outDir, 'index.html'));
          else if (pick === '打开文件夹') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/已取消/.test(msg)) {
            vscode.window.showInformationMessage('代码转面试:已取消。已完成的阶段已缓存,下次运行从断点继续。');
          } else {
            const pick = await vscode.window.showErrorMessage(`生成失败:${msg}`, '查看日志');
            if (pick === '查看日志') channel.show();
          }
        } finally {
          running = false;
          treeChanged.fire();
          channel.appendLine(`===== 结束(总用时 ${Math.round((Date.now() - startedAt) / 1000)}s) =====\n`);
        }
      }
    ),

    vscode.commands.registerCommand('codeInterviewPrep.openReport', async () => {
      // 优先用本次会话/上次成功生成的目录(多根工作区与右键子目录场景不再找错地方)
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
      // 用真实扩展 ID(上架后是 <publisher>.<name>),不再写死 local.*
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
    })
  );

  // 左侧活动栏面板:单击图标后的树视图,条目即入口;状态随生成/完成实时刷新
  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem: (it) => it,
    getChildren: () => {
      const mk = (label: string, cmd: string, icon: string, tooltip: string, description?: string): vscode.TreeItem => {
        const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        it.command = { command: cmd, title: label };
        it.iconPath = new vscode.ThemeIcon(icon);
        it.tooltip = tooltip;
        it.description = description;
        return it;
      };
      const lastAt = context.globalState.get<string>(LAST_RUN_KEY);
      const lastAtText = lastAt ? `上次生成:${new Date(lastAt).toLocaleString()}` : undefined;
      return [
        mk(
          running ? '生成中…(点击查看日志)' : '生成面试材料…',
          running ? 'codeInterviewPrep.openOutput' : 'codeInterviewPrep.generate',
          running ? 'sync~spin' : 'play',
          '对当前工作区仓库运行完整管线(画像→精读→出题→校验→总装)',
          running ? '进行中,可点通知栏取消' : lastAtText
        ),
        mk('打开面试报告', 'codeInterviewPrep.openReport', 'book', '在编辑器内打开可搜索的自测报告 index.html'),
        mk('打开产物文件夹', 'codeInterviewPrep.openOutput', 'folder-opened', '在系统文件管理器中打开 interview-output'),
        mk('配置模型 / 密钥说明', 'codeInterviewPrep.openSettings', 'gear', '扩展设置与 .env 配置说明'),
      ];
    },
  };
  context.subscriptions.push(
    vscode.window.createTreeView('codeInterviewPrep.panel', { treeDataProvider: provider, showCollapseAll: false })
  );
}

/**
 * 用 Webview 打开单文件报告。
 * 报告模板已无内联事件处理器(全部事件委托),nonce CSP 可以真正生效;
 * CSP 注入对 <head> 大小写/属性容错,结构不符合预期时回退系统浏览器打开(不给未知脚本授权)。
 */
function openReportPanel(context: vscode.ExtensionContext, htmlPath: string): void {
  let html = fs.readFileSync(htmlPath, 'utf-8');
  const scriptCount = (html.match(/<script>/g) ?? []).length;
  const headMatch = html.match(/<head[^>]*>/i);
  if (scriptCount !== 1 || !headMatch) {
    // 模板结构异常(用户手改过/旧版本产物):不再盲目注入,回退浏览器打开
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
  /* 无需清理:subscriptions 已接管 */
}
