# dsh-session-auto-title

DSH（DeepSeek Harness）插件：在**每轮对话结束后**用一次辅助模型调用，把会话标题重写成统一约定 `MMDD｜类型｜主题`。

A DSH plugin that re-titles a session after **every** conversation turn through one auxiliary model call, in the fixed convention `MMDD｜类型｜主题` (Shanghai date ｜ category ｜ topic).

## 为什么是插件而不是外部脚本

会话日志在同一时刻只有一个写入者（跨进程内核锁），而持有写句柄的正是跑这场对话的进程。外部改名脚本因此必然失败：

```
SessionAlreadyOwnedError: 会话正被运行中的 Harness 独占
```

能在会话运行期间给它改名的，只有会话自己进程内的 `ctx.sessionTitle` 通道——所以本插件注册的是一个 **provider**，不是脚本。

## 行为

| 方面 | 说明 |
| --- | --- |
| 约定 | `MMDD｜类型｜主题`，分隔符为全角竖线 `｜`(U+FF5C) |
| MMDD | 上海时区，取自该会话**首条人类消息**的时间，不由模型臆造 |
| 类型 | 必须从 `功能｜设计｜修复｜优化｜发布｜探索｜文档｜研究` 中选恰好一个 |
| 主题 | 简体中文，≤ 20 个字符，不得出现工作区/项目/目录/文件名，不得重复类型词 |
| 长度护栏 | 整串按 78 字节归一化，保证前缀永远不会被截断 |
| 节奏 | `afterEveryTurn`（默认开）在 `turn/end` 走 `sessionTitle.refresh()` 显式刷新 |
| 输出校验 | 模型输出先归一化再按约定重建；不合规就抛错并留下原标题，只记 `warn`，绝不写入半成品 |
| 注入防护 | 源消息以 JSON 数组框架化后送入，用户正文无法破坏分隔符或伪造字段 |

## 设计要点：为什么不用服务自带的自动节奏

`ctx.sessionTitle` 服务自身的 `all-prompts` 节奏要等该轮的 `request/header` 落盘才开始生成；而一个长生命周期会话的一个请求序列只记**一条** `request/header`，不是每轮一条。缺 header 的新轮次既不走 header 路径也不满足 step 边界的兜底条件，标题会**静默停止更新**。本插件因此从 turn 边界驱动服务公开的 `refresh()` 路径。

## 手动改名会被尊重

被手动改过的标题其 `source.kind === "user"`，插件检测到就直接跳过，标题保持"钉住"状态，不再自动覆盖。把会话 id 填进 `unpinSessions` 可以释放**一次**钉子，之后恢复常规的每轮自动命名。

## 安装

1. 把本目录放进任意位置，作为 profile 的本地依赖（profile 用 npm 还是 pnpm，就用对应命令）：

   ```bash
   cd ~/.dsh/profiles/<profile>
   pnpm add file:/absolute/path/to/dsh-session-auto-title   # 或 npm i file:/...
   ```

   > `file:` 依赖会被**拷贝**进 `node_modules`（不是软链；本机 desktop profile 是 pnpm + hoisted linker，实测得到的是拷贝）。所以改完源目录必须重跑一次上面的安装命令，profile 才会看到新代码。

2. 在同一个 profile 的 `package.json` 里把插件加进 bundle 列表：

   ```json
   { "dsh": { "profile": { "bundles": ["...", "dsh-session-auto-title"] } } }
   ```

3. 重启客户端。插件自带的 `cordis.patch.yml` 会自动禁用内置的 `session-title-llm` provider 并插入本 provider（`ctx.sessionTitle` 只接受一个 provider 注册）。

### 发布到 npm（可选）

本包没有 `private` 守卫，`files` 白名单只含 `lib` 与 `cordis.patch.yml`（`README`、`LICENSE`、`package.json` 由 npm 自动带上），可以直接发布。注意 `npm publish` 必须发到公共 registry，国内镜像（如 npmmirror）是只读的：

```bash
npm login
npm publish --registry=https://registry.npmjs.org
```

## 配置

挂载即可用，全部字段有默认值。需要覆盖时在 profile 的 loader 配置里给出：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `provider` / `model` | 未设 | 显式指定标题模型路由；两字段必须同时给出，否则沿用该轮已记录的请求路由 |
| `maxSourceMessages` | `8` | 标题模型能看到的末尾人类消息条数 |
| `maxInputBytes` | `8192` | 框架化输入的字节上限，超限即放弃本次命名 |
| `maxOutputTokens` | `96` | 辅助调用输出上限 |
| `timeoutMs` | `60000` | 单次辅助调用超时 |
| `maxTopicCharacters` | `20` | 主题长度上限（按码点计） |
| `unpinSessions` | `[]` | 需要交还自动命名的会话 id，释放一次后自动移出 |
| `afterEveryTurn` | `true` | 是否每轮结束后重命名 |

## 已知限制

- 每个对话轮次多一次模型调用（量很小：8 KB 输入 / 96 token 输出上限），有 token 成本与几十毫秒到数秒的延迟。
- 标题会随对话推进而漂移：每轮都是重新生成，不是只在首轮定稿。
- 会话首次命名前若模型调用失败，标题保持平台兜底值（通常是首条消息截断），不会报错给用户。

## 依赖与兼容

作为 DSH 插件运行，需要宿主提供 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session-title`、`@deepseek-ai/dsh-util-values`。实证环境：DSH Desktop / profile `desktop`，2026-09-18。

## 许可

[MIT](./LICENSE) © 2026 cn-scuo-oo。
