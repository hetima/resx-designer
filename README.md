# resx-designer

Multi-language .NET resource (`.resx`) editor for VS Code. Edit all locale files simultaneously in a unified grid view. Based on [jonaraphael/csv](https://github.com/jonaraphael/csv)

## Features

- **Multi-language grid view** — Open a `.resx` file and see all related locales side by side: `Name | Comment | (default) | ja | en | fr | …`
- **Automatic locale detection** — Finds related `.resx` files in the same folder by naming convention (`Resources.resx`, `Resources.ja.resx`, `Resources.fr.resx`, …)
- **Missing translation highlighting** — Untranslated entries (empty or identical to the default value) are visually flagged
- **Edit & Navigate** — Quick edit, detail edit, keyboard navigation, multi-cell selection
- **Find & Replace** — Search across all cells with regex, case, and whole-word support
- **Zoom** — `Ctrl/Cmd + Mouse Wheel` or `Ctrl/Cmd + +/-/0`
- **Add new locales** — Create new `.resx` locale files directly from the editor
- **External change detection** — Automatically refreshes when related locale files are modified outside VS Code

## Getting Started

### 1. Install the Extension

- Open Visual Studio Code.
- Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS).
- Search for **resx-designer** and click **Install**.

### 2. Open a RESX File

- Open any `.resx` file. If related locale files exist in the same folder (same base name), they are automatically loaded as columns.

### 3. Edit and Navigate

- **Quick edit**: start typing on a selected cell. Press an Arrow key to save and move.
- **Detail edit**: press `Enter` or double‑click a cell for full caret control. `Shift+Enter` for line breaks. Click outside or press Arrow Up/Down to save and exit.
- **Keyboard Navigation**: Arrow keys to move, `Tab`/`Shift+Tab` for horizontal wrapping.
- **Multi-Cell Selection**: Click and drag or `Shift + Click`. `Ctrl/Cmd + C` to copy.
- **Find & Replace**: `Ctrl/Cmd + F` / `Ctrl/Cmd + H`.
- **Right-click context menu**: Add/delete rows, sort, add new locale.

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for:

| Command | Description |
|---|---|
| `RESX: Toggle Extension On/Off` | Enable or disable the custom editor |
| `RESX: Change Font Family` | Override the editor font |
| `RESX: Add New Locale` | Create a new `.resx` locale file |
| `RESX: Refresh Locale Files` | Re-scan the folder for locale files |
| `RESX: Sort Entries by Name` | Sort all rows A–Z across all locale files |

## Settings

All settings are scoped to the `resx.*` prefix.

| Setting | Type | Default | Description |
|---|---|---|---|
| `resx.enabled` | `boolean` | `true` | Enable/disable the custom editor |
| `resx.fontFamily` | `string` | *(inherit)* | Override font family |
| `resx.fontSize` | `number` | `0` | Override font size in px (`0` = inherit) |
| `resx.mouseWheelZoom` | `boolean` | `true` | Enable Ctrl/Cmd + scroll zoom |
| `resx.mouseWheelZoomInvert` | `boolean` | `false` | Invert zoom direction |
| `resx.cellPadding` | `number` | `4` | Cell vertical padding in px |
| `resx.highlightMissingTranslations` | `boolean` | `true` | Highlight untranslated cells |
| `resx.showSerialIndex` | `boolean` | `true` | Show `#` column |
| `resx.singleClickEdit` | `boolean` | `false` | Start editing on single click |
| `resx.maxFileSizeMB` | `number` | `10` | Soft file-size limit (`0` = unlimited) |

## Editing Shortcuts

| Shortcut | Action |
|---|---|
| Arrow keys | Navigate cells |
| `Tab` / `Shift+Tab` | Move right / left (wraps) |
| `Enter` | Enter detail edit mode |
| Any printable key | Enter quick edit mode |
| `Shift+Enter` | New line inside detail edit |
| `Ctrl/Cmd + C` | Copy selection |
| `Ctrl/Cmd + F` | Find |
| `Ctrl/Cmd + H` | Find & Replace |
| `F3` / `Shift+F3` | Next / previous find match |
| `Ctrl/Cmd + A` | Select all |
| `Ctrl/Cmd + +/-/0` | Zoom in / out / reset |
| `Ctrl/Cmd + Mouse Wheel` | Zoom |
| `Escape` | Close find/replace or cancel edit |

## Release Notes

See full history in `CHANGELOG.md`.

## Development

```bash
npm install
npm run compile
npm run lint
npm run package
```

## License

This extension is licensed under the [MIT License](LICENSE).
