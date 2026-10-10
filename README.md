# cc-extensions

Claude Code 用のプラグインマーケットプレイスです。
次の3つのプラグインを収録しています。

- `opencode`：Claude Code から OpenCode にレビューや作業を任せる
- `pi`：Claude Code から Pi に調査や修正を任せる
- `typescript7-lsp`：TypeScript 7 のリポジトリで Claude Code の LSP ツールを使えるようにする

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
  v2.0.22 で動作確認）
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
- `--auto`：書き込みありの作業で、OpenCode の設定で明示的に `deny` されていない権限確認を自動で許可します。
  付けなければ、作業ディレクトリの外への書き込み（別の worktree の作成、`~/.claude/state` への報告ファイルなど）は確認が必要な操作として拒否されます。
  読み取り専用の実行では何も変わりません。
- `--idle-timeout <秒>`：OpenCode から何も出力されないまま、この時間が過ぎたら実行を止めて失敗として返します。
  既定は600秒（10分）で、`0` で無効になります。
  環境変数 `OPENCODE_COMPANION_IDLE_TIMEOUT_SECONDS` でも指定できます。

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

### ほかの Claude Code セッションから作業を渡す

作業を割り振る側の Claude Code セッションが OpenCode に作業を渡して結果を受け取るときは、サブエージェントを通さず companion スクリプトを直接呼びます。
ローカルモデルの作業は10分を超えることがあり、Bash ツールの待ち時間の上限に収まらないので、バックグラウンドで実行して完了を待ちます。

導入済みのプラグインの場所を変数に入れておきます。
プラグインの中から呼ぶときは `${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs` を使います。

```bash
OC=$(ls ~/.claude/plugins/cache/cc-extensions/opencode/*/scripts/opencode-companion.mjs | tail -n 1)
```

1. 指示文をファイルに書き、作業するリポジトリ（worktree でもよい）の中でジョブを始めます。
   `--json` を付けると `jobId` が返ります。

   ```bash
   node "$OC" task --background --write --model ollama/qwen3 --prompt-file /path/to/prompt.md --json
   ```

   作業ディレクトリの外（報告ファイルや別の worktree）にも書かせたいときは `--auto` を足します。

2. 完了を待ちます。
   `--timeout-ms` の間に終わらなければ `waitTimedOut: true` が返るので、同じコマンドをもう一度実行します。

   ```bash
   node "$OC" status <jobId> --wait --timeout-ms 540000 --json
   ```

   `job.status` が `completed` なら成功、`failed` なら失敗です。

3. 結果を受け取ります。
   OpenCode の最終応答がそのまま表示されます。

   ```bash
   node "$OC" result <jobId>
   ```

途中でやめるときは `node "$OC" cancel <jobId>` を使います。
`--write` を付けなければ読み取り専用で実行します。
指示文は標準入力で OpenCode に渡すので、長さの上限はありません。

ローカルモデルを使うときは、次の2点に注意してください。

- ローカルの OpenAI 互換サーバーには、`--model` で指定した名前に関係なく、その時点でロードされているモデルが応答するものがあります。
  指定したモデルで動かしたいときは、先にサーバー側でそのモデルをロードしておきます。
- モデルが読み込み中などで応答しないと、OpenCode は何も出力しないまま待ち続けます。
  プラグインは `--idle-timeout`（既定10分）で実行を止め、モデルが応答できるか確かめるよう促すメッセージを付けて失敗として返します。

### 実行のしかた

OpenCode はジョブごとに `opencode run --standalone` で起動し、専用のサーバーを立てて、終わったら止めます。
常駐するプロセスは残りません。
常駐サービス（`opencode serve --service`）を使わないので、サービスを起動したあとに OpenCode の設定を変えても、古い設定のまま動くことはありません。

この専用サーバーは、まれに起動の途中で止まり、モデルへのリクエストを送らないまま待ち続けることがあります（OpenCode v2.0.22 で、30回あまりの実行のうち1回）。
そこで `--print-logs` でサーバーのログを受け取り、45秒たってもサーバーが1行もログを出さなければ止めて、最大3回まで起動し直します。
この時点では指示文がまだ処理されていないので、やり直しても同じ作業が二重に行われることはありません。
プロンプトは標準入力で渡すので、大きな差分でもコマンド引数の長さの上限に引っかかりません。

レビュー、停止時レビュー、読み取り専用を指定した作業は、ファイルを変更できない状態で実行します。
その実行の間だけ、すべての操作を禁止した専用エージェント `cc-companion-readonly` を `OPENCODE_CONFIG_CONTENT` で追加し、ファイルの読み取りと検索、`git status` や `git diff` などの読み取り系 git コマンドだけを許可します。
リダイレクト、`--output`、コマンド置換は拒否します。
git は設定次第で textconv や外部 diff などの別プログラムを起動するため、これらも環境変数で無害な設定に置き換えます。
ユーザーの OpenCode 設定ファイルは書き換えません。

