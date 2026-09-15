# VS Code 扩展层审计发现

审计日期：2026-09-15。对象：当前 `vscode/src/extension.ts`、manifest、构建脚本及本地 `vscode/code-interview-prep-0.2.3.vsix`。审计没有修改业务代码，没有调用付费模型，没有读取实际 `.env` 内容。

## 方法与边界

- 使用 `node audit/extension-regressions.cjs`，分别执行当前源码经 esbuild 转换后的模块、原始 VSIX 中的 bundle。对 `vscode`、文件系统、`process.env`、`runPipeline` 使用隔离 mock，全部密钥和域名为虚构值。脚本默认拒绝未预期的模块加载和子进程执行。
- 两个版本各执行 9 组行为场景：跨仓库配置、取消岗位选择、取消文件选择、同仓库并发、多根目录重开、子目录重开、设置行为、状态/日志能力、大小写不同的 HTML head。原始结果：`audit/extension-regressions.json`。
- `node node_modules/typescript/bin/tsc --noEmit -p vscode/tsconfig.json`：退出码 0。
- VSIX SHA-256：`67e59dcfee209eaf3f65b061f08b069daf4f7521157e994fbd7598c6209cfef0`。其 `extension/src/extension.ts` 与当前源码一致；其 bundle 与当前重新构建的 bundle 一致。因此以下行为不是仅存在于未发布源码中的推测。
- 尚未在真实 VS Code Extension Host 中安装和点击测试；mock 证明命令控制流和传参，不证明真实请求费用、文件损坏、Webview 网络外传或原生 UI 的实际表现。本地 VSIX 的版本与内容不能替代 Marketplace 在线版本核验。
- 脚本是审计复现工具，退出码 0 表示复现正常完成，不表示产品没有缺陷。

## E-01 / P1：第一份仓库配置污染之后的仓库

**位置**：`vscode/src/extension.ts:139`、`:140`、`:153`、`:156`；与 `src/core/config.ts:55`、`:57`、`:62` 的环境变量优先级共同生效。

**触发**：在同一 Extension Host 会话里先对 A 仓库生成，再对 B 仓库生成；各自 `.env` 配置不同 API key、模型及 API 服务地址。

**证据**：两个目标均复现：预期密钥顺序 `[audit-key-A, audit-key-B]`，实际为 `[audit-key-A, audit-key-A]`，模型与服务地址也均沿用 A。根因是首次生成将文件配置写入全局 `process.env`，以后遇到已经存在的 API key 就直接返回，核心层又将进程变量作为最高优先级。

**影响**：B 项目使用 A 的账号和模型，费用归属错误；若两个项目应使用不同供应商或专属网关，B 代码会被发送给 A 的服务地址。用户在 A 的 `.env` 中轮换 key 也无法在当前宿主会话中生效。这里确认的是路由与凭据选择错误；未实际对外发送内容。

**修改建议**：配置解析必须返回一次运行独立的不可变配置对象，经 `RunOptions` 显式传给核心，不修改全局环境。将用户主动设置的系统变量与从仓库读入的变量分开。API key、模型和服务地址作为同一个配置来源解析，按仓库 URI 做覆盖规则；交互录入密钥可使用 `ExtensionContext.secrets`。最低验收：A→B→A 的 key/模型/地址分别正确，旋转 key 无需重载 VS Code。

## E-02 / P1：用户取消输入后依然启动生成，且长任务无法取消

**位置**：`vscode/src/extension.ts:34`、`:38`、`:45`、`:50`、`:54`；`src/core/runner.ts:17`。

**触发与证据**：

1. `showQuickPick` 返回 `undefined`，表示用户退出选择；实际仍调用管线 1 次。
2. 已选择使用 JD，再在文件选择器里取消；实际仍调用管线 1 次，并且 `jdPath=null`，工作悄然变为不使用 JD。
3. 进度通知明确 `cancellable:false`；管线选项没有取消信号。

**影响**：用户以为自己已取消操作，插件仍可能扫描代码并发起模型请求，产生非预期费用。模型推理、重试和多阶段处理可能持续较久，用户无法从插件停止。

**修改建议**：显式区分“选择不使用 JD”和“取消”；任何选择器返回 `undefined` 时立即结束本次命令。开启进度取消并将 `CancellationToken` 转为贯穿管线的 `AbortSignal`；在扫描、重试等待、每个请求和阶段边界处理取消，取消后保存可恢复状态且不得显示成功。验收：上述两个取消场景请求次数为 0；执行中取消后无新的阶段请求。

