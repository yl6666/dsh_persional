# dsh-repo-board — 多仓协作开发插件（DeepSeek Harness）

> 一个会话一个代码仓库：把「一次下发、多仓协同」的需求变成现实。
>
> 下发一次跨仓需求 → 自动澄清 → 生成影响分析 → 拆成每仓一份修改方案 → 按依赖拓扑逐仓开子代理执行 → 回收结果与提交。

## 这是什么

多仓卡开发的核心痛点是**仓与仓之间的关系不可见、跨仓改动靠人肉传递**。本插件把仓库关系建模为一张 **RepoGraph**（四层边：build / code / contract / semantic），在 DSH（DeepSeek Harness）里提供从关系到执行的全链路：

```
repo_board_scan     扫描一组本地仓库 → 抽取 manifest 依赖 + 契约（OpenAPI/protobuf/GraphQL/事件）→ 生成关系图
repo_board_dispatch 登记跨仓需求，进入追问澄清（§5.2）
repo_board_clarify  登记追问与回答，收敛需求
repo_board_spec     产出结构化 RequirementSpec + 影响分析（受影响仓、契约环、断裂变更）
repo_board_plans    生成每仓一份 RepoModificationPlan + 评审发现 + 执行顺序
repo_board_execute  按拓扑分批、每仓一个一次性子代理会话执行（一会话一仓），汇总结果
```

七个模型工具 + 一个人工提交确认工具 + 一个图形化看板，覆盖《[docs/product-design.md](docs/product-design.md)》§8 的八个下发步骤。

## 安装

```bash
# GitHub（构建产物 lib/ 已提交，安装零构建）
dsh plugin add github:yl6666/dsh_persional

# 内网/离线 tarball（pnpm pack 产物）
dsh plugin add ./dsh-repo-board-0.1.0.tgz
```

要求：DSH 宿主（提供 `ctx.tools` / `ctx.subagents` / Web GUI），Node ≥ 22。宿主服务全部按结构化类型探测，缺哪块就自动少注册哪块，不会导致启动失败。

## 使用

### 1. 在会话里让模型干活

对 DSH 会话说：

```
扫描 test/demo-repos 下的四个仓库，建立关系图。
```

模型会调用 `repo_board_scan`；随后可以直接下发需求：

```
需求：订单取消时需要通知用户，且取消原因要进事件载荷。
```

模型走 `repo_board_dispatch → clarify → spec → plans → execute`，每仓一个子代理会话在本仓完成修改并提交（默认不 push）。

### 2. 图形化看板（Graph Editor）

Web GUI 右侧栏出现「多仓看板」标签页（会话输入区也有 ⬡ 启动按钮）：

- **读图**：上游在左、下游在右，按拓扑深度分列；契约边琥珀色并标注契约名，候选边虚线，契约环成员标红并列出环友。
- **改图**：选中边 → 确认 / 抑制 / 删除；「手动连边」→ 点起点 → 点目标 → 选类型（contract 可填契约名）。
- **需求管道**：右侧列出每个需求的当前状态（draft → clarifying → spec-ready → analyzed → planned → dispatched）。

看板数据来自宿主路由 `/repo-board/graph.json`、`/repo-board/requirements.json`，编辑动作经 `/repo-board/edges` 落库（人工边优先、抑制永不复活）。

## 架构

```
src/
  graph/      领域核心：数据模型、拓扑/影响面/SCC 算法、持久化存储
  extract/    manifest 提取（npm/pip/go/cargo/maven/gradle/nuget 7 生态）+ 契约提取
  scan/       仓库目录扫描（跳过二进制/依赖目录，内容指纹增量）
  pipeline/   需求管道：DraftRequirement → Spec → ImpactAnalysis → Plans → ExecutionRun
  exec/       git 封装（porcelain 解析、commit/push/clone）+ Kahn 拓扑分批执行器
  dsh/        DSH 宿主绑定：结构化类型、每仓子代理提示词、会话任务
  tools.ts    七个模型工具（raw JSON-Schema 定义）
  webserver.ts 宿主 Web 路由（图/需求/边编辑）
  client/     浏览器半：布局视图模型 + React 看板 + 插件注册
  service.ts  cordis 服务 repoBoard（图生命周期 + 需求登记 + 派发）
```

- **Host 半**：`cordis.patch.yml` 注册 `dsh-repo-board`（服务）、`/tools`（模型工具）、`/web`（路由）。
- **Client 半**：`dsh.client` 声明 + `exports["./client"]` 预构建 bundle（ModuleLoader 闭包格式，react/cordis/UI kit 走宿主模块表）。

## 开发

```bash
pnpm install
pnpm test          # 120 tests (vitest)
pnpm typecheck     # tsc --noEmit
pnpm run build:all # tsc (host) + esbuild (client bundle)
pnpm pack          # 产出可安装 tarball
```

设计文档：[docs/product-design.md](docs/product-design.md)（中文，~600 行，含全部数据模型、算法、协议与决策点）。

## 已知边界（§12 决策点）

- 语义层标注默认静态启发，LLM 语义标注开关待接；
- git push 凭据沿用本机 credential helper，插件不存凭据；
- 契约环强制人工评审（`planConflicts` 报 `needs-human`），不自动执行。

## License

MIT
