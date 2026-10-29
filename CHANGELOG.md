# 変更履歴

このマーケットプレイスのプラグインの版ごとの変更です。
プラグインの版はそろえて上げます。
版の上げ方は [CONTRIBUTING.md の「版の管理」](CONTRIBUTING.md#版の管理) を参照してください。

## 0.5.2

- `decision-router` の判定入力をローカル d1 の 4096 トークン文脈に合わせ最大 3000 文字へ切り詰め、長い指示書でも fail-open に落ちず助言を返すようにした（実測: 日本語 3000 字で約 2200 トークン、固定プロンプト約 300 トークン。文字種によっては収まりを保証しない）。切り詰め時は `input_truncated=true` と末尾未評価を明示し、`risk=low` は `medium` として返す。
- 同じ name・spec パスでも指示書の内容や title/reason が変わった Dispatch は別判定にし、30 分キャッシュが古い助言を流用しないようにした。モデル・effort だけを替えた再試行は従来どおり同じ判定を使う。
- プロバイダー応答は `kind`・`suggested_agent`・`effort`・`risk` を検証し、その4項目だけをキャッシュするようにした。`suggested_agent` は `pi`・`codex`・`claude` に限定し、入力本文・秘密・余分なフィールドは保存しない。契約に合わない応答は fail-open にする。引用符内の `;`・`|`・`&&` はコマンド区切りとして扱わず、引用されたコマンド置換も実行しない。
- 他のプラグインは中身を変えず、共通の版だけを上げた。

## 0.5.1

- Claude Codeの新規Orca Dispatch直前にローカル判断モデルへ問い合わせる `decision-router` プラグインを追加。Bashの`orca-worker-start`を検知し、最初の起動を一度停止して分類・effort・リスクの助言を返す。同一Dispatchの再試行はキャッシュで通す。モデル停止・異常時は従来どおり続行する。
- 既存の4プラグインは内容を変更せず、マーケットプレイスの共通版数だけ更新。

## 0.5.0

- DSH（DeepSeek Harness）を Claude Code から呼ぶ `dsh` プラグインを追加した（#18）。`/dsh:rescue`、`/dsh:status`、`/dsh:result`、`/dsh:cancel`、`/dsh:setup` を収録している。ジョブごとに `dst run --json` を起動し、モデルと推論量（effort）は同梱のパッチが `DSH_LAUNCH_PROVIDER` / `DSH_LAUNCH_MODEL` / `DSH_LAUNCH_EFFORT` 環境変数から渡す。読み取り専用（`--permission-mode read-only`）、再開（`--session-id`）、バックグラウンド実行、実行時間の上限（`--timeout`）に対応する。
- `dsh` プラグインのレビュー指摘を直した（#18）。ジョブ記録の50件上限と取り消し墓標の掃除が動くようにし、SessionEnd フックを cancel と同じ「印を先に付けてから pid を読む」順に揃え、`DSH_COMPANION_BIN` で名前を変えたランナーも止まるようにジョブに起動コマンド名を記録した。`--permission-mode` と `--write`/`--read-only` の併用をエラーにし、DSH がない環境では `/dsh:rescue` が空ではなく stderr のエラー（`/dsh:setup` の案内）を返すようにした。
- `opencode`・`pi`・`typescript7-lsp` の中身は変わらない。版をそろえて管理するため、版だけを上げた。

## 0.4.2

- 読み取り専用の実行でも Web 検索を使えるようにした（#17）。Pi は `--tools read,grep,find,ls` をやめて `--exclude-tools edit,write,bash,powershell` で書き換えとコマンドの道具だけを外し、OpenCode は `webfetch`・`websearch` を許す。`pi-rescue`・`opencode-rescue` は、書き換えのない調べものも書き込みありで流す。

## 0.4.1

- `pi-rescue` サブエージェントの指示文にあったモデル名の例を、一般的な `openai/gpt-5.5` に替えた（#14）。動作は変わらない。

## 0.4.0

- Pi を Claude Code から呼ぶ `pi` プラグインを追加した。`/pi:rescue`、`/pi:status`、`/pi:result`、`/pi:cancel`、`/pi:setup` を収録している。`pi --print --mode json` をジョブごとに起動し、書き込みあり・読み取り専用（`read,grep,find,ls` のみ）、再開、バックグラウンド実行、無出力タイムアウトに対応する。Pi には権限の仕組みがないので、作業ディレクトリの外にも書ける。
- `opencode` の `task` と `/opencode:rescue` に `--auto` を追加した。書き込みありの作業で、OpenCode の設定が明示的に拒否していない権限確認を自動で許可する。付けなければ従来どおり、作業ディレクトリの外への書き込みは確認が必要な操作として拒否される。読み取り専用の実行では何も変わらない。

## 0.3.0

- TypeScript 7 で動く TypeScript の言語サーバーを使う `typescript7-lsp` プラグインを追加した。`tsc --lsp --stdio` を起動し、ワークスペースの TypeScript 7 以上を優先して使う。標準の `typescript-lsp` が TypeScript 7 で「tsserver.js が無い」と言って終了する問題を避けられる。
- `opencode` プラグインの中身は変わらない。版をそろえて管理するため、版だけを上げた。

## 0.2.1

- `/opencode:status` の表で、セルの文字に含まれる `\` を先にエスケープし、`\|` が表の区切りとして解釈されて列がずれないようにした。

## 0.2.0

- OpenCode の専用サーバーが起動の途中で固まったら、45秒で止めて最大3回まで起動し直すようにした（#7）。
- OpenCode が何も出力しないまま `--idle-timeout`（既定600秒）が過ぎたら、実行を止めて理由付きの失敗として返すようにした。`/opencode:rescue` と `task` に `--idle-timeout` を追加した（#7）。
- `/opencode:setup` が、`--model` を省略したときに使うモデルを表示するようにした（#6）。
- レビュー結果の JSON にモデルが `$schema` キーを書き足しても、スキーマ違反の警告を出さないようにした（#5）。

## 0.1.0

- 最初の版。`/opencode:review`、`/opencode:adversarial-review`、`/opencode:rescue`、`/opencode:status`、`/opencode:result`、`/opencode:cancel`、`/opencode:setup` を収録。
