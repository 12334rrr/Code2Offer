# CLAUDE.md — Code2Offer(代码转面试)项目须知

## 是什么

项目定名 **Code2Offer**(GitHub: `12334rrr/Code2Offer`,已配 repository/bugs/homepage,vsce 不再需要 `--allow-missing-repository`)。注意:**扩展商店 ID 仍是 `DawnofHope.code-interview-prep`**(`vscode/package.json` 的 `name` 字段未改)——改名会让商店把它当全新扩展,老用户收不到更新;`displayName` 才是展示品牌。UI 里的中文通道名/命令前缀 `codeInterviewPrep.*` 同理保持不变。

读取任意代码仓库,用 DeepSeek 生成面试准备全套材料:百问百答 100 题(每题带 `文件:行号` 代码依据)、项目讲解(STAR 三版本)、亮点防守、缺点改进、选型横向对比、单文件可搜索 HTML 报告。两种使用方式:**CLI**(`src/cli`)与 **VSCode 扩展薄壳**(`vscode/`,核心逻辑全在纯 TS 库里,扩展只是壳)。

## 用户长期要求(必须遵守,2026-09-15 起)

1. **提示词全量原样存档**:所有实际使用的 LLM 提示词(六阶段 + 三个修复环 2.5/2.6/3.5 + 排练评分 + 自评四评委)必须登记在 `buildPromptDocs()`(src/core/prompts.ts),经 `npm run export-prompts` **原样**导出到 `docs/prompts/` 并入库。**新增或修改任何提示词字符串,必须同步更新登记与存档,并在同一次提交里入库**——代码中的提示词与 docs/prompts 不一致视为缺陷。新增 LLM 调用点时优先把提示词写成 prompts.ts 的导出常量(evaluate 四评委即为此从内联字符串提升),保证可导出、可逐字节比对。
2. **改完即推送**:每轮代码/文档修改完成并通过验证(`npm test`;动了扩展或 src 被扩展打包的内容时,还要 vscode typecheck + esbuild + 重打包 + `node audit/activation-smoke.cjs`)后,直接 `git add -A && git commit && git push origin main`,**不再攒着等用户再次要求**。提交前必须跑密钥扫描(见"发布纪律"):取 `.env` 真实密钥全文与前 12 位前缀,在暂存清单逐文件字节级搜索,0 命中才提交。
3. **版本历史成文**:每次发版在**两处**记录——`vscode/CHANGELOG.md`(面向商店用户的发布说明)与 `docs/版本历史.md`(全量开发史:动机 → 变更 → 验证数据 → 产物与发布状态,含未发布的内部构建)。`audit/*.md` 审计报告按版本归档保留,作为决策证据。

## 常用命令

```bash
npm run build                                # npx tsc -p .(先于一切运行)
node dist/cli/index.js generate <仓库> [--jd jd.txt] [--out <固定目录>]   # 全管线;默认每次自动独立目录 runs/run-NNNN(增量接续),--out 走旧固定目录语义
node dist/cli/index.js evaluate <run目录>     # DeepSeek 评委自评
node dist/cli/index.js rehearse <run目录> --count 5    # 交互排练
node dist/cli/index.js export-prompts        # 导出全部提示词存档 → docs/prompts/(19 份,含修复环/排练/评委)
npm test                                     # 构建 + 101 个单元/行为测试(node --test)
node audit/regression-gate.cjs               # 缺陷回归门禁:0.3.0 审计 15 缺陷探针必须全部"不可复现"(CI 同款)
node audit/s-level-audit.cjs <run目录>        # S 级确定性审计:引用精度/贴合抽样/风险给药/追问闭环/难度分
node audit/extension-host-e2e.cjs            # 真实 VS Code 宿主端到端 B 组验收(隔离窗口,需 .env 与本机 code.cmd)

# 扩展:打包 + 安装(版本号在 vscode/package.json 的 version,当前 0.9.1;商店要求纯数字点分版本,禁止 -rc/-beta 等预发布号)
cd vscode && npm run typecheck && node esbuild.js && npx @vscode/vsce package --no-dependencies
code --install-extension vscode/code-interview-prep-<版本>.vsix

# 发布前产物验证(从 vsix 解出 extension.js,用 mock vscode API 走 activate/四命令/报告 CSP 全路径)
node audit/activation-smoke.cjs   # 9 项断言;含"包内文件 == 本地构建"的 sha1 一致性检查
```
商店市场页正文 = `vscode/README.md`(打进 vsix 的 readme.md),面向终端用户;根 README 面向开发者。改前者后必须重新打包。

