# cc-extensions

Claude Code 用のプラグインマーケットプレイスです。
いまは `opencode` プラグインを1つ収録しています。

## opencode プラグイン

Claude Code から [OpenCode](https://opencode.ai) にコードレビューや作業を任せるプラグインです。
コマンドの体系は OpenAI 公式の [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) に合わせています。

Claude は Claude Code で、GPT は Codex で使い、ローカルモデルを含むそれ以外のモデルは OpenCode で選び分ける、という使い分けを想定しています。

### できること

- `/opencode:review`：未コミットの変更またはブランチ差分のレビュー（読み取り専用）
- `/opencode:adversarial-review`：設計や前提を疑う厳しめのレビュー。
  観点を追加で指定できる
- `/opencode:rescue`：調査や修正を OpenCode に任せる
- `/opencode:status`、`/opencode:result`、`/opencode:cancel`：バックグラウンドジョブの確認、結果の表示、中止
- `/opencode:setup`：OpenCode の導入状態と利用できるモデルの確認。
  停止時レビューの有効化と無効化

### 必要なもの

- **OpenCode v2**（`opencode run --standalone --format json` が使えるバージョン。
  v2.0.20 で動作確認）
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

`/opencode:setup` は OpenCode が使えるかどうか、利用できるモデルの一覧、`--model` を省略したときに使うモデル（OpenCode 設定の `model`）を表示します。
OpenCode が見つからない場合は、その場でインストールするか確認します。
自分で入れる場合は次のコマンドを使います。

```bash
curl -fsSL https://opencode.ai/install | bash
```

モデルが1つも表示されない場合は、プロバイダに接続してください。

```bash
!opencode auth login
```

### 使い方

#### `/opencode:review`

現在の作業内容を OpenCode にレビューさせます。
読み取り専用で実行され、コードは変更しません。

```bash
/opencode:review
/opencode:review --base main
/opencode:review --background
/opencode:review --model ollama/qwen3
```

- `--base <ref>` でブランチ差分を対象にします。
  指定しなければ未コミットの変更を対象にします。
- `--wait` で結果を待ち、`--background` でバックグラウンド実行します。
  どちらも付けなければ、差分の大きさを見てどちらがよいかを提案し、確認してから実行します。
- 観点の追加指定はできません。
  観点を指定したいときは `/opencode:adversarial-review` を使います。

#### `/opencode:adversarial-review`

実装方針、設計上の選択、前提を疑う厳しめのレビューです。
対象の選び方は `/opencode:review` と同じで、フラグの後ろに観点を書けます。

```bash
/opencode:adversarial-review
/opencode:adversarial-review --base main キャッシュとリトライの設計を疑ってほしい
/opencode:adversarial-review --background 競合状態とロールバックを重点的に
```

#### `/opencode:rescue`

`opencode:opencode-rescue` サブエージェントを通じて、調査や修正を OpenCode に任せます。
既定では書き込みありで実行します。
読み取り専用にしたいときは、その旨を依頼文に書いてください。

```bash
/opencode:rescue テストが落ちる原因を調べて
/opencode:rescue --background 不安定なテストを調査して
/opencode:rescue --model openai/gpt-5.5 --effort high 最小限の修正で直して
/opencode:rescue --resume 一番重要な修正を適用して
```

- `--background` / `--wait`：バックグラウンドで実行するか、結果を待つかを選びます。
  指定しなければ結果を待ちます。
- `--resume` / `--fresh`：前回の OpenCode セッションを続けるか、新しく始めるかを選びます。
  どちらも付けない場合、同じ Claude セッションに再開できる作業があれば、続けるかどうかを確認します。
- `--model provider/model`：OpenCode のモデルを指定します。
  指定しなければ OpenCode の既定のモデルを使います。
  利用できるモデルは `/opencode:setup` で確認できます。
- `--effort <variant>`：モデルの variant（`provider/model#variant` の `#` 以降）を選びます。
  variant はモデルごとに決まるので、`--model` と一緒に指定します。
  名前はモデルによって異なります（例：`low`、`medium`、`high`）。

前回の作業を OpenCode 側の画面で続けたいときは、結果に表示される `opencode --session <id>` を使います。

#### `/opencode:status`

このリポジトリで実行中または最近終わったジョブを表示します。

```bash
/opencode:status
/opencode:status task-abc123
```

#### `/opencode:result`

終わったジョブの最終出力を表示します。
OpenCode のセッション ID も表示されるので、`opencode --session <id>` でそのまま続きを開けます。

```bash
/opencode:result
/opencode:result task-abc123
```

#### `/opencode:cancel`

実行中のジョブを中止します。
OpenCode が途中で起動したコマンドもまとめて止めます。

```bash
/opencode:cancel
/opencode:cancel task-abc123
```

#### `/opencode:setup`

OpenCode の導入状態と利用できるモデルを確認します。
停止時レビューもここで切り替えます。

```bash
/opencode:setup --enable-review-gate
/opencode:setup --disable-review-gate
```

停止時レビューを有効にすると、Claude が応答を終えるたびに、その応答で加えた変更を OpenCode が読み取り専用でレビューします。
問題が見つかれば応答の終了を止め、先に直すよう Claude に伝えます。
修正とレビューの往復が長引くと利用量が増えるので、様子を見られるときだけ有効にしてください。

### 実行のしかた

OpenCode はジョブごとに `opencode run --standalone` で起動し、専用のサーバーを立てて、終わったら止めます。
常駐するプロセスは残りません。
プロンプトは標準入力で渡すので、大きな差分でもコマンド引数の長さの上限に引っかかりません。

レビュー、停止時レビュー、読み取り専用を指定した作業は、ファイルを変更できない状態で実行します。
その実行の間だけ、すべての操作を禁止した専用エージェント `cc-companion-readonly` を `OPENCODE_CONFIG_CONTENT` で追加し、ファイルの読み取りと検索、`git status` や `git diff` などの読み取り系 git コマンドだけを許可します。
リダイレクト、`--output`、コマンド置換は拒否します。
git は設定次第で textconv や外部 diff などの別プログラムを起動するため、これらも環境変数で無害な設定に置き換えます。
ユーザーの OpenCode 設定ファイルは書き換えません。

なお、この制限は OpenCode の権限設定によるもので、OS のサンドボックスではありません。

書き込みありの作業では、OpenCode 組み込みの `build` エージェントを使います。
確認が必要な操作（作業ディレクトリ外へのアクセスや `.env` の読み取りなど）は、非対話の実行なので OpenCode が自動で拒否します。

レビュー結果は、差分を渡して JSON で返すようモデルに求め、応答から取り出した JSON を `review-output.schema.json` で検証します。
スキーマに合わない箇所があれば、結果の末尾に警告として表示します。
OpenCode の思考内容（reasoning）は全文が出力されるため、結果には末尾の一部だけを載せ、全文はジョブのログに残します。

### 開発

```bash
npm test
```

テストでは OpenCode を偽の実行ファイル（`tests/fake-opencode-fixture.mjs`）に置き換えます。
偽の実行ファイルは OpenCode と同じ規則で権限を判定する（後に書いた規則が優先され、`*` はワイルドカード）ので、読み取り専用エージェントで書き込みが拒否されることを自動テストで確かめられます。

## ライセンス

Apache License 2.0。
openai/codex-plugin-cc（Copyright 2026 OpenAI、Apache-2.0）を元に変更を加えています。
変更内容は [NOTICE](NOTICE) を参照してください。