## E-03 / P1：同一目标允许同时运行多条写入同一目录的管线

**位置**：`vscode/src/extension.ts:16`、`:49`、`:54`；`src/core/runner.ts:48`、`:63`、`:81`。

**证据**：同时调用两次同仓库 generate，mock 阻塞第一条管线后，第二条也进入运行；最大并发为 2。没有正在运行标志、目标目录锁、按钮禁用或“继续现有任务”逻辑。

**影响**：重复付费请求已具备必要控制流条件；两条管线读写相同 `interview-output/state.json`、题库和缓存，可能相互覆盖或在阶段读取时见到另一条管线的中间状态。没有声称已在真实 API 下复现文件损坏。

**修改建议**：在规范化后的目标目录上设置运行锁，并在 `finally` 中释放；同目录重复命令应聚焦已有任务或提示运行中。不同目录可以独立运行。若允许多窗口/CLI 操作同目录，核心层还需跨进程目录锁和临时文件写入后原子替换。验收：同目标最多一个 writer，异常/取消不留下永久锁。

## E-04 / P2：重开报告与产物目录忽略实际生成目标

**位置**：`vscode/src/extension.ts:76`、`:79`、`:89`、`:120`。

**证据**：多根目录 `[A,B]` 中生成时选择 B，随后 openReport 仍查找 `A/interview-output/index.html`；实际打开 panel 数为 0。右键 `A/nested-project` 生成后也只查 A 根。openOutput 和侧栏状态采用同一错误假设。

**影响**：按支持的入口完成生成后，菜单“随时重新打开上次产物”可能直接报错，或打开另一个仓库的旧报告。当前成功通知中的“打开报告”使用本次 `outDir`，所以该一次性按钮工作正常；缺陷发生于后续重开流程。

**修改建议**：按目标 URI 保存成功生成的 outDir 和时间，侧栏列出可用报告；多根目录使用与生成命令一致的目标选择，右键子目录报告也应被记录。处理 workspaceFolders 空数组并给出一致提示。验收覆盖工作区根、第二根、嵌套目录，以及多个已有报告。

## E-05 / P2：公开设置项没有效果，配置入口使用错误扩展 ID

**位置**：`vscode/package.json:6`、`:69`；`vscode/src/extension.ts:54`、`:98`、`:103`。

**证据**：manifest 注册 `codeInterviewPrep.model`，但扩展执行期间 `workspace.getConfiguration` 调用数为 0，核心层也没有获得该设置值。设置命令实际传入 `@ext:local.code-interview-prep`，发布 ID 是 `DawnofHope.code-interview-prep`。

**影响**：用户在设置 UI 修改模型没有实际效果；“配置模型”打开错误筛选结果，无法完成承诺的配置行为。

**修改建议**：用 `context.extension.id` 或正确 ID 打开设置。实现按 resource URI 读取模型配置，并在显式配置对象中传给核心；或者删除无效设置，提供一条真实可用的配置流程。向用户显示本次生效的模型和已脱敏服务地址。验收确认自定义模型传至 HTTP 请求体，而不只是出现于 UI。

## E-06 / P2：状态无法主动刷新，正式安装用户缺少可见诊断日志

**位置**：`vscode/src/extension.ts:52`、`:108`、`:118`、`:131`；`src/core/runner.ts:52`。

**证据**：TreeDataProvider 没有 `onDidChangeTreeData`，生成完成也不发刷新事件；工作区变更同样没有刷新订阅。完整激活及生成流程 `createOutputChannel` 调用数为 0；核心日志主要是 `console.log`，而 UI 提示却让用户看“输出/调试控制台”。

**影响**：侧栏可能一直显示“尚未生成”；普通安装场景没有该插件专属 Output 通道，难以看阶段详情、错误分类、耗时、调用和 token 使用汇总。错误统一附带“key 是否有效”，对文件权限、坏 JSON、网络错误的定位有误导。

**修改建议**：添加并释放 `EventEmitter`，在任务状态变化和工作区变化时更新树；创建 `LogOutputChannel`，通过统一 logger 承载脱敏日志与运行 ID。错误按配置、网络/限流、数据校验、文件系统分类，并提供“查看日志”。验收在生成前后、失败、取消、切换仓库时验证状态与日志一致。