**装完 vsix 必须「重新加载窗口」或重启 VSCode**——活动栏图标、命令都是窗口加载时注册的,只切面板不生效。这是历史上"插件调用失败/看不到插件"的最常见原因。

## 模型与密钥(当前状态,2026-09,0.3.0 起)

- `.env` 在项目根:`DEEPSEEK_MODEL=deepseek-flash`(已实测可用,2026-09-15 验证 2.3s 响应)。CLI 与扩展读同一份。
- flash 是**推理模型**:重提示词单次 2–6 分钟属正常;单请求超时默认 300s(`DEEPSEEK_TIMEOUT_MS` 可调,10s–10min 钳制)。
- 连续 2 次超时自动降级链 `FALLBACK_CHAIN`(src/core/deepseek.ts):`deepseek-v4-pro` → `deepseek-chat`。网关 `/models` 实测只有 flash 与 v4-pro 两个真身,`deepseek-chat` 是 flash 的别名(降级到最后一步等于没换)。401/403/400 立即失败不重试。
- **配置优先级**(loadConfig,src/core/config.ts):扩展设置模型名 > 系统环境变量 > 宿主目录 .env(CLI:cwd/工具根;扩展:工作区根/全局存储)> 被分析仓库 .env。**端点与凭据同源绑定**:仓库 .env 的 BASE_URL 只在它自己也提供密钥时生效;BASE_URL 强制 HTTPS(localhost 例外)。扩展**不写 process.env**——配置一次一解析显式传参(修复跨仓库凭据污染)。
- **安全**:敏感文件拒绝清单(profiler)+ 内容级密钥扫描,`.env`/私钥类绝不进模型输入;`.env` 永不入库(.gitignore 已含)、永不打进 vsix;错误消息密钥打码。

## 架构要点

