<div align="center">

# CLI-JAW

### 契約中の AI サブスクを、ひとつのアシスタントに。

[![npm](https://img.shields.io/npm/v/cli-jaw)](https://npmjs.com/package/cli-jaw)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](#-docker)
[![v2.0.0](https://img.shields.io/badge/v2.0.0-GA-green)](#200-の新機能)

[English](README.md) / [한국어](README.ko.md) / [中文](README.zh-CN.md) / **日本語**

![CLI-JAW manager dashboard](docs/screenshots/manager-dashboard-light.png)

</div>

---

## CLI-JAW とは

CLI-JAW は、複数の AI サブスクリプションをひとつの統一インターフェースにまとめるローカルファーストな AI アシスタントです。

Claude Max、ChatGPT Pro、GitHub Copilot、Gemini Advanced -- すでに契約しているサービスを OAuth でつなぎ、Web UI・ターミナル・Telegram・Discord から同じアシスタントにアクセスできます。トークン課金は発生しません。月額サブスクリプションをそのまま使います。

3 層メモリでコンテキストを保持し、100 以上のスキルでオフィス文書・ブラウザ操作・コード生成をカバー。PABCD オーケストレーションで複雑なタスクも段階的に実行します。

<table>
<tr><td><b>サブスクを統合</b></td><td>Claude Max、ChatGPT Pro、Copilot、Gemini Advanced を OAuth 経由でルーティング。OpenCode で任意のモデルも追加可能。トークン単位の課金なし。</td></tr>
<tr><td><b>Manager ダッシュボード</b></td><td>ローカルの全 JAW インスタンスを一覧・プレビュー・起動/停止。ライト/ダークテーマ切り替え、ランタイム設定の確認まで、ブラウザひとつで完結します。</td></tr>
<tr><td><b>Notes ワークスペース</b></td><td>ダッシュボード内蔵の Markdown vault。フォルダ管理、KaTeX 数式、Mermaid 図、コードハイライト対応。</td></tr>
<tr><td><b>どこからでもアクセス</b></td><td>Web PWA、Mac アプリ、ターミナル TUI、Telegram（音声対応）、Discord。どの入口でも同じアシスタント・同じメモリ。</td></tr>
<tr><td><b>3 層メモリ</b></td><td>History Block + Memory Flush + Soul & Task Snapshot。SQLite FTS5 で全文検索。</td></tr>
<tr><td><b>マルチエージェント</b></td><td>PABCD は DB 永続化の 5 段階 FSM。Employee システムで複数 CLI を連携。全フェーズがユーザー承認制。</td></tr>
<tr><td><b>ブラウザ & デスクトップ自動化</b></td><td>Chrome CDP、vision-click、Computer Use 統合。SVG ダイアグラムの生成もチャット内で。</td></tr>
<tr><td><b>MCP 一括管理</b></td><td><code>jaw mcp install</code> で 5 エンジンの設定を同時同期。JSON を 5 つ編集する必要なし。</td></tr>
</table>

---

## 2.0.0 の新機能

v2.0.0 GA では、ダッシュボードを中心にアーキテクチャを大幅に刷新しました。

### Manager ダッシュボード

マルチインスタンスを一画面で管理するコントロールプレーンです。

| 領域 | できること |
|---|---|
| **Navigator** | アクティブ/実行中/オフラインのインスタンスをグループ化。CLI・モデルラベル、カスタム名、ポート番号を表示し、プレビュー/起動/停止/再起動をワンクリックで実行 |
| **ライブプレビュー** | 選択したインスタンスの Web UI をプロキシ経由で埋め込み表示。リアルタイムで状態を確認しながら操作できます |
| **ランタイム設定** | 現在の CLI、モデル、推論レベル、権限モード、作業ディレクトリ、Employee、スキルなどを一覧表示 |

### Notes ワークスペース

ダッシュボードのホーム配下に組み込まれた Markdown vault です。

- フォルダツリーによるファイル管理
- 名前変更・ドラッグ&ドロップ移動
- 未保存状態の表示（dirty-state markers）
- Raw / Split / Preview の 3 モード切り替え
- KaTeX 数式レンダリング
- Mermaid 図表レンダリング
- シンタックスハイライト付きコードブロック

### Kanban ボード

実行中のインスタンスをドラッグしてカード化し、タスクの進捗を視覚的に管理できます。インスタンスの状態がリアルタイムでカードに反映されます。

### Employee システム

メインの CLI（Boss）が他の AI CLI を「従業員（Employee）」として呼び出す、マルチエージェント連携の仕組みです。詳細は [Employee システム](#employee-システム) セクションをご覧ください。

### レスポンシブモバイルレイアウト

ダッシュボードはモバイルとタブレットに最適化されたレスポンシブデザインを備えています。ナビゲーション、プレビュー、設定パネルが画面サイズに合わせて自動的に再配置されます。

---

## 2 行でインストール

```bash
npm install -g cli-jaw
jaw serve
```

**http://localhost:3457** を開いてください。Node.js 22+ と、以下の AI CLI のうち少なくともひとつの認証が必要です。

> `jaw service install` で OS 起動時の自動スタートを設定できます（systemd / launchd / Docker を自動検出）。

---

## プラットフォーム別セットアップ

### macOS

<details>
<summary>ターミナルが初めての方 -- ワンクリックインストール</summary>

1. **Terminal** を開きます（`Cmd + Space` → `Terminal` と入力）
2. 以下を貼り付けて Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install.sh | bash
```

3. 認証して起動:

```bash
copilot login
jaw serve        # → http://localhost:3457
```

</details>

Claude Code を使う場合の注意: Anthropic computer-use MCP が必要なら、ネイティブ Claude インストーラーを推奨します（`curl -fsSL https://claude.ai/install.sh | bash`）。npm/bun 経由の `claude` は `jaw doctor` が警告を出します。

### Windows / WSL

<details>
<summary>WSL ワンクリックセットアップ</summary>

**Step 1: WSL をインストール**（管理者権限の PowerShell）

```powershell
wsl --install
```

再起動後、スタートメニューから **Ubuntu** を開きます。

**Step 2: CLI-JAW をインストール**

```bash
curl -fsSL https://raw.githubusercontent.com/lidge-jun/cli-jaw/master/scripts/install-wsl.sh | bash
```

**Step 3: シェルを再読み込みして起動**

```bash
source ~/.bashrc
copilot login    # or: claude auth / codex login / gemini
jaw serve        # → http://localhost:3457
```

<details>
<summary>WSL トラブルシューティング</summary>

| 症状 | 対処 |
|---|---|
| `unzip: command not found` | インストーラーを再実行 |
| `jaw: command not found` | `source ~/.bashrc` |
| Permission errors | `sudo chown -R $USER $(npm config get prefix)` |

</details>
</details>

### Linux

```bash
npm install -g cli-jaw
jaw serve
```

systemd 環境なら `jaw service install` でサービス登録まで完了します。

---

## 認証

ひとつあれば十分です。すでに契約しているサービスを選んでください。

```bash
# 無料
copilot login        # GitHub Copilot
opencode             # OpenCode -- 無料モデルあり

# 有料（月額サブスクリプション）
claude auth          # Anthropic Claude Max
codex login          # OpenAI ChatGPT Pro
gemini               # Google Gemini Advanced
```

認証状態の確認は `jaw doctor` で行えます。

<details>
<summary>jaw doctor の出力例</summary>

```
🦈 CLI-JAW Doctor -- 12 checks

 ✅ Node.js        v22.15.0
 ✅ Claude CLI      installed
 ✅ Codex CLI       installed
 ⚠️ Gemini CLI      not found (optional)
 ✅ OpenCode CLI    installed
 ✅ Copilot CLI     installed
 ✅ Database        jaw.db OK
 ✅ Skills          22 active, 94 reference
 ✅ MCP             3 servers configured
 ✅ Memory          MEMORY.md exists
 ✅ Server          port 3457 available
```

</details>

---

## ダッシュボード

ダッシュボードは CLI-JAW のメインコントロールプレーンです。インスタンスの検出・プレビュー・設定・Employee・Notes をひとつの画面にまとめつつ、各インスタンスは独自のホームディレクトリ・DB・メモリ・作業ディレクトリを保持します。

### Navigator

アクティブ/実行中/オフラインのインスタンスをグループ化して表示します。CLI とモデルのラベル、カスタム名、ポート番号が一目で分かり、プレビュー・起動・停止・再起動を直接操作できます。

### ライブプレビュー

選択したインスタンスの Web UI を Manager のプレビュープロキシ経由で埋め込み表示します。更新・別ウィンドウで開く・プレビューの ON/OFF 切り替えが可能です。

### ランタイム設定

選択中のインスタンスについて、現在のアクティブ CLI、モデル、推論レベル、権限モード、作業ディレクトリ、Employee、スキル、設定を確認できます。

### Notes

ダッシュボードに組み込まれた Markdown vault です。フォルダツリー、手動保存、ドラッグ&ドロップでのフォルダ移動、名前変更、Split プレビュー、KaTeX・Mermaid・コードハイライトに対応しています。

---

## Employee システム

Employee システムは、メインの CLI（Boss）が他の AI CLI を「従業員」として呼び出すマルチエージェント連携の仕組みです。

### 仕組み

```
ユーザー → jaw サーバー → Boss エージェント（メイン CLI）
                           ├── 直接応答（単純なタスク）
                           └── cli-jaw dispatch で Employee を呼び出し
                                ├── Frontend（UI/CSS の修正）
                                ├── Backend（API/DB の実装）
                                └── 結果を Boss が統合して返答
```

### ディスパッチ

```bash
cli-jaw dispatch --agent "Backend" --task "API エンドポイントを検証してください"
```

各 Employee は独自の CLI セッションで動作し、結果は標準出力で Boss に返されます。Boss が結果を統合してユーザーに報告します。

### 登録済み Employee の例

| Employee | CLI | 担当領域 |
|---|---|---|
| Frontend | opencode | UI/UX、CSS、コンポーネント |
| Backend | codex | API、DB、サーバーロジック |
| Research | codex | リサーチ、調査 |
| Docs | claude | ドキュメント、README、API ドキュメント |

Employee の構成は `settings.json` でカスタマイズできます。

---

## 5 つの AI エンジン

すでに契約している OAuth サブスクリプションで 5 つの CLI バックエンドをルーティングします。トークン単位の API 課金はありません。

| CLI | デフォルトモデル | 認証コマンド | コストモデル |
|---|---|---|---|
| **Claude** | `opus-4-6` | `claude auth` | Claude Max サブスクリプション |
| **Codex** | `gpt-5.5` | `codex login` | ChatGPT Pro サブスクリプション |
| **Gemini** | `gemini-3.1-pro-preview` | `gemini` | Gemini Advanced サブスクリプション |
| **OpenCode** | `minimax-m2.7` | `opencode` | 無料モデルあり |
| **Copilot** | `gpt-5-mini` | `copilot login` | 無料枠あり |

**フォールバックチェーン**: あるエンジンがレートリミットや障害で使えなくなった場合、次のエンジンが自動で引き継ぎます。`/fallback [cli1 cli2...]` で優先順位を設定できます。

**OpenCode ワイルドカード**: OpenRouter、ローカル LLM、OpenAI 互換 API など、任意のモデルエンドポイントを接続できます。

> エンジン切り替え: `/cli codex`。モデル切り替え: `/model gpt-5.5`。Web・Terminal・Telegram・Discord のどこからでも可能です。

---

## PABCD オーケストレーション

複雑なタスクに対して、CLI-JAW は 5 段階のステートマシンで段階的に進行します。すべてのフェーズ遷移はユーザーの承認が必要です。

```
P (Plan) → A (Audit) → B (Build) → C (Check) → D (Done) → IDLE
   ⛔         ⛔          ⛔         auto        auto
```

| フェーズ | 内容 |
|---|---|
| **P** (Plan) | Boss AI が diff レベルの実行計画を作成。ユーザーのレビューを待ちます |
| **A** (Audit) | 読み取り専用の Worker がプランの実行可能性を検証 |
| **B** (Build) | Boss が実装。Worker が結果を検証 |
| **C** (Check) | 型チェック、ドキュメント更新、整合性チェック |
| **D** (Done) | 全変更のサマリーを作成し、IDLE に戻ります |

状態は DB に永続化されるため、サーバー再起動後も維持されます。Worker はファイルを変更できません。

起動方法: `jaw orchestrate` または `/pabcd`

---

## メモリ

3 つの層がそれぞれ異なるリコール範囲を担当します。

| 層 | 保存する内容 | 仕組み |
|---|---|---|
| **History Block** | 直近のセッションコンテキスト | `buildHistoryBlock()` -- 直近 10 セッション、最大 8,000 文字、作業ディレクトリごとにスコープ。プロンプト先頭に注入 |
| **Memory Flush** | 会話から抽出した構造化ナレッジ | 一定のターン数（デフォルト 10）を超えると実行。エピソード、日次ログ（`YYYY-MM-DD.md`）、ライブノートとして Markdown 保存 |
| **Soul + Task Snapshot** | アイデンティティとセマンティック検索 | `soul.md` でトーン・価値観・境界を定義。FTS5 インデックスから各プロンプトごとに最大 4 件（各 700 文字）の関連ヒットを取得 |

3 層すべてがシステムプロンプトに自動注入されます。

```bash
jaw memory search <query>     # CLI から検索
/memory <query>               # Web / Telegram / Discord から検索
```

Advanced memory として、プロフィールサマリ、ブートストラップ/マイグレーション、再インデックスフローも用意されており、Web UI の設定から操作できます。

---

## スキル

100 以上のスキルが用途別に整理されています。

| カテゴリ | スキル | 対応範囲 |
|---|---|---|
| **Office** | `pdf`, `docx`, `xlsx`, `pptx`, `hwp` | 文書の読み取り・作成・編集。OfficeCLI による韓国語 HWP/HWPX 対応 |
| **Automation** | `browser`, `vision-click`, `screen-capture`, `desktop-control` | Chrome CDP、AI 座標クリック、macOS スクリーンショット/カメラ、Computer Use |
| **Media** | `video`, `imagegen`, `lecture-stt`, `tts` | Remotion 動画レンダリング、OpenAI 画像生成、講義文字起こし、音声合成 |
| **Integration** | `github`, `notion`, `telegram-send`, `memory` | Issues/PRs/CI、Notion ページ、Telegram メディア配信、永続メモリ |
| **Visualization** | `diagram` | チャット内に SVG ダイアグラム・チャート・インタラクティブ図をレンダリング |
| **Dev guides** | `dev`, `dev-frontend`, `dev-backend`, `dev-data`, `dev-testing`, `dev-pabcd`, `dev-code-reviewer` | サブエージェントに注入されるエンジニアリングガイドライン |

22 個のアクティブスキルは常時注入されます。94 以上のリファレンススキルはオンデマンドで読み込まれます。

```bash
jaw skill install <name>    # リファレンススキルをアクティブ化
```

---

## ブラウザ & デスクトップ自動化

| 機能 | 概要 |
|---|---|
| **Chrome CDP** | DevTools Protocol でページ遷移、クリック、入力、スクリーンショット、JS 実行、スクロール、フォーカス、キー入力の 10 アクションを実行 |
| **Vision-click** | 画面をスクリーンショットし、AI がターゲット座標を抽出してクリック。`jaw browser vision-click "Login button"` の 1 コマンドで完結 |
| **DOM reference** | ChatGPT、Grok、Gemini Web UI のセレクタマップ。モデル選択・停止ボタン・ツールドロワーを操作 |
| **Computer Use** | Codex App Computer Use MCP によるデスクトップアプリ自動化。DOM ターゲットは CDP へ、デスクトップアプリは Computer Use へ自動ルーティング |
| **Diagram スキル** | SVG ダイアグラムとインタラクティブな HTML ビジュアライゼーションを生成し、コピー/保存コントロール付きのサンドボックス iframe にレンダリング |

---

## メッセージング

### Telegram

```
📱 Telegram ←→ 🦈 CLI-JAW ←→ 🤖 AI Engines
```

<details>
<summary>セットアップ（3 ステップ）</summary>

1. Bot を作成 -- [@BotFather](https://t.me/BotFather) にメッセージ → `/newbot` → トークンをコピー
2. 設定 -- `jaw init --telegram-token YOUR_TOKEN` または Web UI の設定から
3. Bot に何かメッセージを送信。Chat ID は初回メッセージ時に自動保存されます

</details>

Telegram でできること: テキストチャット、音声メッセージ（マルチプロバイダ STT で自動文字起こし）、ファイル/写真アップロード、スラッシュコマンド（`/cli`、`/model`、`/status`）、スケジュールタスク結果の自動配信。

### Discord

Telegram と同等の機能をサポートしています -- テキスト、ファイル、コマンド。チャンネル/スレッドルーティングと、エージェント結果のブロードキャスト用フォワーダーを備えています。設定は Web UI から行います。

### 音声 & STT

音声入力は Web（マイクボタン）、Telegram（音声メッセージ）、Discord で動作します。プロバイダは OpenAI 互換、Google Vertex AI、任意のカスタムエンドポイントに対応。Web UI の設定で構成します。

---

## MCP

[Model Context Protocol](https://modelcontextprotocol.io) は、AI エージェントが外部ツールを利用するためのプロトコルです。CLI-JAW では 5 エンジンの MCP 設定を 1 ファイルで管理します。

```bash
jaw mcp install @anthropic/context7
# → Claude, Codex, Gemini, OpenCode, Copilot の設定ファイルに同期
```

5 つの JSON ファイルを別々に編集する必要はありません。一度インストールすれば全エンジンに反映されます。

```bash
jaw mcp sync       # 手動編集後の再同期
```

---

## CLI コマンド

```bash
jaw serve                         # サーバー起動 → http://localhost:3457
jaw chat                          # ターミナル TUI
jaw doctor                        # 12 項目の診断
jaw service install               # OS 起動時の自動スタート
jaw skill install <name>          # スキルをアクティブ化
jaw mcp install <package>         # MCP をインストール → 5 エンジンに同期
jaw memory search <query>         # メモリを検索
jaw browser start                 # Chrome を起動（CDP）
jaw browser vision-click "Login"  # AI による座標クリック
jaw clone ~/project               # インスタンスを複製
jaw --home ~/project serve --port 3458  # 2 つ目のインスタンスを起動
jaw orchestrate                   # PABCD を開始
jaw dispatch --agent Backend --task "..." # Employee をディスパッチ
jaw reset                         # フルリセット
```

---

## マルチインスタンス & Docker

### マルチインスタンス

設定・メモリ・データベースが完全に分離されたインスタンスを同時に実行できます。

```bash
jaw clone ~/my-project
jaw --home ~/my-project serve --port 3458
```

各インスタンスは独自の作業ディレクトリ、メモリ、MCP 設定を持ちます。

### Docker

```bash
docker compose up -d       # → http://localhost:3457
```

非 root の `jaw` ユーザーで動作し、Chromium サンドボックスを有効化しています。Dockerfile は 2 種類: `Dockerfile`（npm install）と `Dockerfile.dev`（ローカルソース）。データは `jaw-data` Named Volume に永続化されます。

<details>
<summary>Docker の詳細</summary>

```bash
# 開発ビルド
docker build -f Dockerfile.dev -t cli-jaw:dev .
docker run -d -p 3457:3457 --env-file .env cli-jaw:dev

# バージョン固定
docker build --build-arg CLI_JAW_VERSION=2.0.0 -t cli-jaw:2.0.0 .

# Chromium サンドボックスが失敗する場合
docker run -e CHROME_NO_SANDBOX=1 -p 3457:3457 cli-jaw
```

</details>

### リモートアクセス（Tailscale）

```bash
jaw serve --lan                       # 0.0.0.0 にバインド + tailnet ピアを許可
# settings.json: network.bindHost=0.0.0.0, lanBypass=true
```

`lanBypass=true` 時に許可されるピアアドレス:

- `100.64.0.0/10` -- Tailscale CGNAT (RFC 6598)
- `fd7a:115c:a1e0::/48` -- Tailscale ULA
- `*.ts.net` -- MagicDNS ホスト名

> Tailnet ピアは WireGuard + IdP 認証済みのため LAN として扱われます。`lanBypass=false` にすると全ピアに `JAW_AUTH_TOKEN` を要求します。

---

## 開発

```bash
npm run build          # tsc → dist/
npm run dev            # tsx server.ts（ホットリロード）
npm test               # Node.js ネイティブテストランナー
```

アーキテクチャとテストの詳細:

| ドキュメント | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | リリースログ |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | システム設計、モジュールグラフ、95 個の API ハンドラ |
| [TESTS.md](TESTS.md) | テストカバレッジとテスト計画 |
| [memory-architecture.md](docs/memory-architecture.md) | 3 層メモリモデルの詳細 |
| [env-vars.md](docs/env-vars.md) | 環境変数リファレンス |
| [devlog/structure/](devlog/structure/) | 内部アーキテクチャ（プロンプトパイプライン、フロントエンド、サーバー API、メモリ） |

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `cli-jaw: command not found` | `npm install -g cli-jaw` を再実行。`npm bin -g` が `$PATH` に含まれているか確認 |
| `Error: node version` | Node.js 22+ にアップグレード: `nvm install 22` |
| `NODE_MODULE_VERSION` mismatch | `npm run ensure:native`（ネイティブモジュールの自動リビルド） |
| `EADDRINUSE: port 3457` | 別のインスタンスが起動中。`--port 3458` で回避 |
| Telegram / エージェント認証の失敗 | `jaw doctor` を実行してから `jaw serve` を再起動 |
| ブラウザコマンドが動かない | Chrome をインストールし、`jaw browser start` を先に実行 |

---

## コントリビュート

1. `master` から fork してブランチを作成
2. `npm run build && npm test` で動作確認
3. Pull Request を送信

バグ報告やアイデアは [Issue](https://github.com/lidge-jun/cli-jaw/issues) からお気軽にどうぞ。

---

## 他ツールとの比較

| | CLI-JAW | Hermes Agent | Claude Code |
|---|---|---|---|
| **モデルアクセス** | OAuth サブスク（Claude Max / ChatGPT Pro / Copilot / Gemini）+ OpenCode ワイルドカード | API キー（OpenRouter 200+ / Nous Portal） | Anthropic のみ |
| **コストモデル** | 契約済みの月額サブスクリプション | トークン単位の API 課金 | Anthropic サブスクリプション |
| **メイン UI** | Web PWA + Mac アプリ + TUI | TUI のみ | CLI + IDE プラグイン |
| **メッセージング** | Telegram（音声）+ Discord | Telegram / Discord / Slack / WhatsApp / Signal | なし |
| **メモリ** | 3 層（History / Flush / Soul）+ FTS5 | Self-improving loop + Honcho | ファイルベース自動メモリ |
| **ブラウザ自動化** | Chrome CDP + vision-click + DOM ref | 限定的 | MCP 経由 |
| **オーケストレーション** | PABCD 5 段階 FSM | Subagent spawn | Task tool |
| **実行環境** | ローカル + Docker | Local / Docker / SSH / Daytona / Modal / Singularity | ローカル |
| **スキル** | 100+ 同梱 | 自己生成 + agentskills.io | ユーザー設定 |
| **多言語** | English / Korean / Chinese / Japanese | English | English |

CLI-JAW は OpenClaw harness architecture（ハイブリッド検索マネージャー、フォールバックパターン、セッションインデックス）の系譜にあります。OpenClaw から移行する場合、スラッシュコマンドとメモリモデルは馴染みやすいはずです。

---

<div align="center">

**[MIT License](LICENSE)**

</div>