なお、この制限は OpenCode の権限設定によるもので、OS のサンドボックスではありません。

書き込みありの作業では、OpenCode 組み込みの `build` エージェントを使います。
確認が必要な操作（作業ディレクトリ外へのアクセスや `.env` の読み取りなど）は、非対話の実行なので OpenCode が自動で拒否します。
プラグインが OpenCode の権限を書き換えることはなく、OpenCode の設定（`permission`）がそのまま効きます。
拒否される操作をまとめて許可したいときは、設定で許可するか、`--auto` を付けます。
`--auto` は OpenCode の `run --auto` に渡され、設定で明示的に `deny` された操作は許可されません。

レビュー結果は、差分を渡して JSON で返すようモデルに求め、応答から取り出した JSON を `review-output.schema.json` で検証します。
スキーマに合わない箇所があれば、結果の末尾に警告として表示します。
OpenCode の思考内容（reasoning）は全文が出力されるため、結果には末尾の一部だけを載せ、全文はジョブのログに残します。

## pi プラグイン

Claude Code から Pi（`pi` コマンドで動くコーディングエージェント。ローカルモデルでも使える）に調査や修正を任せるプラグインです。
`/opencode:rescue` と同じ形で、`pi:pi-rescue` サブエージェント、バックグラウンド実行、結果の受け取り、前回の作業の再開が使えます。
レビューのコマンドはありません。

### できること

- `/pi:rescue`：調査や修正を Pi に任せる
- `/pi:status`、`/pi:result`、`/pi:cancel`：バックグラウンドジョブの確認、結果の表示、中止
- `/pi:setup`：Pi の導入状態と利用できるモデルの確認

### 必要なもの

- **Pi**（`pi --print --mode json` が使えるバージョン。1.1.0 で動作確認）
- Pi で使えるモデル（`pi --list-models` に表示されるもの）
- **Node.js 18.18 以上**

### 導入

マーケットプレイスを追加していなければ、先に追加します（手順は opencode プラグインの「導入」と同じです）。

```bash
/plugin install pi@cc-extensions
/reload-plugins
/pi:setup
```

### 使い方

```bash
/pi:rescue テストが落ちる原因を調べて
/pi:rescue --background 不安定なテストを調査して
/pi:rescue --model spark/Qwen3.8-Flash-Next --effort high 最小限の修正で直して
/pi:rescue --resume 一番重要な修正を適用して
```

- `--background` / `--wait`、`--resume` / `--fresh`、`--model`、`--idle-timeout` は `/opencode:rescue` と同じ意味です。
- `--effort <段階>`：Pi の思考の段階（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）を選びます。
- 既定では書き込みありで実行します。
  読み取り専用にしたいときは、その旨を依頼文に書いてください。

他のセッションから直接呼ぶときは、opencode と同じく companion スクリプトを使います。

```bash
PI=$(ls ~/.claude/plugins/cache/cc-extensions/pi/*/scripts/pi-companion.mjs | tail -n 1)
node "$PI" task --background --write --prompt-file /path/to/prompt.md --json
node "$PI" status <jobId> --wait --timeout-ms 540000 --json
node "$PI" result <jobId>
```

### 権限について

Pi には承認や sandbox の仕組みがありません。
ツールは Pi を起動したアカウントの権限でそのまま動くので、作業ディレクトリの外（報告ファイルや別の worktree）にも書けます。
OpenCode や Codex のように、プラグインが利用者の権限設定を上書きすることはありません。

読み取り専用の実行では、`--tools read,grep,find,ls` で Pi に渡すツールを絞ります。
ファイルの書き換えやコマンドの実行（テストの実行も含む）はできません。
この制限はツールを渡さないことによるもので、OS のサンドボックスではありません。

プロジェクトのローカル設定（`.pi/` の拡張や設定）は、Pi の信頼の確認に任せます。
プラグインは `--approve` を付けません。

### 実行のしかた

Pi はジョブごとに `pi --print --mode json` で起動し、終わったら止まります。
常駐するプロセスは残りません。
指示文は標準入力で渡すので、長さの上限はありません。

新しい作業には、プラグインが ID を決めたセッション（`--session-id`）を使い、`--resume` では同じ ID を `--session` で開きます。
前回の作業を Pi 側の画面で続けたいときは、結果に表示される `pi --session <id>` を使います。

出力が `--idle-timeout`（既定600秒）の間止まったら、実行を止めて失敗として返します。

## typescript7-lsp プラグイン

TypeScript 7 のリポジトリで、Claude Code の LSP ツール（定義へ移動、参照の検索、hover など）を使えるようにするプラグインです。

標準の `typescript-lsp@claude-plugins-official` は `typescript-language-server` を起動します。
TypeScript 7 には `tsserver.js` が無く、このサーバーは「provides no tsserver.js ... Exiting.」と出て終了します。
その結果、TypeScript 7 のリポジトリでは LSP ツールが使えません。
このプラグインは、TypeScript 7 自身が持つ `tsc --lsp --stdio` を起動します。

