# **resx-desiner**


---

## Screenshots

![Dark Theme Screenshot](images/Screenshot_dark.png)
![Light Theme Screenshot](images/Screenshot_light.png)

---


---

## Features


---


## Getting Started

### 1. Install the Extension

- Open Visual Studio Code.
- Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS).
- Search for **resx-designer** and click **Install**.

### 2. Open a RESX File

- The file will automatically load, presenting your data in an interactive grid view.

### 3. Edit and Navigate

- **Edit Modes:**
  - Quick edit: start typing any character to edit the selected cell immediately. Press any Arrow key to save and move the selection to the next cell in that direction.
  - Detail edit: press `Enter` on a selected cell or double‑click to enter a focused edit. Arrow Left/Right move the text caret; Arrow Up goes to start; Arrow Down goes to end. Click outside the cell (or blur) to save.
- **Keyboard Navigation:** Use Arrow keys to move between cells when not editing. Use `Tab`/`Shift+Tab` to move horizontally (wrapping across rows as needed).
- **Multi-Cell Selection:** Click and drag or use `Shift + Click` to select multiple cells, then copy them as CSV using `Ctrl/Cmd + C`.
- **Find & Replace:** Press `Ctrl/Cmd + F` to open Find, or `Ctrl/Cmd + H` to open Find + Replace.

---

## Commands

Open the Command Palette and search for:

- `RESX: Toggle Extension On/Off` (`csv.toggleExtension`)
  

## Settings

Global (Settings UI or `settings.json`):

- `resx.enabled` (boolean, default `true`): Enable/disable the custom editor.
- `resx.fontFamily` (string, default empty): Override font family; falls back to `editor.fontFamily`.
- `resx.fontSize` (number, default `0`): Override font size in px; set to `0` to inherit `editor.fontSize`.
- `resx.mouseWheelZoom` (boolean, default `true`): Enable `Ctrl/Cmd + Mouse Wheel` zooming in the resx editor.
- `resx.mouseWheelZoomInvert` (boolean, default `false`): Invert the `Ctrl/Cmd + Mouse Wheel` zoom direction.
- `resx.cellPadding` (number, default `4`): Vertical cell padding in pixels.
- `resx.columnColorMode` (string, default `type`): `type` keeps resx’s type-based column colors; `theme` uses your theme foreground color for all columns.
- `resx.columnColorPalette` (string, default `default`): Type-color palette when `resx.columnColorMode` is `type`. `cool` biases colors toward greens/blues; `warm` biases colors toward oranges/reds.
- `resx.diffUseThemeForeground` (boolean, default `true`): In compare/diff views, use theme foreground color so diff highlighting remains readable.
- `resx.clickableLinks` (boolean, default `true`): Make URLs in cells clickable. Ctrl/Cmd+click to open links.
- `resx.showTrailingEmptyRow` (boolean, default `true`): Show the extra empty row at the end of the table. Turn this off to hide that visual append row.
- `resx.separatorMode` (string, default `extension`): Separator selection mode when no per-file override exists. `extension` uses extension mapping, `auto` detects from content first, `default` always uses `resx.defaultSeparator`.
- `resx.defaultSeparator` (string, default `,`): Fallback separator. Use `\\t` in `settings.json` for tabs.
- `resx.maxFileSizeMB` (number, default `10`): Soft limit for opening files in resx view. If exceeded, resx prompts: `Cancel`, `Continue This Time`, or `Ignore Forever` (sets this setting to `0`).

Per-file (stored by the extension; set via commands):

---

## Editing Modes and Shortcuts

- Quick edit:
  - Start: type any character (not Enter) on a selected cell.
  - Save and move: press Arrow Up/Down/Left/Right to save and select the adjacent cell; does not re-enter edit.
- Detail edit:
  - Start: press `Enter` on a selected cell or double‑click a cell.
  - Caret navigation: Arrow Left/Right move one character; Arrow Up moves caret to start; Arrow Down moves caret to end.
  - New line in cell: `Shift + Enter` inserts a line break inside the current cell.
  - Exit/save: click outside the cell or move focus to commit changes.
- Global:
  - Copy selection: `Ctrl/Cmd + C`
  - Paste selection: `Ctrl/Cmd + V` (selection mode). Pasting a single value into a selected rectangle fills that rectangle.
  - Zoom in/out/reset: `Ctrl/Cmd + +`, `Ctrl/Cmd + -`, `Ctrl/Cmd + 0` (also `Ctrl/Cmd + Mouse Wheel`)
  - Find: `Ctrl/Cmd + F`
  - Replace: `Ctrl/Cmd + H`
  - Next/Previous match: `F3` / `Shift + F3` (also `Enter` / `Shift + Enter` in the Find box)
  - Select all: `Ctrl/Cmd + A`

---

## Release Notes


See full history in `CHANGELOG.md`.

---

## Development

Clone the repository and run the following commands:

```bash
npm install
npm run lint
npm test
```

To create a VS Code extension package, run:

```bash
npm run package
```

To compile without running tests:

```bash
npm run compile
```


---

## License

This extension is licensed under the [MIT License](LICENSE).
