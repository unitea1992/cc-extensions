# decision-router

Claude Code 用のローカル判断モデル連携プラグインです。モデル非依存の名前にしていますが、現在の判断プロバイダーは `d1-route`（Liquid AI d1-2B Q8_0、llama.cpp Vulkan）です。

## 自動判定

Claude Code が Bash 経由で `orca-worker-start` を呼ぶ直前だけ、`PreToolUse` フックが動きます。初回は `d1-route` に作業区分・推論量・リスクを問い合わせ、コマンドを一度停止して助言を Claude へ返します。同一セッション内で同じ Dispatch を再試行すると、30分間はキャッシュから判定済みと判断し、そのまま通常の起動検査へ進みます。Dispatch の同一性はセッション・作業ディレクトリ・name・task・followup・title・reason・`--spec-file` の内容で決まり、モデルや effort の指定は含みません。指示書の内容が変われば別の Dispatch として判定します。

- 判定結果は **助言**。ユーザー指定、モデル適性、利用枠、`agent-model-check`、`orca-worker-start` の安全検査を上書きしません。
- d1 停止・CLI 未導入・タイムアウト・異常応答なら **fail-open**。従来のルールに従って起動を続けられます。`ok`・`kind`・`effort`・`risk`・`suggested_agent` が揃わない応答は異常として扱います。`suggested_agent` は現在の正規値 `pi`・`codex`・`claude` だけを受け付けます。CLI 未導入のときは何も表示せず、それ以外の失敗では助言を出さずに `systemMessage` で fail-open を表示します。
- llama.cpp は d1 の質問を 1 バッチで読むため、`/v1/systemone` はサーバーの `-b`/`-ub` を超える入力を HTTP 500 で拒否します。`d1-route` の前置きとテンプレート・質問文で 131 トークン（バッチ上限と受理された最大入力の差として実測）を使うので、既定のサーバー（`-ub` 512）では 512 − 131 − 余裕 24 = 357 トークンまで収まります。モデルへ渡す要約はローカル tokenizer で測って最大 357 トークンに収めます。サーバーを `-b`/`-ub` 8192 で動かしている場合は `DECISION_ROUTER_MAX_TASK_TOKENS`（64〜4096）で上限を上げられます。範囲外・非整数の値は警告を出さず既定 357 に戻ります。上限を変えると同一 Dispatch も別判定として扱われ、古い助言を再利用しません。実測では指示文 1400 トークンで 3.1 秒、1700 トークンで 3.9 秒なので、1200 程度までが 4 秒予算に収まります。文字数の上限ではないので、全角・珍しい漢字・絵文字でも入力を実測してから切ります。切り詰めるときは先頭と末尾を残して途中を省きます。助言には `input_truncated=true` と途中が未評価である旨を明示し、`risk=low` は `medium` として返します。tokenizer に届かないときは UTF-8 のバイト数（トークン数以上）で保守的に切り、上限を保証します。
- 判定に使う全文（切り詰める前）を、本番・デプロイ・課金・削除・秘密などの高リスク語で決定的に走査します。該当すれば `risk=high`・`effort=high` に引き上げます。長い指示書の途中で落ちた条件を見逃さないための床で、モデルの判定を下げることはありません。
- `--spec-file` が 64KB 超・非ファイル・読取失敗・空のときは、その指示書を判定に含めず `input_incomplete=true` として明示し、`risk=low` は `medium` として返します。読めない指示書を完全な根拠にしません。
- `--spec-file` はローカルの通常ファイルから読み、モデルへ渡します。シェル文字列を実行・展開しません。
- ローカル判断APIと tokenizer（`127.0.0.1:18991`）のみを使います。キーや追加の課金プロバイダーは不要です。`DECISION_ROUTER_TOKENIZER_URL` はループバック以外を受け付けません。
- 特定の Bash 起動経路以外（Orca GUI、Claude以外のエージェント、ラッパースクリプト内部の起動）にはフックしません。CLI単位の厳密な全経路強制は別の機構が必要です。

## 導入

```text
/plugin marketplace add unitea1992/cc-extensions
/plugin install decision-router@cc-extensions
/reload-plugins
/decision-router:status
```

通常のサブスクリプション認証には影響しません。ローカル `d1-route` コマンドが PATH にある場合のみ推論します。必要なら環境変数 `DECISION_ROUTER_PROVIDER_BIN` で実行ファイルを指定できます。

## 停止

`/plugin uninstall decision-router@cc-extensions` でClaude側の自動フックを取り外せます。モデルサービスはこのプラグインの管理外です。

## 実装

`scripts/pretool-hook.mjs` がClaude Codeイベントを読み、`scripts/decision-router.mjs` が対象コマンドの判定、入力の計測と切り詰め、重複回避、プロバイダー呼び出しを行います。`scripts/tokenize-count.mjs` はローカル tokenizer にだけ問い合わせます。状態ファイルは `~/.cache/cc-extensions/decision-router` 下に保存し、モデルの入力文はキャッシュせず、検証済みの `kind`・`suggested_agent`・`effort`・`risk` だけを保存します。コマンド文字列・作業本文・秘密は保存しません。
