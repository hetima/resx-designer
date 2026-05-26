# Repository Guidelines

Before making changes, agents should always review:
- `REVIEW.md` (current priorities and critical follow-ups)
- `README.md` (user-facing behavior and commands)
- `package.json` (activation, commands, settings)

## Project Structure & Module Organization
- `src/extension.ts`: Main VS Code extension (custom editor `resx.editor`, commands under `resx.*`).
- `src/ResxEditorProvider.ts`: Custom editor provider — reads .resx files, builds locale-set grid, manages webview.
- `src/resx-parser.ts`: Regex-based RESX XML parser (`<data>` → `ResxEntry[]`).
- `src/resx-writer.ts`: RESX XML serializer (`.resx` schema-compliant output).
- `src/resx-locale-finder.ts`: Discovers related locale files (e.g. `Resources.ja.resx`, `Resources.fr.resx`).
- `src/resx-config.ts`: Shared helpers for `resx.defaultResx` setting — `normalizeDefaultResxList()` and `isDefaultResx()`. The setting accepts `string | string[]` and falls back to `Strings.resx` when unconfigured.
- `src/commands.ts`: Command registrations (`resx.addLocale`, `resx.sortByName`, etc.).
- `src/types/resx.d.ts`: Type definitions for RESX data model and webview messages.
- `src/webview/index.js`: Webview entry point — initializes theme, state persistence, toolbar, and host message handler.
- `src/webview/shared.js`: Shared dependencies for webview modules — vscode API, DOM refs, config constants, cell helpers.
- `src/webview/state.js`: State management — zoom, column/row sizes, persistence (`persistState`, `restoreState`).
- `src/webview/selection.js`: Selection engine — cell select, edit engine, navigation, copy.
- `src/webview/mouse.js`: Mouse handlers — drag selection, column resize, action menu.
- `src/webview/commands.js`: Keyboard handlers — shortcuts, navigation keys, editing keys.
- `src/webview/find.js`: Find & Replace widget UI.
- `src/webview/dialogs.js`: Dialogs — Add Language, Add Key, Insert Key, Delete Key.
- `media/main.js`: **esbuild output** — do not edit directly. Built from `src/webview/index.js` (bundles all `src/webview/*.js` modules).
- `out/`: Transpiled JavaScript output.
- `images/`: Marketplace icon and screenshots.
- `package.json`: Activation events, commands, settings, and scripts.

## Build, Test, and Development Commands
- `pnpm install`: Install dependencies.
- `pnpm ci`: Clean, reproducible install (preferred in CI/local verification).
- `pnpm run compile`: TypeScript → `out/` via `tsc`.
- `pnpm run build:webview`: esbuild bundles `src/webview/index.js` → `media/main.js` (minified + sourcemap).
- `pnpm run watch:webview`: esbuild watch mode for webview source (auto-rebuild on change).
- `pnpm run lint`: ESLint over `**/*.ts` using `eslint.config.mjs`.
- `pnpm test`: Compile, then run Node's test runner on `out/test`.
- `pnpm run package`: Create a `.vsix` using `vsce` (publish/build).

## Toolchain
- Use a modern Node runtime (recommended: Node 20 LTS).
- Prefer `pnpm ci` over `pnpm install` for deterministic dependency resolution.

## Mandatory Verification
- After any code change, run `pnpm run compile` before sending the final response.
- Skip this only for docs-only changes or when the user explicitly asks to skip compile.
- When editing webview source (`src/webview/*.js`), also run `pnpm run build:webview` to rebuild `media/main.js`.
- Run `pnpm test` when behavior changes.

## Dependency Policy
- Keep `package-lock.json` tracked in git.
- No XML parsing library needed (lightweight regex-based parser).

## User-Facing Change Sync
- When adding/changing commands or settings, update both `package.json` contributions and `README.md`.

## Coding Style & Naming Conventions
- Language: TypeScript with `strict` mode.
- Indentation: 2 spaces; include semicolons.
- ESLint: prefer `===`, require curly braces, no throwing literals.
- Filenames: `kebab-case` for new files; tests end with `.test.ts`.

## Security & Configuration
- Webview: escape all user data before injecting HTML; avoid `eval`/inline scripts.
- `media/main.js` is a generated artifact — always edit `src/webview/*.js` and rebuild.
- Settings: use `resx.*` keys declared in `package.json` and respect `resx.editorType`.
