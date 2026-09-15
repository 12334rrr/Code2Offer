# 核心层专项审计

日期：2026-09-15。所有动态复现只用合成文件、虚构密钥和 mock fetch，没有访问真实模型 API。`core-regressions.cjs` 的 15 个 PASS 表示缺陷成功复现，不表示产品质量合格。

## C-A｜高：敏感文件进入模型输入

- 位置：`src/core/profiler.ts:119`、`:279`、`:409`；`src/core/chunker.ts:33`；`src/stages/stage1Read.ts:143`。
- 机制：没有敏感文件拒绝清单，`.env` 被识别为配置文件并加权；读取后原样进入精读 prompt。项目 `.gitignore` 只排除 `.env.local`，没有排除 `.env`。
- 复现：C01；且现存 `interview-output/repo_facts.json` 中 `.env` 同时出现在 files 与 readingPlan。只检查了该元数据，没有打印密钥。
- 影响：被分析仓库的 API Key、数据库密码等可能发往配置的模型服务。现有证据不能证明线上密钥已经泄露。
- 建议：独立于 gitignore 的敏感路径拒绝清单（`.env*` 默认拒绝，仅无真实值的 example 模板例外）、密钥模式扫描、上传前文件与目的端预览；配置文件读取通道和分析源码通道完全分离；默认脱敏日志。

## C-B｜高：gitignore 语义失真使用户排除规则失效

- 位置：`src/core/profiler.ts:63-85`、`:102-129`。
- 复现：C02 `/secret.ts`、C03 子目录 `.gitignore`、C04 `secret[0-9].ts`、C05 `**/secret.ts` 均未排除目标。字符组被静默跳过，globstar 替换后再次被 `*`/`?` 替换破坏。
- 影响：秘密/私有源码可能被误读；生成物、依赖等可能污染画像并增加模型费用。
- 建议：使用 Git 原生枚举能力或成熟 ignore 实现并处理分层规则；敏感文件清单应独立生效；列出被跳过/不支持的规则。
- 依据：[Git 官方 gitignore 语义](https://git-scm.com/docs/gitignore)。

## C-C｜高：仓库可替换请求目的端并搭配环境密钥

- 位置：`src/core/config.ts:55-60`；`src/core/deepseek.ts:110-119`。
- 复现：C11 用环境中的 FAKE_ENV_KEY 与仓库 `.env` 的 `http://untrusted.invalid` 配对成功，未发送请求。
- 影响条件：用户在环境中只设置 key，没有固定 base URL，随后分析含自定义 endpoint 的仓库。密钥及源码会被发送到仓库指定端点；HTTP 也没有被拒绝。
- 建议：凭据和端点绑定为一个受信配置档；仓库设置不得静默覆盖目的端；非默认域名首次使用明确呈现；默认只允许 HTTPS，开发用 localhost 单独开关。

## C-D｜中：配置优先级和解析行为不符合说明

- 位置：`src/core/config.ts:38-48`、`:15-28`、`:69-70`。
- 复现：C10 工具根 `.env` 覆盖目标 `.env`；C12 行内注释进入 key；C13 Infinity 超时通过配置检查但 `AbortSignal.timeout` 抛 `ERR_OUT_OF_RANGE`。
- 建议：明确定义来源优先级并逐字段显示来源（密钥只显示已设置）；使用标准 dotenv 解析或完善测试；超时须为有限整数且设置上限。

## C-E｜中：输入预算与分析覆盖不受可靠约束

- 位置：`src/core/chunker.ts:46-56`；`src/stages/stage1Read.ts:18-37`；`src/core/profiler.ts:124`、`:398-418`。
- 复现：C06 290000 字符单行完整进入一个 chunk，是默认 14000 参数的 20.7 倍，truncated 为空；C07 13 个模块只剩 12 个，无丢弃列表。
- 影响：单模块可能聚合大量超长代码，超过上下文或显著增加成本；默认只选 40 文件、300KB 文件跳过、模块限制均不等于完整阅读仓库。
- 建议：按实际字符/模型 token 预算切分，并对单行兜底截断；模块分批归约，禁止静默丢弃；报告展示扫描、选择、实际读取覆盖率和遗漏原因。

## C-F｜中：画像启发式把推测包装为事实

- 位置：`src/core/profiler.ts:186-210`、`:213-245`。
- 复现：C08 `cache.get("admin-token")` 被识别为 GET 路由；C09 子包 `main:lib/entry.js` 未以包目录解析，入口丢失。
- 建议：按语言 AST/框架上下文识别；入口基于 manifest 所在目录解析；区分“静态确认”“启发式推测”“未覆盖”，去掉“事实层零幻觉”的绝对承诺。

## C-G｜中：模型传输失败与输出不完整缺少可靠语义

- 位置：`src/core/deepseek.ts:47-98`、`:124-135`、`:140-154`。
- 复现：C14 非空且 finish_reason=length 的截断输出被直接当成功返回；C15 401 永久认证错误请求 4 次，模拟服务回显的虚构 key 原样出现在警告与最终异常。
- 建议：按状态码分类，401/403/无效参数直接失败，429/5xx 遵循 Retry-After 并加抖动；返回带 finish_reason/usage/model 的类型化结果；截断必须续写或标记 incomplete；统一脱敏第三方错误，禁止回显 key；端到端 AbortSignal 与费用/重试预算。
- 限制：没有证明真实服务会回显实际 key；这里确认的是应用没有处理这种输入。

## C-H｜中：同步画像阻塞宿主事件循环

- 位置：`src/core/profiler.ts:102-129`、`:292-297`、`:425-489`。
- 实测：2000 个合成 TypeScript 文件、14.2MB，一次画像耗时 800.09ms，预先排队的 setImmediate 延迟 800.52ms；仅选了 40 个文件，但依然扫描所有文件。数值来自本机一次运行，不是生产性能或跨机器 SLA。
- 风险：运行在 VS Code Extension Host 时会阻塞该宿主上的其他扩展；全历史同步 git log 无 timeout，长期仓库风险更高。
- 建议：worker/子进程执行画像、单次读取复用、限制 git 历史与超时、流式读取、进度和取消；对大仓库建立耗时、峰值内存及事件循环延迟门槛。

## 执行方式

```powershell
npm run build
node --test audit/core-regressions.cjs
node audit/core-benchmark.cjs
```

原始证据：`audit/results/core-regressions.txt`、`core-benchmark.json`、`profile-artifact-metadata.json`。
