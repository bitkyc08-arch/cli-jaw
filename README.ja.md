<div align="center">

# CLI-JAW

### あなた専用の AI エージェント。2 行でインストール。11 個の AI ランタイムをひとつのダッシュボードに。

[![npm](https://img.shields.io/npm/v/cli-jaw)](https://npmjs.com/package/cli-jaw)
[![Version](https://img.shields.io/badge/v2.0.0-GA-brightgreen)](https://github.com/lidge-jun/cli-jaw/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#docker)

[English](README.md) / [한국어](README.ko.md) / [中文](README.zh-CN.md) / **日本語**

</div>

## インストール

<details>
<summary><b>セーフインストール</b> — 既存ユーザー向け、最小限の変更</summary>

```bash
# macOS / Linux
JAW_SAFE=1 npm install -g cli-jaw    # skips optional tool/runtime setup
jaw init                              # 準備ができたら対話型セットアップ
```

Windows ユーザーは下の WSL インストール手順を使ってください。ネイティブ PowerShell は CLI-JAW のサポート対象インストール先ではありません。

</details>

```bash
# macOS / Linux / WSL、Node.js 22+ が既にある場合
npm install -g cli-jaw
jaw dashboard
```

これで完了です。**http://localhost:3457** を開けば、あなた専用の AI エージェントが使えます。[Node.js 22+](https://nodejs.org) が必要です。

> **初めてですか？** デフォルトの npm インストールは CLI-JAW の初期化とネイティブ Claude のセットアップを試みます。他の AI CLI は任意です。macOS/Linux で npm インストール時にすべて入れる場合は `CLI_JAW_INSTALL_CLI_TOOLS=1 npm install -g cli-jaw` を使ってください。Windows では下の WSL インストール手順を使ってください。

<details>
<summary><b>macOS ワンクリック</b> — Node.js がない場合はこちら</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/main/scripts/install.sh | bash
source "${ZDOTDIR:-$HOME}/.zshrc" 2>/dev/null || true
bash "$(npm root -g)/cli-jaw/scripts/verify-fresh-install.sh"
```

</details>

<details>
<summary><b>Windows（WSL — Windows Subsystem for Linux）</b> — ゼロからワンクリック</summary>

```powershell
# 1. WSL をインストール（管理者権限の PowerShell）
wsl --install
```

再起動後、**Ubuntu** を開いて：

```bash
# 2. CLI-JAW + 全依存関係をインストール
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/main/scripts/install-wsl.sh | bash
source ~/.bashrc
jaw dashboard
bash "$(npm root -g)/cli-jaw/scripts/verify-fresh-install.sh"
```

Windows PowerShell から WSL 内のコマンドを実行する場合は、WSL profile PATH が読み込まれるよう login shell 経由にしてください:

```powershell
wsl.exe -d Ubuntu -- bash -lc "jaw dashboard"
```

</details>

<details>
<summary><b>Docker</b></summary>

```bash
docker compose up -d       # → http://localhost:3457
```

</details>

---

## CLI-JAW とは

CLI-JAW は、すでに使っている AI コーディング CLI — Pi、Antigravity、AI-E、Claude、Claude E、Codex、Codex App、Cursor、Gemini、Grok、Kiro、OpenCode、Copilot — を**ひとつのアシスタント、ひとつのメモリ、ひとつのダッシュボード**に統合するオープンソースプラットフォームです。

メイン CLI（Boss）が他の CLI を「Employee（従業員）」として呼び出します。アプリを切り替える必要はなく、ひとつの場所から指示できます。

- **API キー不要** — すでに契約中のサブスクリプションで動作
- **トークン課金なし** — 既存の月額料金のまま
- **ローカル実行** — コードがマシンの外に出ることはありません

<div align="center">

![CLI-JAW Manager Dashboard](docs/screenshots/manager-dashboard-light.png)

</div>

---

## 認証

ひとつあれば十分です。すでに契約しているサービスを選んでください：

```bash
# 無料オプション（クレジットカード不要）
copilot login        # GitHub Copilot（無料枠あり）
opencode             # OpenCode — 無料モデルあり

# 有料（すでに支払い中の月額サブスクリプション）
claude auth login    # Anthropic Claude Pro 以上
codex login          # OpenAI ChatGPT Pro 以上
cursor-agent login   # Cursor
gemini               # Google Gemini Advanced
grok login --oauth   # xAI Grok / Grok Heavy
```

一括チェック：`jaw doctor`

<details>
<summary>jaw doctor の出力例</summary>

```
🦈 CLI-JAW Doctor — 13 checks

 ✅ Node.js        v22.15.0
 ✅ Claude CLI      installed
 ✅ Codex CLI       installed
 ✅ Cursor CLI      installed
 ⚠️ Gemini CLI      not found (optional)
 ✅ OpenCode CLI    installed
 ✅ Copilot CLI     installed
 ✅ Database        jaw.db OK
 ✅ Skills          32 active, 194 reference
 ✅ MCP（プラグイン）  3 servers configured
 ✅ Memory          structured/ exists
 ✅ Server          port 3457 available
```

</details>

---

## ダッシュボード

ダッシュボードは `http://localhost:3457` で動作するローカル Web アプリのコマンドセンターです。

### インスタンスマネージャー

実行中のすべての AI インスタンスを一覧表示。ワンクリックで起動・停止・再起動。ダッシュボード内でライブ Web UI をプレビューできます。

<div align="center">

![Dashboard Navigator](docs/screenshots/dashboard-navigator.png)

</div>

### カンバンボード

インスタンスカードをレーン（Backlog → Ready → In Progress → Review → Done）にドラッグ。各 AI セッションが何に取り組んでいるかを追跡します。

<div align="center">

![カンバンボード](docs/screenshots/dashboard-kanban.png)

</div>

### 優先度マトリックス

アイゼンハワーマトリックスでタスクとリマインダーを整理。重要なものから処理しましょう。

<div align="center">

![優先度マトリックス](docs/screenshots/priority-matrix.png)

</div>

### ノート

ダッシュボード内のミニ Obsidian。フォルダ、ビジュアル（WYSIWYG）+ ソース + 分割編集、KaTeX（数式レンダリング）、Mermaid（コードとしての図表）、シンタックスハイライト付きコードブロック。

<div align="center">

![ノートエディタ](docs/screenshots/notes-wysiwyg.png)

</div>

### エージェントステータス

各 AI エンジンの稼働状況と使用量をひと目で確認。

<div align="center">

![Claude ステータス](docs/screenshots/claude-status-widget.png)

</div>

---

## Employee システムの仕組み

コアアイデア：**メインの CLI が他の CLI をワーカーとして呼び出します。**

ひとつの AI（Boss）に話しかけます。専門作業が必要なときは Employee にタスクを分配します — 各 Employee は独自の CLI と独自のモデルで動作します：

```
あなた："フロントエンドのスタイルを直して、API エンドポイントも更新して"

Boss（Claude）が判断中...
  ├── Frontend Employee（OpenCode）にディスパッチ → "dashboard.tsx の CSS グリッドレイアウトを修正"
  ├── Backend Employee（Codex）にディスパッチ     → "/api/users でページネーションメタデータを返すよう更新"
  └── 両方の結果を統合して報告
```

```bash
# 内部的にはこのコマンドひとつ：
jaw dispatch --agent "Frontend" --task "dashboard.tsx の CSS グリッドレイアウトを修正"
```

Employee は設定に登録された他の AI CLI です。それぞれ独自のセッション、モデル、コンテキストを持ちます。Boss が出力をレビューしてからユーザーに提示します。

### Employee vs サブエージェント

これらは別のものです：

| | Employee | サブエージェント |
|---|---|---|
| **概要** | ワーカーとして設定された他の AI CLI（Codex、OpenCode 等） | 単一 CLI 内の並列タスクツール |
| **用途** | 異なるコードベースやドメインにまたがるマルチスペシャリスト | 内部リサーチ、ファイル読み取り、並列分析 |
| **使い方** | `jaw dispatch --agent "Name" --task "..."` | 自動 — CLI が内部的に生成 |

Employee は「Frontend は CSS、Backend は API」用。サブエージェントは「判断する前に 5 ファイルを並列で読む」用。

---

## AI ランタイム

トークン単位の API 課金なし。すでに契約中のサブスクリプションで動作します。

| CLI | デフォルトモデル | 認証 | コスト |
|---|---|---|---|
| **Pi** | `grok-composer-2.5-fast` | Settings profile API key、local proxy、または `PI_CODING_AGENT_BIN` | isolated `PI_CODING_AGENT_DIR` で local/API endpoint を接続する first-class `pi --mode rpc` runtime |
| **Claude** | `claude-opus-4-8` | `claude auth login` | Claude Pro サブスクリプション以上 |
| **Claude E** | `claude-opus-4-8` | underlying `claude auth login` | Claude Pro サブスクリプション以上。6月のサブスク付与枠では推奨 runtime |
| **AI-E** | provider-selected | 選択 provider の認証 | マルチ provider runtime wrapper |
| **Antigravity** | AGY-selected | `agy` 実行時に確認 | `--conversation` resume 対応の実験的な AGY print-mode runtime。モデル変更は native AGY UI 側 |
| **Codex** | `gpt-5.5` | `codex login` | ChatGPT Pro サブスクリプション以上 |
| **Codex App** | `gpt-5.5` | `codex login` | ChatGPT Pro サブスクリプション以上 |
| **Cursor** | `composer-2.5-fast` | `cursor-agent login` または `CURSOR_API_KEY` | Cursor サブスクリプション。quota は auth/status-only |
| **Gemini** | `gemini-3.1-pro-preview` | `gemini` | Gemini Advanced サブスクリプション |
| **Grok** | `grok-build` | `grok login --oauth` | Grok サブスクリプション；クォータは認証/ステータスのみ |
| **OpenCode** | `minimax-m2.7` | `opencode` | 無料モデルあり |
| **Copilot** | `gpt-5-mini` | `copilot login` | 無料枠あり |

GPT 5.5 と Claude Opus 4.8 は Pro 以上のサブスクリプションで利用できます。6月からサブスクに含まれる Claude 利用枠を使う場合は、`claude-e` runtime を選択してください。

クォータ/ステータスパネルは registry と同じ runtime キーセットを維持します。Wrapper runtime（`ai-e`, `claude-e`, `codex-app`）は underlying provider に委譲し、Pi/AGY/Cursor/Grok/OpenCode のように CLI が quota window を公開しない場合は auth/status-only として表示します。

**フォールバックチェーン**：あるエンジンがレートリミットされると、次のエンジンが自動で引き継ぎます。`/fallback [cli1 cli2...]` で設定。

**OpenCode ワイルドカード**：OpenRouter、ローカル LLM（大規模言語モデル）、OpenAI 互換 API など任意のモデルエンドポイントに接続可能。

> エンジン切り替え：`/cli codex`。モデル切り替え：`/model gpt-5.5`。Web、ターミナル、Telegram、Discord のどこからでも可能。

---

## PABCD オーケストレーション（Plan → Audit → Build → Check → Done）

複雑なタスクに対して、CLI-JAW は構造化された 5 段階ワークフローを使用します。すべての遷移にユーザーの承認が必要です — 確認なしでは何も進みません。

```
P (Plan) → A (Audit) → B (Build) → C (Check) → D (Done) → IDLE
   ⛔         ⛔          ⛔         auto        auto
```

| フェーズ | 内容 |
|---|---|
| **P — Plan** | Boss AI が diff レベルの計画を作成。レビューのために停止 |
| **A — Audit** | 読み取り専用ワーカーが計画の実行可能性を検証（import の存在、シグネチャの一致） |
| **B — Build** | Boss が実装。読み取り専用ワーカーが結果を検証 |
| **C — Check** | 型チェック（`tsc --noEmit`）、ドキュメント更新、整合性チェック |
| **D — Done** | 全変更のサマリー。アイドル状態に復帰 |

状態はデータベースに永続化され、再起動後も保持されます。ワーカーはファイルを変更できません — 検証のみ。`jaw orchestrate`、`/orchestrate`、`/pabcd` で開始。

---

## メモリ

3 つの層がそれぞれ異なるリコール範囲をカバーします。

| 層 | 保存内容 | 動作方式 |
|---|---|---|
| **History Block** | 直近のセッションコンテキスト | 直近 10 セッション、最大 8,000 文字、作業ディレクトリごとにスコープ。プロンプト先頭に注入 |
| **Memory Flush** | 会話から抽出した構造化ナレッジ | 一定ターン（デフォルト 10）後にトリガー。エピソード、日次ログ、セマンティックノートを Markdown で抽出 |
| **Soul + Task Snapshot** | アイデンティティとセマンティック検索 | 核心的な価値観、トーン、境界を定義。全文検索インデックスがプロンプトごとに最大 4 件のセマンティック関連結果を返す |

3 層すべてがシステムプロンプトに自動注入されます。メモリの検索：

```bash
jaw memory search "API の認証はどう設定した？"
```

---

## スキル

230 以上のスキルが開発ワークフロー、オフィスドキュメント、自動化、メディア、コンテンツ作成をカバーします。

| カテゴリ | スキル | 対応範囲 |
|---|---|---|
| **オフィス** | `pdf`, `docx`, `xlsx`, `pptx`, `hwp` | ドキュメントの読み取り・作成・編集。HWP/HWPX（韓国語ワープロ形式）をネイティブサポート |
| **自動化** | `browser`, `vision-click`, `screen-capture`, `desktop-control` | Chrome DevTools Protocol（CDP）ブラウザ制御、AI 座標クリック、macOS スクリーンショット、Computer Use |
| **メディア** | `video`, `imagegen`, `lecture-stt`, `tts` | Remotion 動画、OpenAI 画像生成、講義の文字起こし、テキスト読み上げ |
| **連携** | `github`, `notion`, `telegram-send`, `memory` | Issues/PRs/CI、Notion ページ、Telegram メディア配信、永続メモリ |
| **ビジュアライゼーション** | `diagram` | チャット内で SVG ダイアグラム、チャート、インタラクティブ図をレンダリング |
| **コンテンツ/ライティング** | `k-writing` | 韓国語のプロモーション/コンテンツ作成: スレッド、Instagram カードニュース、LinkedIn、Web/ブログ、推敲を、必須検索・フック採点・AI っぽさ除去チェック付きで生成 |
| **開発ガイド** | `dev`, `dev-frontend`, `dev-backend`, `dev-data`, `dev-testing`, `dev-pabcd` | エージェントプロンプトに注入されるエンジニアリングガイドライン |

リファレンススキルは `skills_ref/` にあり、オンデマンドでアクティブランタイムにインストールされます。

```bash
jaw skill install <name>    # リファレンススキルをアクティブ化
jaw skill list              # 利用可能なスキルを表示
```

---

## ブラウザ & デスクトップ自動化

| 機能 | 動作方式 |
|---|---|
| **Chrome DevTools Protocol** | ナビゲーション、クリック、入力、スクリーンショット、JS 実行、スクロール、キー入力 — Chrome のリモートコントロール |
| **Vision-click** | 画面をスクリーンショット → AI がターゲット座標を抽出 → クリック。`jaw browser vision-click "Login button"` |
| **Computer Use** | Codex Computer Use によるデスクトップアプリ自動化。Safari で localhost にアクセスすれば Codex アプリのように動作 |
| **Web-AI ベンダー** | `jaw browser web-ai --vendor chatgpt\|gemini\|grok` — セッションライフサイクル、診断、ソース監査、ChatGPT code-mode zip 回収サポート |
| **Diagram スキル** | SVG ダイアグラムとインタラクティブなビジュアライゼーションを生成し、チャット内にインラインレンダリング |

Computer Use で Finder、Safari、システム設定、Xcode など、あらゆる macOS アプリを自然言語で操作できます。

---

## メッセージング

### Telegram

```
📱 Telegram ←→ 🦈 CLI-JAW ←→ 🤖 AI Engines
```

テキストチャット、音声メッセージ（マルチプロバイダ STT — 音声をテキストに自動変換）、ファイル/写真アップロード、スラッシュコマンド（`/cli`、`/model`、`/status`）、スケジュールタスク（`every`/`cron` — 定期スケジュール）結果の自動配信。

<details>
<summary>セットアップ（3 ステップ）</summary>

1. [@BotFather](https://t.me/BotFather) にメッセージ → `/newbot` → トークンをコピー
2. `jaw init --telegram-token YOUR_TOKEN` または Web UI 設定から
3. Bot に何かメッセージを送信。Chat ID は初回メッセージ時に自動保存

</details>

### Discord

Telegram と同等の機能 — テキスト、ファイル、コマンド。チャンネル/スレッドルーティング、正規 `/api/channel/send`、エージェント結果ブロードキャストフォワーダー。Web UI 設定で構成。

### 音声 & STT

音声入力は Web（マイクボタン）、Telegram（音声メッセージ）、Discord で動作します。プロバイダ：OpenAI 互換、Google Vertex AI、任意のカスタムエンドポイント。

---

## MCP（Model Context Protocol）

[MCP](https://modelcontextprotocol.io) は AI ツールが機能を共有するための標準です — AI エージェント向けのプラグインのようなものです。CLI-JAW はすべてのエンジンの MCP 設定を 1 ファイルで管理します。

```bash
jaw mcp install @anthropic/context7
# → Claude、Codex、Gemini、OpenCode、Copilot、Antigravity の設定ファイルに同期
```

複数の JSON ファイルを個別に編集する必要はありません。一度インストールすれば MCP 対応エンジンすべてに反映されます。Grok CLI は標準ランタイムですが、Grok 側に互換 MCP 設定面が確認されるまで MCP 同期対象とは表記しません。Antigravity MCP sync は `agy` runtime registry entry とは別の config target です。

```bash
jaw mcp sync       # 手動編集後の再同期
```

---

## CLI コマンド

```bash
# コア
jaw dashboard                     # マネージャーダッシュボードを起動
jaw serve                         # サーバー起動（http://localhost:3457）
jaw chat                          # ターミナルチャット UI
jaw doctor                        # 12 項目の診断

# インスタンス
jaw clone ~/project               # 新しいディレクトリにインスタンスを複製
jaw --home ~/project serve --port 3458  # 2 つ目のインスタンスを起動
jaw service install               # OS 起動時の自動スタート

# AI & オーケストレーション
jaw dispatch --agent "Backend" --task "..."  # Employee をディスパッチ
jaw orchestrate                   # PABCD ワークフローの開始/制御

# スキル & MCP
jaw skill install <name>          # スキルをアクティブ化
jaw skill list                    # 利用可能なスキルを表示
jaw mcp install <package>         # MCP をインストール → MCP 対応エンジンに同期
jaw mcp sync                      # MCP 設定の再同期

# メモリ
jaw memory search <query>         # 全メモリ層を横断検索
jaw memory save <file> <content>  # 構造化メモリに保存

# ブラウザ
jaw browser start                 # Chrome 自動化を起動
jaw browser fetch "https://example.com" --json --trace  # 適応型 URL リーダー
jaw browser snapshot              # ページ状態をキャプチャ
jaw browser vision-click "Login"  # AI ベースのクリック

# メンテナンス
jaw reset                         # フルリセット
```

---

## マルチインスタンス

設定、メモリ、データベースがそれぞれ独立した分離インスタンスを実行：

```bash
jaw clone ~/my-project
jaw --home ~/my-project serve --port 3458
```

各インスタンスは完全に独立 — 作業ディレクトリ、メモリ、MCP 設定すべて別々。マネージャーダッシュボードからすべて確認できます。

---

## 開発

```bash
npm run build          # tsc → dist/
npm run dev            # tsx server.ts（ホットリロード）
npm test               # Node.js ネイティブテストランナー
npm run gate:all       # リリース/ドキュメント整合性ゲート
```

アーキテクチャ詳細：[ARCHITECTURE.md](docs/ARCHITECTURE.md) · テストカバレッジ：[TESTS.md](TESTS.md) · 内部構造ドキュメント：[structure/](structure/)

---

## 比較

| | CLI-JAW 2.0 | Hermes Agent | Claude Code |
|---|---|---|---|
| **モデルアクセス** | Pi、Antigravity、AI-E、Claude、Claude E、Codex、Codex App、Cursor、Gemini、Grok、Kiro、OpenCode、Copilot — ベンダー/ネイティブ認証経由 | API キー（OpenRouter 200+、Nous Portal） | Anthropic のみ |
| **コストモデル** | 契約済みの月額サブスクリプション | トークン単位の API 課金 | Anthropic サブスクリプション |
| **メイン UI** | マネージャーダッシュボード + Web アプリ + Mac アプリ + ターミナル UI | ターミナルのみ | CLI + IDE プラグイン |
| **ダッシュボード** | マルチインスタンスマネージャー、カンバン、ノートワークスペース | なし | なし |
| **メッセージング** | Telegram（音声）+ Discord | Telegram/Discord/Slack/WhatsApp/Signal | なし |
| **メモリ** | 3 層（History/Flush/Soul）+ 全文検索 | Self-improving loop + Honcho | ファイルベース自動メモリ |
| **マルチエージェント** | Employee システム（他 CLI のディスパッチ）+ PABCD | サブエージェント生成 | Task ツール |
| **ブラウザ自動化** | Chrome DevTools + vision-click + Computer Use | 限定的 | MCP 経由 |
| **実行環境** | ローカル + Docker | ローカル/Docker/SSH/Daytona/Modal | ローカル |
| **スキル** | 230+ 同梱 | 自己生成 + agentskills.io | ユーザー設定 |
| **多言語対応** | 英語、韓国語、中国語、日本語 | 英語 | 英語 |

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `cli-jaw: command not found` | `npm install -g cli-jaw` を再実行。macOS/Linux/WSL では `~/.local/bin` または `npm prefix -g` + `/bin` が `$PATH` に含まれているか確認。Windows PowerShell からは `wsl.exe -d Ubuntu -- bash -lc "jaw dashboard"` のように WSL login shell 経由で実行 |
| `Error: node version` | Node.js 22+ にアップグレード：`nvm install 22` |
| `NODE_MODULE_VERSION` mismatch | `npm run ensure:native`（ネイティブモジュールの自動リビルド） |
| `EADDRINUSE: port 3457` | 別のインスタンスが起動中。`--port 3458` で回避 |
| Telegram / Discord 認証失敗 | `jaw doctor` を実行してから `jaw serve` を再起動 |
| ブラウザコマンドが動かない | Chrome/Chromium をインストールし、`jaw browser start` を先に実行 |
| Employee ディスパッチがハング | Employee CLI が認証済みか確認（`jaw doctor`） |
| Computer Use が動かない | macOS のみ。Codex CLI が必要。システム設定で Automation 権限を確認 |

---

## コントリビュート

1. `dev` から Fork してブランチを作成
2. `npm run build && npm test`
3. PR を送信

バグ報告やアイデア：[Issue を作成](https://github.com/lidge-jun/cli-jaw/issues)

---

<div align="center">

**[MIT License](LICENSE)** · AI アプリのタブ切り替えに疲れた開発者たちが作りました。

</div>