### 必要なもの

- **TypeScript 7 以上**（プロジェクトの `node_modules` か、PATH 上の `tsc`）
- **Node.js 18.18 以上**（tsc を選んで起動する小さなラッパーが使います）

### 導入

マーケットプレイスを追加していなければ、先に追加します（手順は opencode プラグインの「導入」と同じです）。

```bash
/plugin install typescript7-lsp@cc-extensions
/reload-plugins
```

標準の `typescript-lsp` が有効なままだと、同じ拡張子には先に登録されたほうのサーバーだけが使われ、もう一方は使われません。
先に登録されたサーバーが起動に失敗しても、もう一方には切り替わりません。
どちらが先になるかは読み込み順で決まるので、使わないほうを無効にしてください。

- TypeScript 7 のリポジトリでは、標準のほうを無効にします。

  ```bash
  /plugin disable typescript-lsp@claude-plugins-official
  ```

- TypeScript 6 以下のリポジトリでは、このプラグインを無効にして標準を使います。
  このプラグインは、TypeScript 7 が見つからないと起動しません。

  ```bash
  /plugin disable typescript7-lsp@cc-extensions
  ```

プラグインの有効と無効はプロジェクトごとに切り替えられます（`--scope project` や `--scope local`）。

扱う拡張子は `.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs`、`.cjs` です。
サーバーは、対象の拡張子のファイルを Claude Code が最初に開いたときに起動します。

### どの tsc を使うか

起動のたびに、次の順で TypeScript 7 以上を探します。

1. 作業中のプロジェクトのディレクトリから親へたどり、最初に見つかった `node_modules/typescript`
2. 見つからなければ、プロジェクトの下2階層まで（`apps/web`、`packages/foo` のようなモノレポ）で、最も新しい TypeScript
3. それでも無ければ、PATH 上の `tsc`

TypeScript 7 以上が見つからなければ、サーバーは起動せず、理由を標準エラーに書いて終了します。
LSP ツールには「exit code 1 で終了した」とだけ返るので、理由は `claude --debug` のログで確認してください。
たとえば TypeScript 6.0.3 しかなければ、「needs TypeScript 7 or later」と、見つかった版と場所が出ます。

### 開発版を試す

リポジトリを取得したディレクトリで、プラグインを置いたまま Claude Code を起動します。
インストール済みの設定は変わりません。

```bash
claude --plugin-dir ./plugins/typescript7-lsp
```

## 開発

```bash
npm test
```

テストでは OpenCode を偽の実行ファイル（`tests/fake-opencode-fixture.mjs`）に置き換えます。
偽の実行ファイルは OpenCode と同じ規則で権限を判定する（後に書いた規則が優先され、`*` はワイルドカード）ので、読み取り専用エージェントで書き込みが拒否されることを自動テストで確かめられます。
pi プラグインの試験も、Pi を偽の実行ファイル（`tests/fake-pi-fixture.mjs`）に置き換えて動かします。

## 版の管理

`claude plugin update` は版が上がったときだけ、導入済みのプラグインを更新します。
版を上げずに `plugins/` の下を変えると、その変更は利用者に届きません。
そのため、`plugins/` の下を変える PR では必ず版を上げます。
テスト、CI、このリポジトリの README だけを変える PR では上げません。

版はこのマーケットプレイスの全プラグインでそろえて管理します。
片方のプラグインだけを変えたときも、両方の版が一緒に上がります。

版は `MAJOR.MINOR.PATCH` で、PR ごとに次の基準で上げます。

| 上げる桁 | 変更の例 |
| --- | --- |
| PATCH | 不具合の修正、メッセージやプロンプトの調整など、使い方が変わらない変更 |
| MINOR | コマンドやオプションの追加、既定の動作の変更など、使い方が増える・変わる変更 |
| MAJOR | オプションの削除や出力形式の変更など、今の使い方が動かなくなる変更 |

1.0.0 になるまでは、使い方が動かなくなる変更も MINOR で上げます。

版を上げるときは、`package.json`、各プラグインの `plugin.json`、`marketplace.json` の版をまとめて書き換える次のコマンドを使います。

```bash
npm run version:bump -- minor
```

続けて [CHANGELOG.md](CHANGELOG.md) に新しい版の節を足し、変更内容を PR 番号付きで書きます。
CI は、各ファイルの版がそろっているか、CHANGELOG に今の版の節があるか、`plugins/` の下を変えた PR で版が上がっているかを確かめます。
手元では `npm run version:check -- --base origin/main` で同じ確認ができます。

## ライセンス

Apache License 2.0。
openai/codex-plugin-cc（Copyright 2026 OpenAI、Apache-2.0）を元に変更を加えています。
変更内容は [NOTICE](NOTICE) を参照してください。
