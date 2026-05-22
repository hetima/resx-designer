# Plan: BulkEdit を拡張して ResxEditor に統合

プロジェクトファイルパス： C:\Users\win\source\repos\resx-designer

BulkEditCustomEditorProvider を「汎用編集可能グリッド」に拡張した上で、ResxEditor の webview を BulkEdit のインラインJS方式に移行する。

実装は `src\table-edit.ts`。呼び出し方は `src\TestEdit.ts` を参考にする。

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
- `src/test-edit.ts` を作成 — BulkEdit をベースに独立開発用webview
- `commands: ["resx.testEdit"]` でパレットから `TestEdit.ts` 経由で開ける
- ダミーデータ: 7行 × 8列（index, action, name, comment, default, ja, fr, de）
- 機能: 単一選択（.selected class）、contentEditable編集、↑↓←→ナビゲーション、Enter/Tab、Escape revert、Ctrl+C copy
- テーマ対応: updateTheme メッセージ
- singleClickEdit 設定対応

---

## フェーズ1: TestEdit で機能実装（ステップバイステップ）

TableEditProvider.ts のインラインHTML/CSS/JSを拡張し、ResxEditor が持つ機能を順次取り込む。

| ステップ | 内容 | 状態 |
|---------|------|------|
| 1-E | Action menu（⋮） | ✅ |
| 1-F | Toolbar（+ New Lang, + New Key, Sort, View Mode 等） | ✅ |
| 1-G | Dialogs（Add Language, Add Key） | ⬜ |

### 各ステップの詳細

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

---

## フェーズ2: BulkEdit に移植 + 動作確認

BulkEdit.tsを作成。TestEditをベースにBulkEditCustomEditorProvider.ts の機能を移植。
vscodeからの接続をTestEdit.tsに切り替える。BulkEditCustomEditorProvider.tsはまだ残しておく

- BulkEdit の既存動作を壊さないよう注意
- ファイルI/O（保存・リバート）の動作確認
- `singleClickEdit` 設定との整合性

### ホットエグジット対応
- `BulkEdit.ts` は `extends TableEditProvider` + `implements vscode.CustomEditorProvider<BulkEditCustomDocument>` にする
- `backupCustomDocument()` で `getFullState()` を使い、snapshot を backup file に書き込み
- `restoreCustomDocument()` を**新規実装**: backup 内容を document に格納し、`resolveCustomEditor()` 後に `restoreFullState()` で webview に復元（旧実装には backup のみで restore 未実装だった）
- `CustomEditorProvider` なので backup/restore で**完全復元**（undo 履歴含む）

---

## フェーズ3: ResxEditor に移行 + 動作確認
ResxEdit.tsを作成TestEditをベースにResxEditorProvider.ts などの機能を移植。
vscodeからの接続をResxEdit.tsに切り替える。ResxEditorProvider.tsはまだ残しておく

### ホットエグジット対応
- `ResxEdit.ts` は `extends TableEditProvider` + `implements vscode.CustomTextEditorProvider` にする
- `CustomTextEditorProvider` なので VS Code が TextDocument の dirty/backup/restore を自動管理
- webview 再起動後（VS Code 再起動時など）: `resetDirty()` で snapshot を現在の TextDocument 内容に再設定（undo 履歴はクリア）
- セッション内の undo/redo は `retainContextWhenHidden: true` で保持される
-_dirtyイベントでホスト側が`applyEdit`を呼び出してTextDocumentをdirtyにする責務はderived側（ResxEdit.ts）が持つ
- モーダルダイアログへの対応

---

## フェーズ4: クリーンアップ + 検証

BulkEdit.tsとResxEdit.tsが完成したらもう使わない旧ファイルを削除

---

## 決定事項

- うまく動かないときはアドホックな修正でなく、汎用性を考慮して修正する
- State persistence / Zoom: フェーズ1では未実装

