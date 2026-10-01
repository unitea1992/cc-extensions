# cc-extensions

Claude Code 専用のプラグインマーケットプレイスです。現在は `opencode` プラグイン（opencode-plugin-cc）を収録しています。

## opencode プラグイン

Claude Code から [OpenCode](https://opencode.ai) にコードレビューや作業を任せるためのプラグインです。OpenAI 公式の [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) と同じコマンド体系を持つ OpenCode 版です。

Claude Code は Claude、Codex は GPT と役割を分け、ローカルモデルを含む様々なモデルは OpenCode 側で選び分ける、という使い方を想定しています。

### できること

- `/opencode:review`：作業ツリーまたはブランチ差分の通常レビュー（読み取り専用）
- `/opencode:adversarial-review`：設計や前提を疑う厳しめのレビュー。観点を追加で指定できる
- `/opencode:rescue`：調査や修正を OpenCode に任せる
- `/opencode:status`、`/opencode:result`、`/opencode:cancel`：バックグラウンドジョブの確認、結果の表示、中止
- `/opencode:setup`：OpenCode の導入状態と利用できるモデルの確認。停止時レビューの有効化と無効化

### 必要なもの

- **OpenCode v2**（`opencode run --standalone --format json` が使えるバージョン。v2.0.20 で動作確認）
- OpenCode で使えるモデル（`opencode auth login` で接続したプロバイダ、または OpenCode 設定に追加したローカルモデル）
- **Node.js 18.18 以上**

### 導入

Claude Code でマーケットプレイスを追加します。

```bash
/plugin marketplace add unitea1992/cc-extensions
```

プラグインを入れます。

```bash
/plugin install opencode@cc-extensions
```

プラグインを再読み込みしてから、導入状態を確認します。

```bash
/reload-plugins
/opencode:setup
```

`/opencode:setup` は OpenCode が使えるかどうかと、利用できるモデルの一覧を表示します。OpenCode が見つからない場合は、その場でインストールするか確認します。自分で入れる場合は次のコマンドを使います。

```bash
curl -fsSL https://opencode.ai/install | bash
```

モデルが1つも表示されない場合は、プロバイダに接続してください。

```bash
!opencode auth login
```

### 使い方

#### `/opencode:review`

現在の作業内容を OpenCode にレビューさせます。読み取り専用で実行され、コードは変更しません。

```bash
/opencode:review
/opencode:review --base main
/opencode:review --background
/opencode:review --model ollama/qwen3
```

- `--base <ref>` でブランチ差分を対象にします。指定しなければ未コミットの変更を対象にします。
- `--wait` で結果を待ち、`--background` でバックグラウンド実行します。どちらも付けない場合は差分の大きさから推奨を示して確認します。
- 観点の追加指定はできません。観点を指定したいときは `/opencode:adversarial-review` を使います。

#### `/opencode:adversarial-review`

実装方針、設計上の選択、前提を疑う厳しめのレビューです。対象の選び方は `/opencode:review` と同じで、フラグの後ろに観点を書けます。

```bash
/opencode:adversarial-review
/opencode:adversarial-review --base main キャッシュとリトライの設計を疑ってほしい
/opencode:adversarial-review --background 競合状態とロールバックを重点的に
```

#### `/opencode:rescue`

`opencode:opencode-rescue` サブエージェントを通じて、調査や修正を OpenCode に任せます。既定では書き込みありで実行します。読み取り専用にしたいときは、その旨を依頼文に書いてください。

```bash
/opencode:rescue テストが落ちる原因を調べて
/opencode:rescue --background 不安定なテストを調査して
/opencode:rescue --model openai/gpt-5.5 --effort high 最小限の修正で直して
/opencode:rescue --resume 一番重要な修正を適用して
```

- `--background` / `--wait`：バックグラウンド実行か前景実行かを選びます。
- `--resume` / `--fresh`：前回の OpenCode セッションを続けるか、新しく始めるかを選びます。どちらも付けない場合、同じ Claude セッションに再開できる作業があれば、続けるかどうかを確認します。
- `--model provider/model`：OpenCode のモデルを指定します。指定しなければ OpenCode の既定のモデルを使います。利用できるモデルは `/opencode:setup` で確認できます。
- `--effort <variant>`：モデルの variant（`provider/model#variant`）を選びます。そのため `--model` と一緒に指定します。使える名前はモデルによって異なります（例：`low`、`medium`、`high`）。

前回の作業を OpenCode 側の画面で続けたいときは、結果に表示される `opencode --session <id>` を使います。

#### `/opencode:status`

このリポジトリで実行中または最近終わったジョブを表示します。

```bash
/opencode:status
/opencode:status task-abc123
```

#### `/opencode:result`

終わったジョブの最終出力を表示します。OpenCode のセッション ID も表示されるので、`opencode --session <id>` でそのまま続きを開けます。

```bash
/opencode:result
/opencode:result task-abc123
```

#### `/opencode:cancel`

実行中のバックグラウンドジョブを中止します。OpenCode のプロセスはジョブごとに別のプロセスグループで動いているため、グループごと止めます。

```bash
/opencode:cancel
/opencode:cancel task-abc123
```

#### `/opencode:setup`

OpenCode の導入状態と利用できるモデルを確認します。停止時レビューもここで切り替えます。

```bash
/opencode:setup --enable-review-gate
/opencode:setup --disable-review-gate
```

停止時レビューを有効にすると、Claude が応答を終えるたびに、直前の変更を OpenCode が読み取り専用でレビューします。問題が見つかれば終了を止めて、先に直すよう Claude に伝えます。Claude と OpenCode のやり取りが長く続くことがあり、利用量が増えやすいので、様子を見られるときだけ有効にしてください。

### 仕組み

- 実行のたびに `opencode run --standalone --format json` で専用サーバーを立て、終わると止めます。本家の app-server や broker のような共有の常駐プロセスは持ちません。
- プロンプトは標準入力で渡します。レビューの差分はコマンド引数の長さの上限を超えやすいためです。
- **読み取り専用**の実行（レビュー、停止時レビュー、`--write` なしの作業）では、その実行の間だけ `OPENCODE_CONFIG_CONTENT` で専用エージェント `cc-companion-readonly` を注入します。権限はまずすべて禁止し、ファイルの読み取りと検索、`git status` や `git diff` などの読み取り系シェルだけを許可します。リダイレクト、`--output`、コマンド置換は拒否します。ユーザーの OpenCode 設定ファイルは書き換えません。
  - 許可した git コマンドも、リポジトリやユーザーの git 設定（textconv、外部 diff、clean/process フィルタ、fsmonitor）経由で別のプログラムを起動できます。読み取り専用の実行では、これらを `GIT_CONFIG_*` 環境変数で無害な設定に上書きしてから OpenCode を起動します。
  - 本家 Codex の read-only サンドボックスは OS レベルで書き込みを止めますが、このプラグインは OpenCode の権限設定で止めています。許可したコマンドの外へは書き込めない設計ですが、OS レベルの隔離ではない点に注意してください。
- **書き込みあり**の実行では OpenCode 組み込みの `build` エージェントを使います。非対話の実行なので、確認が必要な操作（作業ディレクトリ外へのアクセス、`.env` の読み取りなど）は OpenCode が自動で拒否します。`--auto` は使いません。
- OpenCode には本家の `review/start` にあたる組み込みのレビュアーがないため、通常レビューも敵対的レビューも、差分を集めてプロンプトで JSON を求めます。出力形式は本家の `review-output.schema.json` を共有し、応答から JSON を取り出して検証します。スキーマに合わない箇所があれば、レビュー結果の末尾に警告として表示します。
- OpenCode の思考内容（reasoning）は要約ではなく全文が出るため、結果には末尾の一部だけを短く表示します。全文はジョブのログに残ります。

### 本家から持ち込んでいないもの

- `/codex:transfer`（Claude の会話を Codex に取り込む機能）。OpenCode の `session import` 形式への変換は、需要が出てから別 Issue で扱います。
- GPT 向けのプロンプト作成スキル
- `spark` のようなモデルの別名

### 開発

```bash
npm test
```

テストでは OpenCode を偽の実行ファイル（`tests/fake-opencode-fixture.mjs`）に置き換えます。偽の実行ファイルは OpenCode と同じ権限評価（後に書いた規則が優先、`*` のワイルドカード）を再現しているので、読み取り専用エージェントの規則で書き込みが拒否されることを自動テストで確認できます。

## ライセンス

Apache License 2.0。openai/codex-plugin-cc（Copyright 2026 OpenAI、Apache-2.0）を元に変更を加えています。変更内容は [NOTICE](NOTICE) を参照してください。
