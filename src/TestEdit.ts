import * as vscode from "vscode";
import { TableEditProvider } from "./table-edit";
import { getThemeCssVariables } from "./theme-colors";

/**
 * TestEdit — development sandbox for building the universal grid UI.
 *
 * Opens a standalone webview panel with dummy multi-column data.
 * No file I/O, no resx parsing — pure UI experimentation.
 *
 * Activate via "RESX: Test Edit" command.
 */

// ─── Dummy data (multi-column, like ResxEditor) ──────────────────

const DUMMY_COLUMNS = [
  {
    kind: "index" as const,
    locale: null,
    label: "#",
    editable: false,
    resizable: false,
    width: 40,
  },
  {
    kind: "action" as const,
    locale: null,
    label: "",
    editable: false,
    resizable: false,
    width: 24,
  },
  {
    kind: "name" as const,
    locale: null,
    label: "Name",
    editable: false,
    resizable: true,
    width: 100,
  },
  {
    kind: "comment" as const,
    locale: null,
    label: "Comment",
    editable: false,
    resizable: true,
    width: 180,
  },
  {
    kind: "locale" as const,
    locale: null,
    label: "default",
    editable: true,
    resizable: true,
    width: 200,
  },
  {
    kind: "locale" as const,
    locale: "ja",
    label: "ja",
    editable: true,
    resizable: true,
    width: 200,
  },
  {
    kind: "locale" as const,
    locale: "fr",
    label: "fr",
    editable: true,
    resizable: true,
    width: 200,
  },
  {
    kind: "locale" as const,
    locale: "de",
    label: "de",
    editable: true,
    resizable: true,
    width: 100,
  },
];

const DUMMY_ROWS = [
  {
    name: "Greeting0000",
    comment: "A friendly greeting",
    values: { null: "Hello", ja: "こんにちは", fr: "Bonjour", de: "Hallo" },
    menuTitle: "あいさつメッセージ",
    menu: [
      { id: "duplicate", label: "行を複製" },
      { id: "separator" },
      { id: "delete", label: "削除", danger: true },
    ],
  },
  {
    name: "Farewell",
    comment: "Saying goodbye",
    values: {
      null: "Goodbye",
      ja: "さようなら",
      fr: "Au revoir",
      de: "Auf Wiedersehen",
    },
    menu: [
      { id: "duplicate", label: "行を複製" },
      { id: "delete", label: "削除", danger: true },
    ],
  },
  {
    name: "Error_InvalidInput",
    comment: "Validation error",
    values: { null: "Invalid input.", ja: "入力が無効です。", fr: "", de: "" },
    menu: [{ id: "delete", label: "削除", danger: true }],
  },
  {
    name: "Button_Save",
    comment: "Save button label",
    values: {
      null: "&Save",
      ja: "保存(&S)",
      fr: "Enregistrer",
      de: "Speichern",
    },
    // menu なし → action-col クリックで何も表示しない
  },
  {
    name: "Button_Cancel",
    comment: "",
    values: {
      null: "&Cancel",
      ja: "キャンセル",
      fr: "Annuler",
      de: "Abbrechen",
    },
    // menu なし
  },
  {
    name: "Confirm_Delete",
    comment: "Multi-line\ntest",
    values: {
      null: "Are you sure\nyou want to delete?",
      ja: "",
      fr: "",
      de: "",
    },
    menu: [{ id: "delete", label: "削除", danger: true }],
  },
  {
    name: "Max_Length_Exceeded",
    comment:
      "This text is intentionally very long to test truncation behavior in the table cells. It should show an ellipsis when truncated and expand on click or edit.",
    values: {
      null: "This is a very long value that should be truncated when displayed in the cell. Click to expand.",
      ja: "これはセルに表示される際に切り捨てられるべき非常に長い値です。クリックして展開してください。",
      fr: "Ceci est une valeur très longue qui devrait être tronquée...",
      de: "Dies ist ein sehr langer Wert, der abgeschnitten werden sollte...",
    },
    menu: [
      { id: "duplicate", label: "行を複製" },
      { id: "delete", label: "削除", danger: true },
    ],
  },
];

export class TestEdit {
  public static readonly viewType = "resx.testEdit";
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Open (or reveal) the test edit panel. */
  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      TestEdit.viewType,
      "RESX Test Edit",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    const htmlProvider = new TableEditProvider({
      onDirtyChange: (dirty) => {
        console.log(`[TestEdit] dirty = ${dirty}`);
      },
    });
    this.panel.webview.html = htmlProvider.buildHtml(DUMMY_COLUMNS, DUMMY_ROWS);
    htmlProvider.attach(this.panel);

    // Handle webview messages
    const messageSub = this.panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg.type === "actionMenu") {
        const row = DUMMY_ROWS[msg.rowIdx];
        if (!row) return;
        const action = msg.actionId as string;
        if (action === "duplicate") {
          vscode.window.showInformationMessage(`Duplicate: ${row.name}`);
        } else if (action === "delete") {
          vscode.window.showWarningMessage(`Delete: ${row.name}`);
        }
      }
    });

    // Handle theme updates
    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      if (this.panel) {
        const themeVars = getThemeCssVariables();
        this.panel.webview.postMessage({
          type: "updateTheme",
          cssVars: themeVars,
        });
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      htmlProvider.dispose();
      messageSub.dispose();
      themeSub.dispose();
    });
  }
}
