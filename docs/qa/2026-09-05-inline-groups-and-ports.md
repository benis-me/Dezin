# Design Canvas：端子与内嵌群聊复审

范围：节点连接、群聊输入/阅读/上下文、对应事件订阅与测试启动清理。React 19、React Flow，沿用 `DesignStyles/uni` 的紧凑编辑器、语义颜色和 reduced-motion 约定；按 AGENTS.md 和 Ponytail 优先删除、复用。使用内置 Jakub Krehel `better-interface` 及六个领域指引。

非目标：复制 Babel 的运行时、重写 Agent 框架、自动迁移已有节点尺寸、补全历史测试覆盖率。此前群聊摘要卡片的验收结论由本次复审替代。

## 覆盖

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | 端子 AX 名称、Enter 连接、可见焦点；群聊文本框与发送按钮；浅/深色计算颜色 | 已检查并修复端子不可达、焦点对比度问题 |
| Layout | 1280×720；320px 窗口中 Enter 定位群聊；新建 440×520 群聊与旧 400×320 群聊 | 控件可达，新节点居中；320px 为画布缩放视图，不宣称正文达到桌面字号 |
| Writing | 空状态、上下文折叠栏、You/Coordinator、运行与失败呈现 | 删除只会填入固定提示词的两颗按钮；讨论与设计任务状态分开呈现 |
| Typography | 100% 缩放正文 12.5px/18.5px、标题 13px、折叠栏 12px/18px；实际中文多行消息 | 阅读区与输入区独立，内容不再截成三行摘要 |
| Colors | 浅色正文/次级文字对卡片 18.71:1 / 5.04:1；深色 15.97:1 / 6.66:1；端子边框沿用次级文字色 | 焦点改用 accent；对卡片浅色 4.34:1、深色 7.41:1 |
| UI | 点击、拖拽、键盘连接；输入、发送、草稿保留、双击拉近、独立回复、刷新 | 已验证下列交互；没有新增聊天存储或执行链 |

## 已修复的发现

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | UI | `apps/web/src/design-canvas/DesignCanvasNode.tsx:789` | 群聊是摘要卡，聊天需要额外浮层 | 删除 GroupChatPreview，直接内嵌现有 CanvasAgentPanel | 节点自身应能阅读、输入和继续讨论 |
| HIGH | Accessibility | `apps/web/src/design-canvas/DesignCanvasNode.tsx:741` | 端子透明、1px、禁用连接 | 显示圆形输入与圆角方形输出，28px 命中区，支持点击/拖拽/Enter | 连接应可发现且不依赖精细拖拽 |
| HIGH | UI | `apps/web/src/design-canvas/useDesignCanvasController.ts:323` | 多面板各自订阅；共享订阅初版曾丢失连续 thread 事件，使回复停留在 Thinking | 共用一条画布订阅，按 thread 保存最新修订，只刷新对应会话 | 新回复不能被无关事件取消或吞掉 |
| MEDIUM | UI | `apps/web/src/design-canvas/DesignCanvasNode.tsx:721` | 点端子同时触发节点选择，弹出的 Agent 遮挡连接目标 | 端子点击不再冒泡到节点选择 | 连线时目标应保持可操作 |
| MEDIUM | Layout | `apps/web/src/design-canvas/DesignCanvasScreen.tsx:711` | 新节点以视口中心作为左上角，较高群聊容易露出半张 | 默认按节点尺寸居中；明确指定的位置继续沿用 | 新建后输入区应可见 |
| MEDIUM | Colors | `apps/web/src/design-canvas/design-canvas.css:85` | 新端子的旧 ring 色对浅色卡片不足 3:1 | 焦点采用既有 accent 色 | 键盘焦点应有足够对比度 |

## 验证

- 三个相关前端文件：85 项通过。仅新增内嵌群聊主路径、无关事件不取消回复刷新两个回归；扩展原有事件和测试入口检查，没有新测试工具。
- 测试入口原有 8 项通过；真实浏览器的脚本错误、空白/溢出和中止清理检查 3 项通过，`PROCESS LEAKS: PASS`。
- `pnpm typecheck`、`pnpm build:check`、`git diff --check` 通过。初始 JS gzip 283.7 / 297.6 KiB，总 JS gzip 875.6 / 888.9 KiB。
- 隔离数据 `/tmp/dezin-iteration-20260905/data`，应用内浏览器 `http://127.0.0.1:5176`：点击、Enter、拖拽各创建一条连线；刷新后共 7 条连线保留。69% 与 100% 缩放下端子命中区均为 28px。
- 草稿移出视口再返回仍保留；输入/消息滚动不会拖动画布；双击标题拉近群聊，Enter 定位后焦点进入文本框。
- Codex / gpt-5.6-sol 在两个群聊完成三轮真实回复：原群收到确认并正确识别三个已连接样稿；新群单独回复“新的讨论已开始。”。回复自动出现；刷新后各自历史保留，没有串群。
- 三张预览仍是明确标注的手动样稿，仅验证版本、上下文和交互。上述真实回复不等于生成设计稿的质量验收。

复跑：

