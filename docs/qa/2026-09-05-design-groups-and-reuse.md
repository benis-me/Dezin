# Design Canvas：群聊、复用与界面验收

范围：本轮新增的群聊节点、生成/保存简报入口、设计变体，以及首页和 Quick Start 文案。React 19、React Flow、现有语义颜色与动效规范；遵循仓库 AGENTS.md 的最小改动原则。参考 Babel 的房间目标、成员上下文、独立对话与产物交接，继续使用 Dezin 现有主 Agent、节点 Agent、版本和任务账本。

目标：群聊保留讨论并派发节点生成；设计稿可保存、关联和继续变化；内置设计审查指引；修复本轮遇到的交互问题并减少重复扫描。非目标：重写渲染器或 Agent 框架、完整复刻 Babel、替换用户的模型配置、宣称所有设计类型已经完成质量验收。

## 内置指引

使用 [Jakub Krehel skills](https://github.com/jakubkrehel/skills) 的 better-interface 及 accessibility、layout、writing、typography、colors、ui 六个领域指引。原文、引用文档与 MIT 许可证保存在 `content/design-skills/jakubkrehel/`，固定修订 `267330e1adfc66a718fb65fa6918c1f06d0a689e`。

主 Agent、节点生成和实现导出获得这些指引；任务内文件只读，并纳入既有 checksum 校验。导入的画布内容仍是非可信参考资料，指引不能扩展工具或输出权限。测试证明文件交付与校验链正常；真实模型的使用效果仍待验收。

## 审查覆盖

| 领域 | 检视证据 | 结果 |
| --- | --- | --- |
| Accessibility | 群聊和变体的 AX 名称、Tab 焦点、24px 快捷按钮；320px 窗口的输入框与关闭按钮 | 已检查；键盘焦点可见、操作可达 |
| Layout | 浅色/深色 1280px；320px 非聚焦浮层；变体与同排节点的边界矩形 | 修复浮层消失、变体尺寸改变与重叠 |
| Writing | 首页、Quick Start、群聊空状态、运行和失败摘要、生成/保存简报操作 | 操作和结果更明确，卡片不再铺满底层诊断 |
| Typography | 群聊正文 13px/19.5px 行高；长内容和成员名称 | 三行摘要正常，全文在对话中可读 |
| Colors | 读取实际计算颜色；深色卡片正文/背景及次级正文 | 对比度分别 15.97:1、6.66:1；浅色次级正文5.04:1 |
| UI | 右键创建变体、撤销、重新创建、页面刷新、关联成员、生成快捷提示与原输入并存 | 已验证上述交互；真实生成见未验证项 |

## 已修复的发现

| 严重性 | 领域 | 位置 | Before | After | 原因 |
| --- | --- | --- | --- | --- | --- |
| HIGH | Layout | `apps/web/src/design-canvas/FloatingNodeAgent.tsx:224` | 窗口缩小时屏外节点导致已打开浮层卸载，未发送输入丢失 | 保留浮层，复用现有窄窗口底部布局 | 用户正在编辑的内容不能因窗口变化丢失 |
| MEDIUM | UI | `apps/web/src/design-canvas/FloatingNodeAgent.tsx:678` | 快捷操作替换已输入文字 | 在现有草稿后追加操作意图 | 保留用户输入 |
| MEDIUM | Layout | `apps/web/src/design-canvas/DesignCanvasScreen.tsx:684` | 变体采用默认尺寸，并可能压住同排设计 | 沿用原稿尺寸；有冲突时排到该行空位 | 支持比较和继续编辑 |
| MEDIUM | UI | `apps/web/src/design-canvas/DesignCanvasScreen.tsx:1420` | 变体引用只存在于首次打开面板的状态 | 从持久化 Context 连线恢复引用 | 重开后仍能找到原稿 |
| MEDIUM | Typography | `apps/web/src/design-canvas/design-canvas.css:1660` | 弹性高度破坏回复的三行截断 | 摘要自然高度，底部按钮自动留白 | 长内容不挤占卡片 |
| LOW | Layout | `apps/web/src/design-canvas/design-canvas.css:1459` | Quick Start 奇数项留下半行空白 | 最后一项占满该行 | 修复入口排列 |

## 验证

通过：

- 后端现有主 Agent、节点生成、存储、HTTP 测试：185 项；实现导出与运行时审查消息测试：48 项。
- 前端 Canvas screen、Agent controller、Agent panel model：86 项；画布契约：2 项。
- 新增仅两个回归：群聊讨论→派发→版本保存→同请求重放；群聊任务不混入主会话，同时保留既有孤立任务历史。没有新增测试框架。
- `pnpm typecheck`、`pnpm build:check`、`git diff --check`。
- 隔离数据目录 `/tmp/dezin-iteration-20260905/data`，UI 地址 `http://127.0.0.1:5176`。真实浏览器完成浅/深色、320px、键盘焦点、取消、刷新后对话保留、关联节点显示、变体和撤销检查。
- 非聚焦原节点移到窗口外时，320px 窗口中的浮层仍有 304px 宽，输入文本保留。
- 三个明确标注为手动预览样稿的 HTML 版本，重开后仍有原始版本；40% 缩放仍显示三个设计预览。样稿只用于预览、尺寸、存储和交互验收。
- 最终性能改动：群聊成员关系一次遍历建立索引，节点几何同步使用 Map；浮层定位用原生单节点选择器，移除每次构建全部 DOM 节点数组的步骤。没有宣称整体 FPS 或内存的量化提升。

主要复跑命令：

```sh
pnpm typecheck
pnpm build:check
pnpm --filter @dezin/design-canvas-contracts test
pnpm --filter @dezin/web test src/design-canvas/DesignCanvasScreen.test.tsx src/design-canvas/useCanvasAgentPanelController.test.tsx src/design-canvas/agent-panel-model.test.ts
cd apps/daemon
node --experimental-strip-types --experimental-sqlite --no-warnings --import ./test/no-proxy.ts --test test/design-global-agents.test.ts test/design-node-agent.test.ts test/design-storage.test.ts test/design-http.test.ts test/design-implementation-export.test.ts test/design-node-runtime-gate-messages.test.ts
```

**Not verified：**

- 真实模型完成设计、保存简报、再次生成和视觉质量提升。已尝试 CodeBuddy（额度耗尽）、Claude CLI（未登录）、Codex（默认模型/推理配置不兼容；改用匹配配置的模型后出现 TLS 与连接失败）。没有真实生成成功的结论。
- 本轮未进行 Electron 原生窗口验收、VoiceOver、系统级 200% 文本缩放或大规模 FPS 压测。新界面复用现有 reduced-motion 行为；没有单独声称完成系统偏好切换验收。

## Verdict

Approve：限上述已检视的界面范围，没有遗留 HIGH 界面问题。真实生成闭环仍待可用 Agent 配置，不能据此签收模型输出质量或整个项目的全部需求。
