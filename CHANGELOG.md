# 変更履歴

このマーケットプレイスのプラグインの版ごとの変更です。
プラグインの版はそろえて上げます。
版の上げ方は [README の「版の管理」](README.md#版の管理) を参照してください。

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
