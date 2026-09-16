# Code2Offer(代码转面试 · Code → Interview Prep)

读取一个**完整代码仓库**,用 DeepSeek 生成真实面试场景的全套材料:

| 产物 | 内容 |
|---|---|
| `01_项目讲解.md` | STAR 三版本(1/3/10 分钟)、架构与数据流走读、**技术选型横向对比章节** |
| `02_百问百答.md` | **恰好 100 题**,11 类别×3 难度覆盖矩阵,每题带 `文件:行号` 代码证据、追问链、加分回答、常见错误回答、对比表 |
| `03_亮点与防守.md` | 每条亮点 → 面试官追问×3 → 第一人称防守脚本 |
| `04_缺点与改进.md` | 诚实但有准备的缺点话术(根因/改进/面试怎么说) |
| `05_设计决策与选型对比.md` | 每个决策:候选方案 × 对比维度 × 客观优劣势(含所选方案缺点)× 适用边界 |
| `06_速记卡.md` | 考前 30 分钟版 |
| `index.html` | **单文件可搜索报告**:类别/难度筛选、隐藏答案自测、掌握度统计(localStorage) |
| `校验报告.md` / `质量门禁报告.md` / `自评报告.md` | 反幻觉校验、确定性质量等级、可选 DeepSeek 评委打分 |
| `run-manifest.json` / `dependency-manifest.json` | 可复现审计记录、仓库快照、阶段哈希、调用/缓存/降级摘要(不含密钥) |
| `claim-ledger.json` / `evidence-graph.json` / `quality-report.json` | 主张账本、文件→模块→题目→引用证据图、A+ 门禁指标 |

## 为什么比"直接把仓库丢给大模型 + 一句提示词"更准

差距不在模型,在四个结构性保障(全部落在代码里):

1. **先画像后精读(阶段 0,无 LLM)**:文件树/技术栈/依赖/入口/路由/DB 表/git 热点/有趣代码排名(并发/缓存/锁/设计模式/递归)由脚本确定性算出。LLM 读的是**全覆盖预消化事实**,而不是靠搜索碰运气的采样——事实层零幻觉。
2. **覆盖矩阵强制出题**:由 `coverage.ts` 硬性分配 类别×难度×模块 配额(平衡/深度模式目标 100),分批生成,每题运行时校验:引用的文件必须真实存在、行号必须在范围内。
3. **对抗校验环(阶段 3)**:校验员拿着**引用处的代码原文**逐条核对答案要点;裁决 pass / fix / flag,引用不存在的主张会被标红进 `校验报告.md`。面试里说错代码是致命的。
4. **横向对比是一级要求(非附属)**:凡"为什么用 X 而不用 Y"类问题强制"对比四段式":候选方案 → 对比维度(性能吞吐/延迟、一致性、复杂度、可维护性、运维成本、生态、扩展性、团队熟悉度)→ 客观优劣(**必须含所选方案的缺点**)→ 适用边界(什么场景应反过来选另一个)。

另外:按内容哈希**缓存 + 阶段门控**(重跑只花增量钱)、**JD 加权重排**(必考 Top20 + STAR 定制)、**模拟排练**(评分+追问+弱项追踪)、**质量门禁**(A+/A/B/partial 由确定性指标决定)。

## 快速开始

```bash
# 0) 准备 .env(项目根目录)
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat        # deepseek-flash 等推理模型也可,客户端自动适配

# 1) 构建
npm install && npm run build

# 2) 对任意仓库生成(可选 --jd 岗位描述)
#    默认每次生成新建独立目录 runs/run-NNNN:前后两次产物互不覆盖,增量缓存自动接续;
#    想固定写同一目录(旧语义)加 --out <目录>
node dist/cli/index.js generate ./你的仓库 --jd ./jd.txt --mode balanced

# 3) 使用(把 <run> 换成具体目录,如 interview-output/runs/run-0001)
#    - 浏览器打开 <run>/index.html(搜索/筛选/隐藏答案自测)
#    - 模拟排练:逐题作答 → 评分 → 追问 → 弱项记录
node dist/cli/index.js rehearse ./你的仓库/interview-output/runs/run-0001 --count 5 --top20

#    - 自评环:DeepSeek 当评委,给材料打分(满分 10)+ 改进清单
node dist/cli/index.js evaluate ./你的仓库/interview-output/runs/run-0001
```

一行体验自带示例:`npm run demo`(分析 `example-demo/` 演示仓库)。

### 在 VSCode 里用(扩展薄壳)

> 终端用户的完整图文步骤见 [vscode/README.md](vscode/README.md)(即商店市场页面正文)。