```sh
pnpm --filter @dezin/web test src/design-canvas/DesignCanvasScreen.test.tsx src/design-canvas/useCanvasAgentPanelController.test.tsx src/design-canvas/useDesignCanvasController.test.tsx
node --test scripts/test-all.test.mjs
node scripts/check-process-leaks.mjs -- node --experimental-strip-types --experimental-sqlite --no-warnings --import ./apps/daemon/test/no-proxy.ts --test --test-concurrency=1 --test-name-pattern='observes real synchronous|rejects blank, horizontal|abort closes Chrome' apps/daemon/test/design-node-runtime-gate.test.ts apps/daemon/test/design-export-visual-gate.test.ts
pnpm typecheck
pnpm build:check
```

浏览器关闭失败分支也通过了以下无浏览器自检；旧实现会在这里失败：

```sh
node --experimental-strip-types --no-warnings --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { closeBrowser } from './apps/daemon/src/design/design-export-visual-gate.ts';
let killed;
await closeBrowser({ close: async () => { throw new Error('close failed'); }, process: () => ({ kill: signal => { killed = signal; } }) });
assert.equal(killed, 'SIGKILL');
NODE
```

## Chrome 与测试内容

全量 daemon 测试会并发启动真实 Chrome，加载短小页面来检查空白、溢出、脚本报错和导出一致性。测试入口此前忽略指定范围，现已支持 `pnpm test apps/web`，未知范围直接报错，不再意外运行全套。运行时审查复用已有浏览器查找和限时清理，修复 close 拒绝时被误判为关闭成功的问题。

当前启动代码使用 `headless: true`。它按 Puppeteer 的 [Headless modes](https://pptr.dev/guides/headless-modes) 使用现代 Chrome 无头模式；不能据此解释历史上可见窗口的具体来源。本轮未复现可见 Chrome 窗口或找到 `wwwww` 的确切来源，不声称已解决全部历史现象。

**Not verified：** Electron 原生窗口、VoiceOver、200% 系统文本缩放、大画布 FPS/内存压测；真实模型生成设计、沉淀简报和导出质量。没有扩大到这些未完成范围。

## Verdict

Approve：限本次已检视的端子与内嵌群聊交互，无遗留 HIGH 发现。测试范围与关闭清理已有证据；历史可见 Chrome/`wwwww` 来源仍未确认。

## 2026-09-06 复查：尺寸、端子与崩溃反馈

- 新建群聊默认尺寸改为 640×640；不迁移用户已调整过的节点。
- 端子此前被后绘制的节点表面遮住半边。修正层级，统一为 8px 圆点，空心输入、实心输出；保留 28px 命中区、键盘焦点和连线反馈。
- 应用内浏览器实测新建尺寸、拖动及右上、右下角缩放；连续缩小到 280×200 后立即拖动，草稿保留。也检查了 280×1937 的窄长群聊、45% 附近缩放和连续指针移动。原生 Electron 完成群聊定位和右上角缩放，未出现白屏或退出。
- 当时未复现崩溃，未将其标为修复。用户随后提供了错误堆栈，定位与修复记录见下节；此前操作成功不构成原问题已解决的证据。
- 端子在 29% 附近缩放时仍为 28px 命中区；拖拽与 Enter 各建立一条新连接，刷新后 9 条连接和新群聊 640×640 尺寸均保留，无页面错误。
- 相关现有测试 58 项、web TypeScript 检查和 Vite 构建通过。删除一条依赖旧 Prompt/Response 文案的源码字符串断言，保留消息布局和可访问性检查；没有新增测试或工具。
- 使用隔离数据和隐藏的应用内浏览器，未运行会启动 Chrome 的 daemon 测试。原生窗口中测试改变的节点几何与视口均已恢复。

## Maximum update depth：按用户堆栈修复

- 用户堆栈指向 `border-beam.js:3227`。对照本地 `border-beam@1.3.0` 编译源码，该行是在依赖 `size`、`children` 的 effect 中无条件设置新的 `{ x: 1, y: 1 }` 状态；默认 `md` 模式即执行，`active=false` 也不会跳过。群聊随几何变化重绘时会反复触发这次额外更新。
- 删除共用 `CanvasAgentPanel` 的 BorderBeam 装饰层、焦点状态、主题 MutationObserver 和 npm 依赖；主 Agent、节点 Agent、群聊都改用现有 composer shell 的 CSS `:focus-within` 边框与轮廓。reduced-motion 下关闭边框过渡，没有增加替代组件或更新循环。
- 扩展原有群聊主路径，验证调整尺寸后输入框保持同一实例、草稿保留且仍可发送。移除仅验证已删除动画参数的断言，保留焦点、布局和可访问性检查。相关三个测试文件共 117 项通过，web TypeScript 和 `pnpm build:check` 通过；总 JS gzip 864.7 KiB，预算 888.9 KiB。
- 原生 Electron 完成群聊缩放后拖动；隐藏的应用内浏览器连续拖拽与 Resize 各 100 次指针移动，草稿不变，无 React 错误。刷新后保存的 1217×1128 尺寸恢复，页面中无 BorderBeam 实例；测试后用户节点尺寸、位置、视口均恢复原值，隐藏检查页已关闭。
- 修复依据是用户堆栈与对应依赖源码；没有把修复前未复现描述为已成功复现。此处关闭该 BorderBeam 更新路径导致的崩溃反馈。
