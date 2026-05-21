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
- `src/commands.ts`: Command registrations (`resx.toggleExtension`, `resx.addLocale`, etc.).
- `src/types/resx.d.ts`: Type definitions for RESX data model and webview messages.
- `media/main.js`: Webview-side JavaScript (selection, editing, find/replace, zoom, context menu).
- `out/`: Transpiled JavaScript output.
- `images/`: Marketplace icon and screenshots.
- `package.json`: Activation events, commands, settings, and scripts.

## Build, Test, and Development Commands
- `npm install`: Install dependencies.
- `npm ci`: Clean, reproducible install (preferred in CI/local verification).
- `npm run compile`: TypeScript → `out/` via `tsc`.
- `npm run lint`: ESLint over `**/*.ts` using `eslint.config.mjs`.
- `npm test`: Compile, then run Node's test runner on `out/test`.
- `npm run package`: Create a `.vsix` using `vsce` (publish/build).

## Toolchain
- Use a modern Node runtime (recommended: Node 20 LTS).
- Prefer `npm ci` over `npm install` for deterministic dependency resolution.

## Mandatory Verification
- After any code change, run `npm run compile` before sending the final response.
- Skip this only for docs-only changes or when the user explicitly asks to skip compile.
- Run `npm test` when behavior changes.

## Dependency Policy
- Keep `package-lock.json` tracked in git.
- No XML parsing library needed (lightweight regex-based parser).
- `font-list` is a runtime dependency for the font-family picker command.

## User-Facing Change Sync
- When adding/changing commands or settings, update both `package.json` contributions and `README.md`.

## Coding Style & Naming Conventions
- Language: TypeScript with `strict` mode.
- Indentation: 2 spaces; include semicolons.
- ESLint: prefer `===`, require curly braces, no throwing literals.
- Filenames: `kebab-case` for new files; tests end with `.test.ts`.

## Security & Configuration
- Webview: escape all user data before injecting HTML; avoid `eval`/inline scripts.
- Settings: use `resx.*` keys declared in `package.json` and respect `resx.enabled`.