```bash
# 方式一:VSCode 商店安装(推荐)
# 扩展面板搜索「代码转面试」(发布者 DawnofHope)→ Install → 重新加载窗口

# 方式二:本地 vsix(未发布/离线环境)
code --install-extension vscode/code-interview-prep-0.8.1.vsix
# 安装后必须重载窗口(Ctrl+Shift+P → "重新加载窗口"),命令面板/右键菜单才会出现命令

# 方式三:开发调试
# 在项目根目录打开 VSCode,按 F5 → "运行扩展(扩展开发宿主)"(.vscode/launch.json 已配好);
# 修改 vscode/src 或 src/ 后:cd vscode && node esbuild.js 重新打包,宿主窗口里 Ctrl+R 重载

# 从源码重新出包:
cd vscode && npm install && npm run typecheck && node esbuild.js && npx @vscode/vsce package --no-dependencies
```

- 资源管理器**右键文件夹** → 「代码转面试:生成面试材料」(可选 JD 文件)
- **前后两次不混在一起(0.5.2)**:每次生成自动落入独立产物目录 `runs/run-NNNN`(增量接续,互不覆盖),并自动开启一个本次专属的输出通道;主通道保留完整历史
- 侧栏面板看**阶段时间轴**(8 节点逐段用时/门控命中/进行中秒表),任务条目悬停 ✕ 单独取消、🗑 移除;不同仓库可并行,同仓库误点去重
- 命令面板 → 「代码转面试:打开面试报告」(Webview 内嵌自测报告,搜索/筛选/掌握标记全可用)
- 核心是纯 TS 库(`src/core`+`src/stages`),扩展只是薄壳,也可被 CLI/CI/其他宿主复用
- 安全:`.env`/私钥等敏感文件**不会**发给模型;被分析仓库不能重定向请求端点
- 多语言:阶段 0 会归一化识别 TypeScript/JavaScript、Python、Go、Java/Kotlin、Rust、C/C++/C#、Ruby、PHP、Swift/Objective-C、Dart、Scala、Elixir/Erlang、Clojure、Lua、R/Julia、Haskell、Zig/Nim、Perl、Solidity、SQL、Shell/PowerShell，以及 Vue/Svelte/Astro、GraphQL、Protobuf、Terraform、JSON/YAML/TOML/XML、Dockerfile/Makefile 等工程文件。

### 不装任何东西:提示词包模式

`npm run export-prompts` 会把**全部 17 份提示词**(六阶段 + 修复环 2.5/2.6/3.5 + 排练评分 + 自评四评委)原样导出为 `docs/prompts/*.md`,
可手动粘贴到任意大模型工具(DeepSeek 网页版等)分阶段使用——没有覆盖矩阵/校验环的工程保障,但保留了方法论。
存档与运行代码同源(取自同一批常量/模板函数),提示词任何改动都会同步重导出入库。

## 六阶段流水线

```
阶段0 画像(无LLM)→ repo_facts.json        确定性:技术栈/路由/热点/有趣代码
阶段1 精读(DeepSeek)→ module_cards.json   模块卡:职责/关键实现/设计决策/亮点缺点
      └─ 汇总 → knowledge.json            项目知识卡:定位/架构/技术栈表
阶段2 出题 → questions.json                覆盖矩阵(经济约40/平衡与深度目标100),每题运行时校验引用
阶段3 对抗校验 → questions.json + 校验报告.md  确定性引用检查 + LLM 证伪(pass/fix/flag)
阶段4 JD加权(可选)→ 00_JD定制分析.md        必考Top20 + STAR定制
阶段5 总装 → 01~06.md + index.html         叙述类 LLM 生成,题库确定性渲染
      └─ quality → quality-report.json      确定性 A+/A/B/partial 门禁 + 证据图/主张账本
      └─ evaluate → 自评报告.md            可选 DeepSeek 评委按维度打分
阶段6 排练(rehearse 命令)→ 排练记录.md      评分/追问/弱项追踪
```

**成本控制**:每个阶段产物落盘;`state.json` 记录输入哈希,便宜目录快照可识别新增/删除/重命名;LLM 调用按内容哈希缓存。阶段 1 大模块拆为局部证据卡,阶段 2/3 使用批次与保守并发,失败只恢复对应批次。改 JD 只重跑阶段 4-5;改仓库代码只重跑受影响阶段。

### 运行模式与成本预期

- `economy`:约 40 题、轻量校验，适合先看方向；报告会明确标注“不完整”，不能当作 100 题结果。
- `balanced`(默认):目标 100 题、平衡批次和证据校验。
- `deep`:目标 100 题、全部对抗校验与更严格预算；适合最终面试材料。

