# 変更履歴

`opencode` プラグインの版ごとの変更です。
版の上げ方は [README の「版の管理」](README.md#版の管理) を参照してください。

## 0.2.0

- OpenCode の専用サーバーが起動の途中で固まったら、45秒で止めて最大3回まで起動し直すようにした（#7）。
- OpenCode が何も出力しないまま `--idle-timeout`（既定600秒）が過ぎたら、実行を止めて理由付きの失敗として返すようにした。`/opencode:rescue` と `task` に `--idle-timeout` を追加した（#7）。
- `/opencode:setup` が、`--model` を省略したときに使うモデルを表示するようにした（#6）。
- レビュー結果の JSON にモデルが `$schema` キーを書き足しても、スキーマ違反の警告を出さないようにした（#5）。

## 0.1.0

- 最初の版。`/opencode:review`、`/opencode:adversarial-review`、`/opencode:rescue`、`/opencode:status`、`/opencode:result`、`/opencode:cancel`、`/opencode:setup` を収録。
