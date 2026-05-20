import * as vscode from 'vscode';

/**
 * Returns CSS custom-property declarations that map `--resx-*` and `--fr-*`
 * variables to the built-in `--vscode-*` variables automatically injected by
 * VS Code into every webview.
 *
 * A few values that need light/dark differentiated opacity use the resolved
 * ColorThemeKind from the extension host.
 */
export function getThemeCssVariables(): string {
  const kind = vscode.window.activeColorTheme.kind;
  const isDark =
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast;

  // These map directly to --vscode-* variables available in every webview.
  const lines: string[] = [
    `--resx-body:                var(--vscode-editor-background);`,
    `--resx-fg:                  var(--vscode-editor-foreground);`,
    `--resx-border:              var(--vscode-widget-border, var(--vscode-panel-border));`,
    `--resx-header-bg:           var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBarSectionHeader-background, var(--resx-body)));`,
    `--resx-toolbar-border:      var(--vscode-editorGroupHeader-tabsBorder, var(--resx-widget-border));`,
    `--resx-selected-bg:         var(--vscode-list-activeSelectionBackground);`,
    `--resx-hover-bg:            var(--vscode-list-hoverBackground);`,
    `--resx-highlight-bg:        var(--vscode-editor-lineHighlightBackground);`,
    `--resx-active-match-bg:     var(--vscode-editor-findMatchBackground);`,
    `--resx-missing-bg:          rgba(255, 170, 0, ${isDark ? 0.12 : 0.07});`,
    `--resx-missing-selected-bg: rgba(255, 170, 0, ${isDark ? 0.20 : 0.14});`,
    `--resx-btn-bg:              var(--vscode-button-background);`,
    `--resx-btn-fg:              var(--vscode-button-foreground);`,
    `--resx-btn-border:          var(--vscode-button-border);`,
    `--resx-btn-hover:           var(--vscode-button-hoverBackground);`,
    `--resx-input-bg:            var(--vscode-input-background);`,
    `--resx-input-fg:            var(--vscode-input-foreground);`,
    `--resx-input-border:        var(--vscode-input-border);`,
    `--resx-input-placeholder:   var(--vscode-input-placeholderForeground);`,
    `--resx-focus-border:        var(--vscode-focusBorder);`,
    `--resx-widget-bg:           var(--vscode-editorWidget-background);`,
    `--resx-widget-fg:           var(--vscode-editorWidget-foreground);`,
    `--resx-widget-border:       var(--vscode-editorWidget-border);`,
    `--resx-accent:              var(--vscode-button-secondaryBackground, var(--vscode-activityBarBadge-background));`,
    `--resx-index-fg:            var(--vscode-descriptionForeground);`,
  ];

  // Find-widget variables (derived from widget / input tokens)
  const frLines: string[] = [
    `--fr-bg:               var(--vscode-editorWidget-background);`,
    `--fr-border:           var(--vscode-editorWidget-border);`,

    `--fr-input-bg:         var(--vscode-input-background);`,
    `--fr-input-fg:         var(--vscode-input-foreground);`,
    `--fr-input-border:     var(--vscode-input-border);`,
    `--fr-input-placeholder: var(--vscode-input-placeholderForeground);`,
    `--fr-fg:               var(--vscode-editorWidget-foreground);`,
    `--fr-btn-fg:           var(--vscode-editorWidget-foreground);`,
    `--fr-btn-hover-bg:     var(--vscode-list-hoverBackground);`,
    `--fr-btn-pressed-color: var(--vscode-editorWidget-foreground);`,
    `--fr-toggle-active-color: var(--vscode-editorWidget-foreground);`,
    `--fr-status-fg:        var(--vscode-editorWidget-foreground);`,
    `--fr-divider:          var(--vscode-editorWidget-border);`,
    `--fr-input-focus-border: var(--vscode-focusBorder);`,
    `--fr-input-focus-shadow: 0 0 0 2px ${isDark ? 'rgba(0,127,212,0.3)' : 'rgba(0,122,204,0.3)'};`,
    `--fr-close-hover-bg:   var(--vscode-list-hoverBackground);`,
    `--fr-close-hover-fg:   var(--vscode-editorWidget-foreground);`,
    `--fr-divider-separator: var(--vscode-editorWidget-border);`,
  ];

  return [...lines, ...frLines].map(v => `    ${v}`).join('\n');
}
