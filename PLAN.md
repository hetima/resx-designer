# Plan: BulkEdit を拡張して ResxEditor に統合

プロジェクトファイルパス： C:\Users\win\source\repos\resx-designer

BulkEditCustomEditorProvider を「汎用編集可能グリッド」に拡張した上で、ResxEditor の webview を BulkEdit のインラインJS方式に移行する。

## 全体の流れ

```
TestEdit（独立サンドボックス）← 現在ここ
  ↓ ステップバイステップで機能実装
BulkEdit（既存の実プロバイダ）
  ↓ 移植して動作確認・修正
ResxEditor（最終移行先）
  ↓ 移植して動作確認・修正
  ↓
src/webview/*.js 削除
```

## 実装済み

### TestEdit サンドボックス ✅
- `src/TestEditProvider.ts` を作成 — BulkEdit をベースに独立開発用webview
- `commands: ["resx.testEdit"]` でパレットから開ける
- ダミーデータ: 7行 × 8列（index, action, name, comment, default, ja, fr, de）
- 機能: 単一選択（.selected class）、contentEditable編集、↑↓←→ナビゲーション、Enter/Tab、Escape revert、Ctrl+C copy
- テーマ対応: updateTheme メッセージ
- singleClickEdit 設定対応

---

## フェーズ1: TestEdit で機能実装（ステップバイステップ）

TestEditProvider.ts のインラインHTML/CSS/JSを拡張し、ResxEditor が持つ機能を順次取り込む。

| ステップ | 内容 | 状態 |
|---------|------|------|
| 1-B | 列ごとの editing 制御（data-readonly で編集不可セル） | ✅ |
| 1-D | ナビゲーション拡張（←→ で列間移動、index/action スキップ） | ✅ |
| 1-E | Action menu（⋮） | ⬜ |
| 1-F | Toolbar（+ New Lang, + New Key, Sort, View Mode 等） | ⬜ |
| 1-G | Dialogs（Add Language, Add Key） | ⬜ |
| 1-H | Find & Replace UI 枠（ハイライトロジックは後） | ⬜ |
| 1-I | コピー機能 | ✅ |
| 1-J | 検索機能 | ⬜ |

### 各ステップの詳細

#### 1-B: 列ごとの editing 制御
- `editable` 属性で列・セル単位に編集不可を指定
- `singleClickEdit` 設定との兼ね合い: readonly列は singleClickEdit にも反応しない

#### 1-E: Action menu（⋮）
- `action-col` の ⋮ クリック → ポップアップメニュー表示
- メニュー項目: Bulk Edit, Insert Below, Delete
- `setContextCell` メッセージ送信（VS Code コンテキストメニュー連携）
- TestEdit では console.log でメッセージ出力のみ

#### 1-F: Toolbar
- HTML に toolbar `<div>` を追加
- ボタン: + New Lang, + New Key, Sort A-Z, View Mode, Open as Text
- 各ボタンは `vscode.postMessage()` でバックエンドに通知
- TestEdit では console.log でメッセージ出力のみ

#### 1-G: Dialogs（Add Language, Add Key）
- インラインJSでダイアログHTMLを動的生成
- Add Language: ロケール入力 + Fill Defaults チェックボックス + OK/Cancel
- Add Key: キー名入力 + Add to All Languages チェックボックス + OK/Cancel
- メッセージ: `addLocale`, `addKey` → `addLocaleResult`, `addKeyResult` で結果表示

#### 1-H: Find UI
- 置き換え機能は不要
- Find widget HTML（`#findReplaceWidget`）を追加
- toolbarに直接置いても良いかもしれない
- 入力欄 + Aa/ab/.* トグル + ↑↓✕ ボタン
- `findMatches` メッセージ送信 → `findMatchesResult` でハイライト
- ハイライト描画ロジックは後で実装


#### 1-J: 検索機能

---

## フェーズ2: BulkEdit に移植 + 動作確認

TestEdit で実装した機能を BulkEditCustomEditorProvider.ts に移植。

- BulkEdit の既存動作を壊さないよう注意
- ファイルI/O（保存・リバート）の動作確認
- `singleClickEdit` 設定との整合性

---

## フェーズ3: ResxEditor に移行 + 動作確認

BulkEdit が「汎用グリッド」になった時点で、ResxEditor の移行を大幅に単純化。

### 3-A: ResxEditorProvider の改修
- `gridRows` 全データ + `columns` JSON を webview に渡す
- `generateTableHtml()` を削除 → JS 側でテーブル生成
- CSS は既存の ResxEditor CSS を維持

### 3-B: ResxEditorController の調整
- `handleWebviewMessage()`: メッセージ型は変更不要
- `handleEditCell()`: 列メタデータに基づく処理はそのまま

---

## フェーズ4: クリーンアップ + 検証

1. `src/webview/*.js`（8ファイル）全削除
2. `media/main.js` / `media/main.js.map` 削除
3. `package.json` から `build:webview`, `watch:webview` スクリプト削除
4. `localResourceRoots` から不要なパスを整理
5. 検証: `npm run compile && npm run lint && npm test`

---

## 決定事項

- うまく動かないときはアドホックな修正でなく、汎用性を考慮して修正する
- 複数選択（Shift+クリック、ドラッグ範囲）は廃止
- 列リサイズ: フェーズ1では未実装
- State persistence / Zoom: フェーズ1では未実装
- Find ハイライト描画: UI枠だけ実装、ロジックは後で

## 除外スコープ

- 列リサイズのドラッグ機能 — 後で対応
- State persistence（zoom, scroll, column sizes）— 後で対応
- Ctrl+A 全選択 — 複数選択廃止に伴い削除
