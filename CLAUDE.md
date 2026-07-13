# CLAUDE.md — ゆるスケ (yuru-suke)

## このプロジェクト

- 崩れた勉強計画を自動で引き直す、大学の学期用スタディプランナー（「記録」ではなく「再計画」のアプリ。旧名: たてなおし）
- 構成: 単一HTMLファイル（`index.html` にHTML/CSS/JSをすべて内包）＋ PWA用の manifest / sw.js / icons
- 管理情報: `C:\Users\smzyt\apps\dev-os\projects\yuru-suke\`（要件・設計・タスク・バグはそちらを参照）

## 開発標準

`C:\Users\smzyt\apps\dev-os\DEVELOPMENT_OS.md`（AI非依存の正典）の「全プロジェクト共通 開発標準」に従う。

## このプロジェクト固有のルール（重要）

- **設計原則「再計画はボタンではなく常時」を崩さない**: 割当（assignments）は保存せず、開くたびに planner が状態から導出する。割当を保存するコードを書かない（driftの温床）
- **planner / store / advisorValidate / parseTaskLines / buildICS は純関数のまま維持**: `// ==PLANNER-START==`〜`==UTIL-END==` のマーカーで区切られたブロックはDOM・localStorage 非依存を保つ。`tests/planner.test.mjs` がこのブロックを抽出してNodeで実行する
- **やること＝タスクがチェックリストの実体**: 締切(milestone)の下のタスク群がチェックリスト。専用のサブ項目データ構造は持たない（一情報一箇所）。締切種類別の初期タスクは `makeTemplateTasks`
- **.icsは片方向エクスポート専用**: buildICSは状態を読むだけ。ICSインポート（双方向同期）は設計外（OAuth/サーバーが必要になり完全ローカルの前提を壊す）
- **エンジンを触ったら必ず `node tests/planner.test.mjs`**（全通過するまで完了報告しない）
- **AIは事実を改変できない**: Gemini応答で書き換えられるのは可処分時間の上書きと見積もり分数のみ。完了状態・締切日を書き換え可能にする変更は禁止。適用前の差分プレビュー→本人承認の3段ガードを外さない
- APIキーをコードに書かない。キーは `yuru-suke.geminiKey`（状態の外）に置き、バックアップJSONに含めない
- 日付は `"YYYY-MM-DD"` 文字列で保持・比較。Dateオブジェクトを状態に持ち込まない
- localStorage スキーマ（`yuru-suke.state`）を変えるときは `store.migrate` にバージョン変換を書く。旧名キー `tatenaoshi.*` からの引き継ぎ読み込みを壊さない
- sw.js のキャッシュ名 `yuru-suke-v1` は、配信物の構成を変えたらバージョンを上げる

## 動作確認

- **編集後は必ず verify-single-html スキルで検証**。「編集できた」だけで完了報告しない
- エンジン変更時は `node tests/planner.test.mjs` も併走
- AI絡みの変更は、キー未設定/レート制限(429)/スキーマ検証失敗の3状態も確認する