每次运行都会在 `run-manifest.json` 记录调用数、prompt/completion tokens、缓存命中、重试、截断、阶段耗时、阶段哈希和质量门禁。没有真实 API 运行时不要把 mock 数据当作真实费用。

## 模型与密钥(.env)

- `DEEPSEEK_MODEL` 支持官方 `deepseek-chat` / `deepseek-reasoner`,也支持推理型模型名(如 `deepseek-flash`)。严格 JSON 的画像、出题、校验任务会自动路由到 `deepseek-chat`,避免推理过程耗尽 completion 预算；叙述类任务仍使用用户选择的模型。模型名不存在时自动回退并在日志标注。
- 单请求超时默认 300 秒,可用 `DEEPSEEK_TIMEOUT_MS` 调整(10 秒–10 分钟内生效);主模型**连续 2 次超时**(服务拥堵/降速)自动降级 `deepseek-chat` 继续完成任务;401/403/400 立即失败不重试。
- 校验/评分类调用使用低温度(0.1-0.2)+ JSON 模式。

**配置优先级与安全规则**(0.3.0 起):

1. 扩展设置里的模型名(仅扩展)> 2. 系统环境变量 > 3. 宿主目录 `.env`(CLI 的工作目录/工具根;扩展的工作区根/全局存储)> 4. 被分析仓库根 `.env`
- 端点与凭据**同源绑定**:被分析仓库 `.env` 的 `DEEPSEEK_BASE_URL` 只在该文件自己也提供密钥时生效——克隆的仓库不能把你的密钥引到它指定的地址;`BASE_URL` 强制 HTTPS(`http://localhost` 例外)
- `.env`、私钥、凭据类文件被敏感清单拦截,**绝不进入模型输入**(与 .gitignore 无关,永远生效)
- 100–300KB 文本先分段扫描高风险密钥,再进入画像/分块阶段;报告只记录路径与命中类型
- 质量分数、引用边界、A+ 资格由本地确定性检查计算,模型不能自报分数或置信度
- 评测:同一份材料重跑 `evaluate` 分数一致(评委结果按内容缓存)

## 常见问题

| 现象 | 处理 |
|---|---|
| HTTP 401 | `.env` 的 `DEEPSEEK_API_KEY` 无效或未生效(不再空转重试) |
| `网络请求失败:... fetch failed` | 新版会显示原因码: `ENOTFOUND`=DNS/域名问题、`ECONNREFUSED`=端口/本地网关未启动、`ETIMEDOUT`=网络/代理超时、`CERT_HAS_EXPIRED`=TLS 证书问题;同时检查 `DEEPSEEK_BASE_URL`、代理和防火墙 |
| 模型 not found | 换 `.env` 为 `deepseek-chat`(客户端一般已自动回退) |
| 请求反复超时 | 服务端拥堵时会自动降级 deepseek-chat;也可在 `.env` 加 `DEEPSEEK_TIMEOUT_MS=300000` 或直接 `DEEPSEEK_MODEL=deepseek-chat` |
| 生成很慢没反应 | 侧栏面板看阶段时间轴(每节点实时秒表),或输出面板本次专属通道(「代码转面试 · 仓库名 · 时刻」)逐行日志;推理模型单次 2-6 分钟属正常,可随时取消(已完成阶段保留缓存) |
| 该目录已有生成任务在运行 | 同一输出目录有运行锁,防止两条管线互相覆盖;确认无任务可删 `interview-output/.run-lock` |
| 大仓库费用 | 先用 `--max-files 20` 试跑;热点+有趣代码排名会保证核心文件必读 |
| 某题标红 flag | 见 `校验报告.md`,人工复核后再背诵——这是特性不是缺陷 |
| 某题显示「? 未覆盖」 | 校验时模型失败/漏答,重跑 generate 会自动补验该题 |
| 中文乱码(Windows 终端) | `chcp 65001` 或使用 Windows Terminal |

## 目录结构

```
src/core/      config / deepseek客户端 / profiler画像 / chunker / coverage矩阵 / prompts / schemas / runs(独立产物目录)/ runner编排
src/stages/    stage1精读 stage2出题 stage3校验 stage4JD stage5总装 stage6排练 evaluate自评
src/report/    htmlReport(单文件报告)
src/cli/       generate / rehearse / evaluate / export-prompts
vscode/        扩展薄壳(右键生成 + Webview 报告)
example-demo/  演示仓库(零依赖 Node API:LRU缓存/令牌桶限流/二级索引)
docs/prompts/  (export-prompts 生成)全部 17 份提示词原样存档
docs/版本历史.md  全量开发史(动机/变更/验证/发布状态,audit 报告为证据链)
```
