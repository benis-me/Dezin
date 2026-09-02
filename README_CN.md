<div align="center">

# Dezin

**由你现有的编程 Agent CLI 驱动的本地优先 Design Canvas。**

[English](./README.md) · 简体中文

</div>

---

Dezin 是一个早期、桌面优先的设计工具。每个项目都是由类型化 Node 组成的无限画布：Page、Component、Design System、Research、Tokens、Document、Layout、Knowledge 以及导入的媒体。Agent 可以规划画布、逐个生成 Node，并将选中的不可变 Version 重建为实现项目。

项目状态、画布历史、生成 Version、素材、Agent 对话、Job 和 Export 都保存在本地磁盘。Dezin 自身不运营任何服务器：没有托管账户、遥测或模型路由。所有离开你机器的网络请求都列在下方的[网络出口](#网络出口)一节，且都使用你自己提供的凭据。

## 当前产品契约

- **Canvas-first 项目。** 当前只有一个主要的 Design Canvas 工作流。旧的 Prototype/Standard 模式选择、项目 variants 和 Files/Versions workspace 不属于当前 UI。
- **类型化 Node 与不可变 Version。** 生成 HTML 会发布为带 checksum 的不可变 Node Version；导入媒体按内容寻址。画布变更使用 revision compare-and-swap，撤销/重做不会改写已发布内容。
- **Main Agent 与 Node Agent。** Main Agent 可以正常对话、执行有界的 Canvas 命令，并分发有作用域的 Node Job。Node Agent 只能发布自己的目标 Node。普通聊天只返回文本，不产生 Canvas 副作用。
- **使用你自己的 Agent。** Dezin 会发现已安装的 provider CLI 和自定义命令，并展示可用模型。Claude 与 CodeBuddy 使用最严格的工具、参数和执行身份策略；所有 provider 仍被限制在 daemon 拥有的精确 pending 工作目录和收窄环境中。在能够证明 confinement 之前，Windows 上不提供 Design 执行。
- **本地、显式的素材。** 每个 Job 都会获得冻结上下文的逐字节副本。生成 HTML 不能加载远程脚本、样式、字体、图片或其他资源。应用中的远程 Markdown 图片不会自动请求，只保留为显式链接。
- **Implementation Export。** Export 会把选中的不可变 Node Version 重建为本地目录中的 Vite + TypeScript 项目。当前**不会**下载 ZIP。
- **Fail-closed 验证。** Node HTML 和 Export source 必须依次通过路径 allowlist、URL/DOM capability、CSP、严格 TypeScript、隔离 Vite build、构建产物扫描及 Chrome 桌面/移动视觉门禁后才能发布。Export 验证刻意聚焦安全与可复现性，不是 taste linter。
- **有界恢复。** Export 最多续跑一次未完成或超时的构建，并最多执行一次带精确诊断的 repair。身份漂移、冻结输入变化、未授权路径及重复验证失败都会直接终止。

早期的 `skills × design systems × craft` 生成流水线、分阶段 Research direction gate、确定性 lint→repair、Prototype/Standard 模式、分支 variants 与 ZIP 交付已从仓库中移除，不再代表当前 Design Canvas runtime。当前架构以 [`docs/DESIGN-CANVAS.md`](./docs/DESIGN-CANVAS.md) 为准；[`docs/DESIGN-PROCESS.md`](./docs/DESIGN-PROCESS.md) 是已归档的前代方案。

## 辅助功能

- **Moodboards**：整理本地参考素材、笔记、Section 和生成图片 Node。
- **Design Systems**：内置目录与自定义系统导入。
- **Effects**：效果目录和可编辑 Effect 项目。
- **Electron 桌面端**：原生 reveal/open 与离屏预览截图。
- **Chrome 扩展**：将网页参考图捕获到 Dezin。
- **Settings 与模型发现**：管理已安装的 Agent。

## 快速开始

前置条件：**Node ≥ 22.16**、**pnpm 11**，以及至少一个已认证并位于 `PATH` 的编程 Agent CLI。

```sh
pnpm install
pnpm dev
```

`pnpm dev` 会启动本地 Node daemon 和 Vite UI。打开终端打印的 URL，创建项目，然后使用 Main Agent 或 `+ Add` 构建设计画布。

### 桌面端

```sh
pnpm desktop
```

该命令会构建 Web UI 并启动 Electron。安装包、签名、公证和自动更新尚未发布。

### 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DEZIN_PORT` | 临时端口 | 固定 daemon 端口；开发环境通常使用 `7457` |
| `DEZIN_HOST` | `127.0.0.1` | daemon 监听地址 |
| `DEZIN_DATA_DIR` | `~/.dezin` | 本地数据库、项目、素材、Job 与 Export |
| `DEZIN_SECRETS_KEY` | 未设置 | 32 字节 base64url 密钥，用于加密设置库中的 API key；桌面端会通过系统钥匙串自动生成并保存 |
| `DEZIN_AGENT_CMD` | `claude` | 默认 Agent 命令 |

## 架构

```text
apps/
  daemon/    本地 HTTP API、Canvas 权威状态、Agent Job、验证与 Export
  web/       React 19 Design Canvas、Moodboard、Design System、Effect、Settings
  desktop/   Electron shell 与原生集成
  extension/ Chrome 参考素材捕获
packages/
  agent/     provider runner 与 stream 解析
  core/      node:sqlite 元数据及旧 Sharingan workspace 状态
  design/    内置 Design System
  effects/   内置与自定义 Effect 模型
  design-canvas-contracts/  daemon 与 Web 共享的浏览器安全 wire 契约
  leafer-react/             Moodboard 画布使用的 React reconciler 桥
content/
  design-systems/           packages/design 加载的内置 Design System
```

当前 Design 主路径：

```text
React Canvas
  → daemon revision-CAS 与持久 Job ledger
  → project-owned pending 目录中的 Agent
  → 不可变 Node Version
  → 冻结 Export 上下文
  → TypeScript/Vite/static/Chrome 门禁
  → 不可变本地 Export 目录与 manifest
```

只有在 daemon 先通过 `VACUUM INTO` 创建完整备份并写入 migration receipt 后，旧 SQLite Design 表才会被破坏性退役。当前 Canvas 项目数据以文件形式保存在项目的 `design/` 目录中。

## 验证

```sh
pnpm test
pnpm test:coverage
pnpm typecheck
pnpm build:check
pnpm run ci
```

CI 会运行 workspace 测试与覆盖率门槛、类型检查、生产构建与 bundle 预算、进程泄漏检查，以及 high severity 的生产依赖审计。真实 provider QA 会消耗配额，因此需要显式启用：

```sh
DEZIN_QA_CODEBUDDY=1 pnpm qa:design:codebuddy
```

只有生产 runner/confinement 路径确实使用 `hy3-ioa`，且 Canvas/Export 产物通过正常门禁时，CodeBuddy receipt 才有效。

## 文档

- [`docs/DESIGN-CANVAS.md`](./docs/DESIGN-CANVAS.md) — 当前数据、Agent、交互与 Export 权威契约。
- [`ROADMAP.md`](./ROADMAP.md) — 已发布范围与剩余工作。
- [`docs/SELF-DESIGN.md`](./docs/SELF-DESIGN.md) — UI 设计原则。
- [`docs/DESIGN-PROCESS.md`](./docs/DESIGN-PROCESS.md) — 已归档的 Canvas 前代流水线，不是当前 runtime 承诺。
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 开发与贡献指南。

## 支持矩阵

| 平台 | 运行应用 | Agent 生成与 Export |
| --- | --- | --- |
| macOS | 支持（开发态 shell） | 支持 |
| Linux | 支持 | 支持 |
| Windows | 支持 | 暂不支持：在进程 confinement 得到验证前，Design 执行保持 fail-closed |

尚未提供打包与签名的安装包；请通过 `pnpm dev` 或 `pnpm desktop` 从源码运行。

## 网络出口

Dezin 自身不会上报任何数据。以下是全部对外连接，每一项都由你的明确操作触发，并使用你自己提供的凭据：

| 功能 | 目标 | 凭据 |
| --- | --- | --- |
| Design Canvas Agent、Moodboard Agent、提示词优化、标题生成、图片分析 | 你所用编程 Agent CLI 自己的模型服务（Claude Code、Codex、CodeBuddy 等） | 该 CLI 的登录态 |
| Moodboard 图片生成 | 你配置的 Azure OpenAI、Google AI Studio、Google Vertex、fal 或任意 OpenAI 兼容端点 | Settings → Providers 中的 API key |
| 模型发现 | 上述 provider 端点，或本机 `127.0.0.1:11434` 的 Ollama | 同一 key |
| Figma 导入 | `api.figma.com` | Settings 中的 Personal Access Token |
| Chrome 扩展捕获 | 你捕获的页面（Pinterest、Behance、Dribbble 及其图片 CDN）与本机 daemon | 配对码 |
| Sharingan 捕获 | 你输入的 URL，由本机 Chrome 抓取 | 无 |

生成的 HTML 与 Implementation Export 都经过验证，不会加载任何远程脚本、样式、字体或图片。

## 商标声明

内置 Design System 以启发其设计语言的公开产品命名（例如 Airbnb、Apple、Linear、Stripe）。这些名称是各自所有者的商标；Dezin 与它们没有任何隶属、赞助或背书关系，也不包含它们的 logo。

## License

[MIT](./LICENSE)
