<div align="center">

# CLI-JAW

### 你已有的 AI 订阅，一个助手搞定。

[![npm](https://img.shields.io/npm/v/cli-jaw)](https://npmjs.com/package/cli-jaw)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#-docker)

[English](README.md) / [한국어](README.ko.md) / **中文**

<video src="https://github.com/user-attachments/assets/a7cf17c9-bfb3-44f0-b7fd-d001a39643fd" autoplay loop muted playsinline width="100%"></video>

</div>

<table>
<tr><td><b>直接用你的订阅</b></td><td>Claude Max、ChatGPT Pro、Copilot、Gemini Advanced — OAuth 路由。通过 OpenCode 添加任意模型。无按量计费。</td></tr>
<tr><td><b>随处访问</b></td><td>Web PWA（虚拟滚动、WS 流）+ Mac WebView 应用 + 终端 TUI + Telegram（语音）+ Discord — 五个界面，一段对话。</td></tr>
<tr><td><b>三层记忆</b></td><td>History Block（近期会话）+ Memory Flush（事件、日志）+ Soul & Task Snapshot（身份、语义检索）。SQLite FTS5 全文搜索。</td></tr>
<tr><td><b>多智能体编排</b></td><td>PABCD — 数据库持久化的五阶段 FSM。Employee 系统和 Worker 注册表。文件冲突检测的并行执行。每个阶段都需用户批准。</td></tr>
<tr><td><b>浏览器与桌面自动化</b></td><td>Chrome CDP、vision-click、ChatGPT/Grok/Gemini DOM 参考、Codex App Computer Use 集成、diagram 技能生成 SVG 和交互式可视化。</td></tr>
<tr><td><b>MCP 一次安装，5 个引擎</b></td><td><code>jaw mcp install</code> 同时同步到 Claude、Codex、Gemini、OpenCode、Copilot。一个配置文件。</td></tr>
<tr><td><b>多语言支持</b></td><td>英语、韩语、中文 README。i18n Web UI。通过 OfficeCLI 支持韩语 HWP/HWPX 文档。</td></tr>
</table>

---

## 快速链接

- [安装](#-安装与运行) · [认证](#-认证) · [界面](#️-使用场景)
- [引擎路由](#-引擎路由) · [记忆](#-记忆) · [PABCD](#-编排--pabcd) · [技能](#-技能)
- [浏览器自动化](#-浏览器与桌面自动化) · [MCP](#-mcp) · [消息](#-消息)
- [CLI 命令](#️-cli-命令) · [Docker](#-docker) · [文档](#-文档) · [对比](#️-对比)

---

## 🚀 安装与运行

```bash
npm install -g cli-jaw
jaw serve
```

打开 **http://localhost:3457**。需要 Node.js 22+ 和至少一个 AI CLI 认证。

> `jaw service install` — 开机自启（自动检测 systemd、launchd 或 Docker）。

---

## 🔑 认证

只需一个。选择你已有的订阅：

```bash
# 免费
copilot login        # GitHub Copilot
opencode             # OpenCode — 提供免费模型

# 付费（月度订阅）
claude auth          # Anthropic Claude Max
codex login          # OpenAI ChatGPT Pro
gemini               # Google Gemini Advanced
```

检查状态：`jaw doctor`

---

## 🖥️ 使用场景

五个界面共享同一个助手、记忆和技能。

| 界面 | 功能 |
|---|---|
| **Web PWA** | markdown/KaTeX/Mermaid 渲染、虚拟滚动、WS 流、文件拖放、语音录制、PABCD 路线图、i18n、暗/亮主题、IndexedDB 离线缓存 |
| **Mac WebView 应用** | 将 `jaw serve` 包装为 macOS 应用。从 Dock 直接访问 |
| **终端 TUI** | 多行编辑、斜杠命令自动补全、选择器覆盖层、会话持久化 |
| **Telegram** | 语音消息（多 STT 提供商）、照片、文件。定时任务结果自动推送 |
| **Discord** | 文本/文件消息、命令同步、频道/线程路由、代理结果转发 |

---

## 🔀 引擎路由

通过你已经支付的 OAuth 月度订阅路由五个 CLI 后端。无按量计费。

| CLI | 默认模型 | 认证 | 费用 |
|---|---|---|---|
| **Claude** | `claude-sonnet-4-6` | `claude auth` | Claude Max 订阅 |
| **Codex** | `gpt-5.3-codex` | `codex login` | ChatGPT Pro 订阅 |
| **Gemini** | `gemini-2.5-pro` | `gemini` | Gemini Advanced 订阅 |
| **OpenCode** | `claude-opus-4-6-thinking` | `opencode` | 提供免费模型 |
| **Copilot** | `gpt-4.1` | `copilot login` | 提供免费套餐 |

**回退链**：一个引擎受限或宕机时，下一个自动接管。用 `/fallback [cli1 cli2...]` 配置。

**OpenCode 通配符**：连接任意模型端点 — OpenRouter、本地 LLM 或任何 OpenAI 兼容 API。

---

## 🧠 记忆

三层结构，各负责不同的回忆范围。

| 层 | 存储内容 | 工作方式 |
|---|---|---|
| **History Block** | 近期会话上下文 | 最近 10 个会话，最多 8000 字符，按工作目录限定。注入到提示词开头 |
| **Memory Flush** | 从对话中提取的结构化知识 | 达到阈值（默认 10 轮）后触发。总结为事件、日志（`YYYY-MM-DD.md`）、实时笔记 |
| **Soul + Task Snapshot** | 身份与语义检索 | `soul.md` 定义核心价值/语气/边界。FTS5 索引每次提示最多检索 4 条相关结果（各 700 字符） |

三层全部自动注入系统提示词。搜索：`jaw memory search <query>` 或 `/memory <query>`。

---

## 🎭 编排 — PABCD

复杂任务使用五阶段状态机。每次转换都需要你的批准。

```
P (Plan) → A (Audit) → B (Build) → C (Check) → D (Done) → IDLE
   ⛔         ⛔          ⛔         自动        自动
```

| 阶段 | 动作 |
|---|---|
| **P** | Boss AI 编写 diff 级别的计划。等待你的审查 |
| **A** | 只读 Worker 验证计划的可行性 |
| **B** | Boss 实施。只读 Worker 验证结果 |
| **C** | 类型检查、文档更新、一致性检查 |
| **D** | 总结所有变更。回到空闲状态 |

状态持久化在数据库中，服务器重启后保持。Worker 不能修改文件。用 `jaw orchestrate` 或 `/pabcd` 激活。

---

## 📦 技能

100 多个技能，按用途分类。

| 类别 | 技能 | 覆盖范围 |
|---|---|---|
| **办公** | `pdf`, `docx`, `xlsx`, `pptx`, `hwp` | 文档读取/创建/编辑。通过 OfficeCLI 支持韩语 HWP/HWPX |
| **自动化** | `browser`, `vision-click`, `screen-capture`, `desktop-control` | Chrome CDP、AI 坐标点击、macOS 截屏/摄像头、Computer Use |
| **媒体** | `video`, `imagegen`, `lecture-stt`, `tts` | Remotion 视频、OpenAI 图像生成、讲座转录、语音合成 |
| **集成** | `github`, `notion`, `telegram-send`, `memory` | Issues/PR/CI、Notion 页面、Telegram 媒体、持久记忆 |
| **可视化** | `diagram` | 在聊天中渲染 SVG 图表和交互式可视化 |
| **开发指南** | `dev`, `dev-frontend`, `dev-backend`, `dev-data`, `dev-testing`, `dev-pabcd` | 注入子代理提示词的开发规范 |

22 个活跃技能（始终注入）。94 个以上参考技能（按需加载）。

---

## 🌐 浏览器与桌面自动化

| 功能 | 工作方式 |
|---|---|
| **Chrome CDP** | 导航、点击、输入、截屏、执行 JS、滚动、聚焦、按键 — DevTools Protocol 10 个操作 |
| **Vision-click** | 截屏 → AI 提取坐标 → 点击。`jaw browser vision-click "登录按钮"` |
| **DOM 参考** | ChatGPT、Grok、Gemini Web UI 的选择器映射 |
| **Computer Use** | 通过 Codex App Computer Use MCP 自动化桌面应用 |
| **Diagram 技能** | 生成 SVG 图表和交互式 HTML 可视化，在沙盒 iframe 中渲染 |

---

## 🔌 MCP

[Model Context Protocol](https://modelcontextprotocol.io) 让 AI 代理使用外部工具。CLI-JAW 用一个文件管理五个引擎的 MCP 配置。

```bash
jaw mcp install @anthropic/context7
# → 同时同步到 Claude、Codex、Gemini、OpenCode、Copilot 配置文件
```

---

## 💬 消息

### Telegram

三步设置：BotFather 创建机器人 → `jaw init --telegram-token` → 发送消息。

文字聊天、语音消息（自动 STT）、文件/图片上传、斜杠命令、定时任务结果推送。

### Discord

与 Telegram 相同 — 文字、文件、命令。频道/线程路由，代理结果转发。在 Web UI 设置中配置。

### 语音 & STT

Web（麦克风按钮）、Telegram（语音消息）、Discord 均可使用。支持 OpenAI 兼容、Google Vertex AI 或自定义端点。

---

## ⏰ 调度

| 功能 | 说明 |
|---|---|
| **Heartbeat 任务** | Cron 定时任务无人值守运行。结果推送到 Telegram/Discord |
| **服务自启** | `jaw service install` — 自动检测 systemd、launchd、Docker |

---

## ⌨️ CLI 命令

```bash
jaw serve                         # 启动服务器
jaw chat                          # 终端 TUI
jaw doctor                        # 12 项诊断
jaw service install               # 开机自启
jaw skill install <name>          # 激活技能
jaw mcp install <package>         # 安装 MCP → 同步到 5 个引擎
jaw memory search <query>         # 搜索记忆
jaw browser start                 # 启动 Chrome (CDP)
jaw browser vision-click "登录"   # AI 坐标点击
jaw clone ~/project               # 克隆实例
jaw orchestrate                   # 进入 PABCD
jaw reset                         # 全部重置
```

---

## 🐳 Docker

```bash
docker compose up -d       # → http://localhost:3457
```

非 root `jaw` 用户，Chromium 沙盒默认启用。提供 `Dockerfile`（npm 安装）和 `Dockerfile.dev`（本地源码）。

---

## 📖 文档

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 发布日志（v1.6.0 补记：v1.2.0 至 v1.5.1） |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统设计、模块图、95 个 API 处理器 |
| [TESTS.md](TESTS.md) | 测试覆盖率、计数、计划 |
| [memory-architecture.md](docs/memory-architecture.md) | 三层记忆模型、索引、运行时行为 |
| [devlog/structure/](devlog/structure/) | 内部架构参考 |

---

## ⚖️ 对比

| | CLI-JAW | Hermes Agent | Claude Code |
|---|---|---|---|
| **模型接入** | OAuth 月费 + OpenCode 通配符 | API 密钥 (OpenRouter 200+) | 仅 Anthropic |
| **费用** | 现有月费 | 按量计费 | Anthropic 订阅 |
| **主界面** | Web PWA + Mac 应用 + TUI | 仅 TUI | CLI + IDE 插件 |
| **消息** | Telegram（语音）+ Discord | TG/Discord/Slack/WhatsApp/Signal | 无 |
| **记忆** | 三层 + FTS5 | 自学习循环 + Honcho | 文件记忆 |
| **浏览器** | CDP + vision-click + DOM ref | 有限 | 通过 MCP |
| **编排** | PABCD 五阶段 FSM | 子代理生成 | Task 工具 |

CLI-JAW 继承了 OpenClaw 架构（混合搜索管理器、回退模式、会话索引）。

---

## 🏗️ 多实例

运行独立实例，拥有各自的设置、记忆和数据库。

```bash
jaw clone ~/my-project
jaw --home ~/my-project serve --port 3458
```

---

## 🛠️ 开发

<details>
<summary>构建与项目结构</summary>

```bash
npm run build          # tsc → dist/
npm run dev            # tsx server.ts（热重载）
```

```
src/
├── agent/          # AI 代理生命周期、生成、History Block
├── browser/        # Chrome CDP、vision-click
├── cli/            # CLI 注册表、斜杠命令、模型预设
├── core/           # 数据库、配置、Employee、日志
├── discord/        # Discord 机器人、命令、文件发送
├── memory/         # 三层记忆、FTS5 索引、Flush、Soul
├── orchestrator/   # PABCD 状态机、Worker 注册表
├── routes/         # REST API（95 个处理器，94 个端点）
├── security/       # 输入验证、路径保护
└── telegram/       # Telegram 机器人、语音 STT、转发器
```

</details>

---

## 🧪 测试

```bash
npm test             # tsx --test（Node.js 原生测试运行器）
```

参见 [TESTS.md](TESTS.md) 了解当前库存和通过数。

---

## ❓ 故障排查

<details>
<summary>常见问题</summary>

| 问题 | 解决方案 |
|---|---|
| `cli-jaw: command not found` | 重新运行 `npm install -g cli-jaw`。检查 `npm bin -g` 是否在 `$PATH` 中 |
| `Error: node version` | 升级到 Node.js 22+：`nvm install 22` |
| `NODE_MODULE_VERSION` 不匹配 | `npm run ensure:native`（自动重建） |
| 代理超时 | `jaw doctor` 检查 CLI 认证 |
| `EADDRINUSE: port 3457` | 另一个实例正在运行。使用 `--port 3458` |
| Telegram 无响应 | `jaw doctor` 检查令牌。确保 `jaw serve` 正在运行 |
| 技能未加载 | `jaw skill reset` 然后 `jaw mcp sync` |
| 浏览器命令失败 | 安装 Chrome。先运行 `jaw browser start` |

</details>

---

## 🤝 参与贡献

1. 从 `master` Fork 并创建分支
2. `npm run build && npm test`
3. 提交 PR

发现 Bug 或有想法？[提交 Issue](https://github.com/lidge-jun/cli-jaw/issues)

---

<div align="center">

**[MIT License](LICENSE)**

</div>
