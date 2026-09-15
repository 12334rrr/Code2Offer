# CLAUDE.md — Code2Offer(代码转面试)项目须知

## 是什么

项目定名 **Code2Offer**(GitHub: `12334rrr/Code2Offer`,已配 repository/bugs/homepage,vsce 不再需要 `--allow-missing-repository`)。注意:**扩展商店 ID 仍是 `DawnofHope.code-interview-prep`**(`vscode/package.json` 的 `name` 字段未改)——改名会让商店把它当全新扩展,老用户收不到更新;`displayName` 才是展示品牌。UI 里的中文通道名/命令前缀 `codeInterviewPrep.*` 同理保持不变。

读取任意代码仓库,用 DeepSeek 生成面试准备全套材料:百问百答 100 题(每题带 `文件:行号` 代码依据)、项目讲解(STAR 三版本)、亮点防守、缺点改进、选型横向对比、单文件可搜索 HTML 报告。两种使用方式:**CLI**(`src/cli`)与 **VSCode 扩展薄壳**(`vscode/`,核心逻辑全在纯 TS 库里,扩展只是壳)。

## 常用命令

```bash
npm run build                                # npx tsc -p .(先于一切运行)
node dist/cli/index.js generate <仓库> [--jd jd.txt]   # 全管线
node dist/cli/index.js evaluate <输出目录>    # DeepSeek 评委自评
node dist/cli/index.js rehearse <输出目录> --count 5   # 交互排练
node dist/cli/index.js export-prompts        # 导出六阶段提示词 → docs/prompts/
npm test                                     # 构建 + 46 个单元/行为测试(node --test)

# 扩展:打包 + 安装(版本号在 vscode/package.json 的 version,当前 0.3.0)
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
  0 画像(无 LLM,确定性)→ 1 精读(模块并发 3)→ 2 覆盖矩阵出题(恰好 100 题,补题按配额缺口定向)→ 2.5 对比块补齐 / 2.6 要点实质化 / 2.7 引用消毒 → 3 对抗校验(pass/fix/flag/**unverified**)→ **3.5 标红题重写**(校验报告随后重算)→ 4 JD 加权(可选,形状校验防毒缓存)→ 5 总装(四份文档并行)。
- **门控哈希基于内容**(0.3.0 起):画像 = 文件清单+精读文件内容哈希;精读 = overview+chunks 全文哈希;校验 = 题目全文+分块+提示词+模型。等长改码、重出题、改答案都会正确失效。
- **运行锁**:同一输出目录同时只允许一条管线(进程内 Map + `.run-lock` 锁文件,PID+时间戳,45 分钟过期)。
- **取消**:`RunOptions.abort` 贯穿全部阶段与每个模型请求;扩展把 VSCode CancellationToken 接到它上面。
- **统一日志**:`src/core/logger.ts`——所有阶段用 `log()/warn()`,扩展注入 LogOutputChannel;不要在 stages 里直接 console.log。
- **缓存键包含 system 提示词全文**(`stage5Assemble.ts` / `stage2Questions.ts`):改提示词任何一字,对应产物缓存立即失效、定向重生成;`PROMPT_VERSION` 现为 '2'(0.3.0 行为变更已整体失效旧缓存)。
- 横向对比是一级硬要求:`isValidComparison` 严格版(矩形表/非空单元格),不合格块剥除后由 2.5 环补齐。
- 引用语义:行数 = `splitFileLines`(去尾空行),边界 `1 ≤ start ≤ end ≤ total`;校验断点带输入指纹,题库重生成自动作废。
- **测试**:`npm test`(build 后跑 `node --test dist/tests/`,46 个用例,覆盖 config 优先级/端点绑定、gitignore 语义、敏感清单、引用边界、配额缺口、CLI 旗标、HTML 无内联事件等)。修复行为先在 tests 里加断言。

## 已知事实与坑

- **评委噪声**:evaluate 评委结果已按内容缓存——同一份材料重跑分数一致;只有改材料/删 `.cache` 才会变。迭代决策以确定性维度为准。
- 仓库已推送 GitHub(origin=SSH `git@github.com:12334rrr/Code2Offer.git`),`repository` 字段已配,vsce 不再需要 `--allow-missing-repository`;publisher=`DawnofHope`,已上架 VSCode 商店。0.3.0 起 prepublish 含类型检查;`.vscodeignore` 排除源码/sourcemap。
- 修改 `src/` 后:扩展需 `node esbuild.js` 重打包并在宿主里 Ctrl+R;CLI 需 `npm run build`;测试 `npm test`。
- 修复环(cmp-repair / points-repair / flag-rewrite / stage4-JD)都有「缓存命中也要复验形状 + 重试」结构,新增 LLM 消费方照此写(否则坏形状缓存会造成重跑必崩)。
- Windows 终端中文乱码:`chcp 65001`。历史示例产物在 `example-demo/interview-output/`(100 题,自评 8.3–8.9,确定性合规 10.0;系 0.2.x 行为生成)。
