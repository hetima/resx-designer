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
export type ResxColumnKind = 'index' | 'name' | 'comment' | 'locale';

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

/** Insert a new resource key (row) */
export interface WebviewInsertRowMessage {
  type: 'insertRow';
  index: number;
}

/** Delete resource keys (rows) */
export interface WebviewDeleteRowsMessage {
  type: 'deleteRows';
  indices: number[];
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

/** Replace matched cells */
export interface WebviewReplaceMatchesMessage {
  type: 'replaceMatches';
  requestId: number;
  replacements: Array<{ row: number; col: number; value: string }>;
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
  | WebviewInsertRowMessage
  | WebviewDeleteRowsMessage
  | WebviewRenameKeyMessage
  | WebviewSortRowsMessage
  | WebviewAddLocaleMessage
  | WebviewCopyMessage
  | WebviewFindMessage
  | WebviewReplaceMatchesMessage
  | WebviewOpenAsTextMessage
  | WebviewSetViewModeMessage
  | WebviewBulkEditMessage
  | WebviewSetContextCellMessage;
