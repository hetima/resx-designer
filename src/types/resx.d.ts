/**
 * A single resource entry inside a .resx file.
 * Only <data> elements are modelled (name, value, comment).
 */
export interface ResxEntry {
  name: string;
  value: string;
  comment: string;
}

/**
 * Represents one .resx file.
 * `locale` is `null` for the default (culture-invariant) file,
 * e.g. "Resources.resx" → locale = null, "Resources.ja.resx" → locale = "ja".
 */
export interface ResxDocument {
  /** Absolute file path */
  path: string;
  /** Locale tag extracted from the filename, or null for the default culture */
  locale: string | null;
  /** Ordered list of data entries */
  entries: ResxEntry[];
}

/**
 * A group of related .resx files that share the same base name.
 * Example: Resources.resx, Resources.ja.resx, Resources.fr.resx
 */
export interface ResxLocaleSet {
  /** Absolute directory path */
  baseDir: string;
  /** Base filename *without* locale suffix, e.g. "Resources.resx" */
  baseName: string;
  /** locale → document mapping (null locale key for the default file) */
  locales: Map<string | null, ResxDocument>;
}

/**
 * Column descriptor for the merged grid view.
 */
export type ResxColumnKind = 'index' | 'name' | 'comment' | 'locale' | 'action';

export interface ResxGridColumn {
  kind: ResxColumnKind;
  /** For locale columns this is the locale string; for others null */
  locale: string | null;
  /** Display label (header text) */
  label: string;
}

/**
 * A merged row in the grid: one resource key × all locales.
 */
export interface ResxGridRow {
  /** Shared resource name */
  name: string;
  /** Comment (taken from any locale – usually default) */
  comment: string;
  /** locale → value; missing locales are absent */
  values: Map<string | null, string>;
  /** Locales where this key is originally defined */
  definedIn: Set<string | null>;
}

/**
 * Message shapes exchanged between the webview and the extension host.
 */

/** Edit a single cell in the grid */
export interface WebviewEditCellMessage {
  type: 'editCell';
  row: number;
  col: number;
  value: string;
}

/** Replace multiple cells at once */
export interface WebviewReplaceCellsMessage {
  type: 'replaceCells';
  replacements: Array<{ row: number; col: number; value: string }>;
}

/** Delete a resource key by name (from action column menu) */
export interface WebviewDeleteKeyMessage {
  type: 'deleteKey';
  name: string;
  allFiles: boolean;
}

/** Rename a resource key */
export interface WebviewRenameKeyMessage {
  type: 'renameKey';
  row: number;
  newName: string;
}

/** Sort rows by name alphabetically */
export interface WebviewSortRowsMessage {
  type: 'sortRows';
  ascending: boolean;
}

/** Add a new locale column */
export interface WebviewAddLocaleMessage {
  type: 'addLocale';
  locale: string;
  fillDefaults: boolean;
}

/** Sort the current file's entries by name (dirty only, no immediate save) */
export interface WebviewSortCurrentFileMessage {
  type: 'sortCurrentFile';
  ascending: boolean;
}

/** Add a new resource key (row) by name */
export interface WebviewAddKeyMessage {
  type: 'addKey';
  name: string;
  addToAll: boolean;
  insertAfterIndex?: number;
}

/** Copy selected text to clipboard */
export interface WebviewCopyMessage {
  type: 'copyToClipboard';
  text: string;
}

/** Request find matches across all cells */
export interface WebviewFindMessage {
  type: 'findMatches';
  requestId: number;
  query: string;
  options: { regex: boolean; wholeWord: boolean; matchCase: boolean };
}

/** Open current file in default text editor */
export interface WebviewOpenAsTextMessage {
  type: 'openAsText';
}

/** Switch between Single and Multi view modes */
export interface WebviewSetViewModeMessage {
  type: 'setViewMode';
  mode: 'single' | 'multi';
}

/** Open bulk edit panel for a specific resource name */
export interface WebviewBulkEditMessage {
  type: 'bulkEdit';
  name: string;
}

/** Notify host which cell was right-clicked (for VSCode context menu commands) */
export interface WebviewSetContextCellMessage {
  type: 'setContextCell';
  row: number;
  col: number;
  isHeader: boolean;
  selectedRows: number[];
  name: string;
}

export type WebviewToHostMessage =
  | WebviewEditCellMessage
  | WebviewReplaceCellsMessage
  | WebviewDeleteKeyMessage
  | WebviewRenameKeyMessage
  | WebviewSortRowsMessage
  | WebviewSortCurrentFileMessage
  | WebviewAddLocaleMessage
  | WebviewAddKeyMessage
  | WebviewCopyMessage
  | WebviewFindMessage
  | WebviewOpenAsTextMessage
  | WebviewSetViewModeMessage
  | WebviewBulkEditMessage
  | WebviewSetContextCellMessage;

// ── Host → Webview messages ────────────────────────────────────

/** Result of addLocale operation */
export interface HostAddLocaleResultMessage {
  type: 'addLocaleResult';
  success: boolean;
  locale: string;
  message: string;
  openUri?: string;
}

/** Result of addKey operation */
export interface HostAddKeyResultMessage {
  type: 'addKeyResult';
  success: boolean;
  name: string;
  message: string;
  rowIndex: number;
}

export type HostToWebviewMessage = HostAddLocaleResultMessage | HostAddKeyResultMessage;

// ── Bulk Edit Custom Editor ──────────────────────────────────────

/** Message from bulk-edit webview: a cell was edited */
export interface BulkEditCellChangedMessage {
  type: 'cellChanged';
  locale: string | null;
  value: string;
}

/** Message from bulk-edit webview: user wants to save all pending edits */
export interface BulkEditSaveAllMessage {
  type: 'saveAll';
}

/** Message from bulk-edit webview: copy text to clipboard */
export interface BulkEditCopyMessage {
  type: 'copy';
  text: string;
}

/** Union of messages from the bulk-edit webview to the host */
export type BulkEditWebviewMessage = BulkEditCellChangedMessage | BulkEditSaveAllMessage | BulkEditCopyMessage;

/** Metadata stored in a .resxbulk temporary file (no values — always read from live files) */
export interface BulkEditTempFileMetadata {
  /** URI string of any .resx file in the locale set */
  sourceUri: string;
  /** The resource key being bulk-edited */
  keyName: string;
  /** True when the editor was closed gracefully (not a crash). */
  closed?: boolean;
}