## E-07 / P2：CSP 插入依赖 HTML 字面格式，读取可修改报告后未保证安全策略存在

**位置**：`vscode/src/extension.ts:166`、`:171`、`:176`、`:180`。

**证据**：将虚拟报告设为 `<html><HEAD></HEAD><body><script>globalThis.auditProof=true;</script></body></html>` 后，打开流程仍启用脚本并为第一段 script 加 nonce，但最终 HTML 中没有 CSP。实现仅替换小写精确 `<head>`；`<HEAD>`、`<head lang="zh">` 都不匹配。它还会直接为从工作区文件读出的第一段 script 授权，而非只信任插件控制的代码。

**影响及边界**：正常生成模板使用 `<head>`，通常能插入策略；但修改过的或仓库自带的 `interview-output/index.html` 会绕过插件原本计划的策略。这是可证实的策略缺失，不应写成已实现任意本机文件读取或宿主 RCE。真正的 Webview 仍有隔离；本次没有测试网络外传。正常模板中 nonce CSP 与 inline handlers 不兼容的功能缺陷由 HTML 报告审计单独记录。

**修改建议**：以插件自有模板渲染结构化报告数据，不直接给磁盘 HTML 的任意脚本加 nonce。若必须接受 HTML，严格验证其来源和结构，CSP 缺失时拒绝脚本执行，事件监听统一放在受信脚本内。单文件报告无需磁盘资源，应明确 `localResourceRoots:[]`。VS Code 官方要求 Webview 尽可能收紧本地资源范围并设置 CSP：[Webview 安全指南](https://code.visualstudio.com/api/extension-guides/webview#security)。

## 发布质量与兼容性观察（不等同于已利用的漏洞）

1. **发布门禁缺失 / P2**：`vscode/package.json:77` 的 prepublish 只执行 esbuild，不运行类型检查或扩展集成测试；当前手工类型检查通过，但将来类型错误也可能被 esbuild 转译后发布。加入类型检查、核心回归、真实 Extension Host 命令测试和 Webview 浏览器测试。
2. **许可证与支持入口缺失 / P2**：本地包没有 LICENSE，manifest 没有 `license`、`repository`、`bugs` 或 `homepage`；没有 CHANGELOG。建议明确许可证、问题反馈地址、版本变更，以及数据发送范围、服务商、费用、密钥保存/删除、缓存删除说明。此处是产品支持与透明度要求，没有作法律违规判断。
3. **打包可精简 / P3**：VSIX 共 10 个条目，含 `esbuild.js`、`tsconfig.json`、扩展源码以及 281,812 字节 source map（内嵌 16 份源码）；脚本、配置和 sourcemap 是否公开应是显式发布策略。当前没有 `.env`、node_modules 或旧 VSIX 进入该包；不能把 sourcemap 自动等同于密钥泄露。建议通过 files 白名单或 `.vscodeignore` 固化包清单，并使用私有 sourcemap 留档支持排错。官方支持 `.vscodeignore` 排除发布无关文件：[发布扩展](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#using-vscodeignore)。
4. **能力边界不明确 / P2**：manifest 未声明工作区信任或虚拟工作区能力，代码直接使用 Node fs/fsPath。没有验证 Remote SSH、WSL、容器、多窗口和虚拟文件系统。在完成针对性测试前应清楚声明支持边界。根据官方默认行为，不应误报为“未声明 workspace trust 就能在 Restricted Mode 任意执行”。
5. **空 activationEvents 不是缺陷**：最低 VS Code 为 1.85；自 1.74 起 manifest 中贡献的 command/view 可以自动触发激活。没有理由仅因空数组判定无法激活。[VS Code Webview 示例的激活说明](https://code.visualstudio.com/api/extension-guides/webview#webviews-api-basics)。

## 建议发布验收顺序

1. 阻断回归：A/B 仓库凭据和服务地址隔离；所有取消场景零后续请求；同目录运行互斥。
2. 功能验收：报告 Webview 的搜索/过滤/自测交互全部可用；多根/子目录重开正确；模型设置真正生效。
3. 运维验收：用户可查脱敏日志、取消任务、恢复任务、删除凭据与缓存；侧栏状态即时更新。
4. 发布门禁：干净依赖安装、类型检查、自动测试、打包清单和版本一致性；对支持的最低 VS Code 版本及主要宿主平台做安装和关键流程验证。
