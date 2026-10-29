# decision-router

Claude Code 用のローカル判断モデル連携プラグインです。モデル非依存の名前にしていますが、現在の判断プロバイダーは `d1-route`（Liquid AI d1-2B Q8_0、llama.cpp Vulkan）です。

## 自動判定

Claude Code が Bash 経由で `orca-worker-start` を呼ぶ直前だけ、`PreToolUse` フックが動きます。初回は `d1-route` に作業区分・推論量・リスクを問い合わせ、コマンドを一度停止して助言を Claude へ返します。同一セッション内で同じ Dispatch を再試行すると、30分間はキャッシュから判定済みと判断し、そのまま通常の起動検査へ進みます。Dispatch の同一性はセッション・作業ディレクトリ・name・task・followup・title・reason・`--spec-file` の内容で決まり、モデルや effort の指定は含みません。指示書の内容が変われば別の Dispatch として判定します。

- 判定結果は **助言**。ユーザー指定、モデル適性、利用枠、`agent-model-check`、`orca-worker-start` の安全検査を上書きしません。
- d1 停止・CLI 未導入・タイムアウト・異常応答なら **fail-open**。従来のルールに従って起動を続けられます。`ok`・`kind`・`effort`・`risk`・`suggested_agent` が揃わない応答は異常として扱います。`suggested_agent` は現在の正規値 `pi`・`codex`・`claude` だけを受け付けます。
- ローカル d1 は 4096 トークンの文脈で動くため、モデルへ渡す要約は最大 3000 文字に切り詰めます。日本語では 3000 字で約 2200 トークン、固定プロンプト約 300 トークンという実測に基づく目安で、他の文字種やサーバー設定での収まりは保証しません。切り詰めた場合は助言に `input_truncated=true` と末尾が未評価である旨を明示し、`risk=low` は `medium` として返します。長い指示書でも助言自体は返しますが、末尾の条件は判定に含まれません。
- `--spec-file` が 64KB 超・非ファイル・読取失敗・空のときは、その指示書を判定に含めず `input_incomplete=true` として明示し、`risk=low` は `medium` として返します。読めない指示書を完全な根拠にしません。
- `--spec-file` はローカルの通常ファイルから短く読み、モデルへ渡します。シェル文字列を実行・展開しません。
- ローカル判断APIは `127.0.0.1` のみ。キーや追加の課金プロバイダーは不要です。
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

`scripts/pretool-hook.mjs` がClaude Codeイベントを読み、`scripts/decision-router.mjs` が対象コマンドの判定、重複回避、プロバイダー呼び出しを行います。状態ファイルは `~/.cache/cc-extensions/decision-router` 下に保存し、モデルの入力文はキャッシュせず、検証済みの `kind`・`suggested_agent`・`effort`・`risk` だけを保存します。コマンド文字列・作業本文・秘密は保存しません。
