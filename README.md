# resx-designer

Multi-language .NET resource (`.resx`) editor for VS Code. Edit locale files in a unified grid view. 

## Features

### Automatically sync Designer.cs

Designer.cs is synchronized automatically whenever you add or remove keys in Strings.resx. It also updates when saved by AI! You no longer need to run ResXFileCodeGenerator manually.

**Regarding the namespace for newly created files**: If a Designer.cs file already exists, its current configuration will be reused. However, for a newly created file, the namespace is automatically generated from the workspace name and folder structure. In this case, please open the file and verify if it matches your project. You will need to check two places: the very top of the file and around line 20. Once you modify and save the file, the extension will read and preserve those custom values for subsequent updates.

### Batch Edit Identical Names

Provides a custom window to extract and edit a single name across all languages. No need to deal with a massive cell matrix. Right-click a row and select "Bulk Edit".

### All Keys across All Languages

"But what if I still need a massive cell matrix ?"  
Of course, we've got you covered. Select "Multi View" from the UI.

### Other Features

- **Automatic locale detection** — Finds related `.resx` files in the same folder by naming convention (`Resources.resx`, `Resources.ja.resx`, `Resources.fr.resx`, …)
- **Missing translation highlighting** — Untranslated entries (empty or identical to the default value) are visually flagged
- **Switch to Normal Editor** — Please press "Open as Text".


## Getting Started

### 1. Install the Extension

- Open Visual Studio Code.
- Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS).
- Search for **resx-designer** and click **Install**.

### 2. Setup Required

Open your workspace and set the default `Strings.resx` first. Right-click `Strings.resx` in the Explorer panel and run `RESX: Set as Default resx`. (Saved in `.vscode/settings.json`)

Note: Functions such as Designer.cs syncing depend on this default file. Auto-detection is currently not available, so this manual setup is strictly required.

![Screenshot](images/screenshot01.png)


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
| `resx.showSerialIndex` | `boolean` | `true` | Show index number column |
| `resx.singleClickEdit` | `boolean` | `false` | Start editing on single click |
| `resx.maxFileSizeMB` | `number` | `10` | Soft file-size limit (`0` = unlimited) |


## Roadmap

- [ ] Add new locales — Create new `.resx` locale files directly from the editor


## Release Notes

See full history in `CHANGELOG.md`.

## Development

```bash
npm install
npm run compile
npm run package
```

## License

This extension is licensed under the MIT License.


This program is based on  [jonaraphael/csv](https://github.com/jonaraphael/csv)
