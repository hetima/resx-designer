Repository Review and Prioritized Recommendations

Scope: VS Code custom editor for RESX multi-language resources (`resx.editor`).

Priorities

P0 (Critical)
- Editor round-trip fidelity: Verify parse→edit→serialize preserves XML structure. Add tests for round-trip on real-world .resx files.
- Multi-locale sync integrity: Name/comment edits must propagate to ALL locale files atomically. Add tests for concurrent edit edge cases.
- Missing-translation detection: Verify the highlighting logic (empty value or value === default) is correct for all edge cases.

P1 (High)
- State persistence: Ensure scroll + selection restore across config changes and webview reloads.
- New locale creation: Verify the `resx.addLocale` command creates a valid .resx file with proper schema.
- External file change detection: Ensure file watchers correctly detect changes to related locale files.
- Undo/redo: VS Code's built-in undo (Ctrl+Z) should revert edits to the correct locale file.

P2 (Medium)
- CSP tightening: Replace `style-src 'unsafe-inline'` with nonce-only styles.
- Performance: Test with large RESX files (1000+ entries × 10+ locales).
- Sort persistence: Verify alphabetical sort correctly reorders entries in all locale files.
- Context menu Polish: Add "Copy Name" / "Copy Value" items to right-click menu.

Notes
- Regex-based RESX parser is intentionally lightweight; no external XML library dependency.
- UI features: cell editing (quick/detail modes), find/replace, zoom, context menu, multi-cell selection.
- Missing-translation highlighting detects empty values and values matching the default locale.

Local Verification
- Run locally:
  - `npm run lint`
  - `npm run compile`
  - `npm test`