- 六阶段管线(`src/core/runner.ts` 编排,`state.json` 输入哈希门控,未变化阶段直接跳过):
  0 画像(无 LLM,确定性)→ 1 精读(模块并发 3)→ 2 覆盖矩阵出题(**目标题量自适应**:economy 20 / balanced 40 / deep 60,`RunOptions.maxQuestions` 10-100 可覆盖;补题按配额缺口定向)→ 2.5 对比块补齐 / 2.6 要点实质化 / 2.7 引用消毒 → 3 对抗校验(pass/fix/flag/**unverified**,批次解析失败对半拆批重试)→ **3.5 标红题重写**(校验报告随后重算)→ **3.6 风险给药兜底 + 引用终检**(0.8.1)→ 4 JD 加权(可选,形状校验防毒缓存)→ 5 总装(四份文档并行 + 架构图 + 源码词典)。
- **门控哈希基于内容**(0.3.0 起):画像 = 文件清单+精读文件内容哈希;精读 = overview+chunks 全文哈希;校验 = 题目全文+分块+提示词+模型。等长改码、重出题、改答案都会正确失效。
- **运行锁**:同一输出根同时只允许一条管线(进程内 Map + `.run-lock` 锁文件,PID+时间戳,45 分钟过期;0.5.2 起锁在输出根,自动独立目录模式下同一仓库同样只有一条)。
- **取消**:`RunOptions.abort` 贯穿全部阶段与每个模型请求;扩展把 VSCode CancellationToken 接到它上面。
- **输出分离(0.5.2)**:默认每次生成自动新建 `<仓库>/interview-output/runs/run-NNNN` 独立目录(src/core/runs.ts:allocateRunDir/carryForwardIncrement/latestRunDir/repoRootOfOutput)——上一次的 state.json/画像/模块卡/题库/JD/校验断点/.cache 自动携带接续(最终产物与 .run-lock **绝不携带**);显式 `--out` 走旧覆盖语义。日志层 `withLogSink()`(AsyncLocalStorage)把一次运行的整棵异步调用树日志同时路由到「专属 sink + 全局 sink」——扩展据此每次生成自动创建并弹出独立输出通道「代码转面试 · 仓库 · 时刻」,主通道保留完整历史,任务 🗑 时连同通道 dispose;rehearse/evaluate/topup 的仓库根从 run-manifest 反推(repoRootOfOutput)。
- **阶段事件(0.4.0)**:`RunOptions.onStage` 发结构化事件(profile/read/questions/verify/rewrite/jd/assemble/done × start/done/cached/skip + 用时)。扩展面板据此渲染时间轴:`tasks` Map 支持**多仓库并行任务**,同仓库按输出根去重(误点弹「查看进度/取消并重新开始」),条目内联 ✕ 取消/🗑 移除,1s ticker 刷进行中秒表。CLI 不用 onStage,行为不变。
- **统一日志**:`src/core/logger.ts`——所有阶段用 `log()/warn()`,扩展注入 LogOutputChannel;不要在 stages 里直接 console.log。
- **缓存键包含 system 提示词全文**(`stage5Assemble.ts` / `stage2Questions.ts`),verify 门控含 STAGE3 提示词 sha1 且**改记终态哈希**(3.6 给药/引用终检之后的题库内容);`PROMPT_VERSION` 现为 '3'。改提示词任何一字,对应产物缓存立即失效、定向重生成。
- **引用精度(S 级)**:`MAX_CITE_SPAN = 40`(schemas.ts 单源,审计/校验/消毒/补齐同尺);消毒同时序在 2.7 与 3.6「终检」各跑一次——校验改写会引入新引用;`riskWithoutFix`(schemas 导出)与审计脚本同一把尺子。
- **分层架构图(0.9.1 v2)**:src/report/archDiagram.ts 由 RepoFacts+模块卡**确定性**推导(入口→路由→模块→数据/配置,空层省略,按文件归属连线),暗色成品级样式(标题区/徽章/虚线层容器/语义边色/图例);阶段 5 落盘 `架构图.svg`+`架构图.drawio` 并**内嵌 index.html 顶部**——SVG 节点带 `data-mod`/`data-id`,报告内点击经事件委托打开右侧词典抽屉(模块→关联题目)。**源码词典**:总装按题目引用抓真实源码摘录(renderHtml `sources`),报告内点击 `文件:行号` 抽屉展示带行号源码+关联题目;零 LLM token。demo/(提交的真实报告)经 demo-pages.yml 自动发布 GitHub Pages;隐私政策/服务条款在 docs/,商店页引用。
- 横向对比是一级硬要求:`isValidComparison` 严格版(矩形表/非空单元格),不合格块剥除后由 2.5 环补齐。
- 引用语义:行数 = `splitFileLines`(去尾空行),边界 `1 ≤ start ≤ end ≤ total`;校验断点带输入指纹,题库重生成自动作废。
- **测试**:`npm test`(build 后跑 `node --test "dist/tests/*.test.js"`,99 个用例,覆盖 config 优先级/端点绑定、gitignore 语义、敏感清单、引用边界、配额缺口、自适应题量缩放、CLI 旗标、HTML 无内联事件、runs 目录分配/增量携带、logger 上下文隔离等)。修复行为先在 tests 里加断言。

## 已知事实与坑

- **评委噪声**:evaluate 评委结果已按内容缓存——同一份材料重跑分数一致;只有改材料/删 `.cache` 才会变。迭代决策以确定性维度为准。
- 仓库已推送 GitHub(origin=SSH `git@github.com:12334rrr/Code2Offer.git`),`repository` 字段已配,vsce 不再需要 `--allow-missing-repository`;publisher=`DawnofHope`,已上架 VSCode 商店。0.3.0 起 prepublish 含类型检查;`.vscodeignore` 排除源码/sourcemap。
- **CI 常驻**(.github/workflows/ci.yml):push/PR 即跑 `npm test` + 缺陷回归门禁 + mock 合约 + 扩展打包 + 冒烟——不需要密钥;真实模型 e2e 仍需本地手动跑。商店图标 `vscode/media/icon128.png` 由 `node scripts/make-icon.cjs` 确定性再生成;LICENSE=MIT(两包 license 字段已配)。`npm audit --omit=dev` 双包 0 漏洞(0.8.1 时点)。
- 修改 `src/` 后:扩展需 `node esbuild.js` 重打包并在宿主里 Ctrl+R;CLI 需 `npm run build`;测试 `npm test`。
- 修复环(cmp-repair / points-repair / flag-rewrite / stage4-JD)都有「缓存命中也要复验形状 + 重试」结构,新增 LLM 消费方照此写(否则坏形状缓存会造成重跑必崩)。
- Windows 终端中文乱码:`chcp 65001`。历史示例产物在 `example-demo/interview-output/`(100 题,自评 8.3–8.9,确定性合规 10.0;系 0.2.x 行为生成)。
