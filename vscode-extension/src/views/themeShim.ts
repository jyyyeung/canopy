/**
 * Theme shim — bridges the existing `webview/themes/<name>.ts` token files
 * (used by the legacy cockpit / per-feature dashboard) to the new pastel
 * dashboard's CSS-variable contract.
 *
 * `pastel.css` is the single source of layout: every selector references
 * variables like `--paper` / `--ink` / `--canonical`. Switching the
 * theme means redefining those variables — not rewriting the selectors.
 * This module renders a small `:root { ... }` override sourced from the
 * matching `ThemeTokens`, so adding a third theme only means adding a
 * new tokens file (no CSS duplication).
 */
import { type ThemeTokens, getTheme } from "../webview/themes";

/**
 * Render the `:root` override that maps a `ThemeTokens` palette onto
 * pastel.css's variable names. Returns an empty string when ``themeName``
 * is "pastel" (or unknown — pastel.css's own `:root` block is the
 * source of truth there).
 */
export function renderThemeOverride(themeName: string): string {
  if (themeName === "pastel") return "";
  const tokens = getTheme(themeName);
  return _overrideFromTokens(tokens);
}

function _overrideFromTokens(t: ThemeTokens): string {
  const c = t.colors;
  // The pastel selectors use a wider colour vocabulary (per-slot tints
  // for the canonical/warm/cold/hot/info/bot families) than the
  // minimal/navy tokens carry. We map each pastel variable to the
  // closest available token; the *-soft / *-tint shades fall back to
  // the same colour with reduced opacity (using the existing -soft
  // tokens which are already 1f-suffixed in the legacy themes).
  return `
:root {
  /* surfaces */
  --paper:        ${c.bg};
  --surface:      ${c.bgElev};
  --surface-2:    ${c.bgElev2};
  --surface-3:    ${c.bgElev3};

  /* lines */
  --hairline:     ${c.borderSoft};
  --rule:         ${c.border};
  --rule-strong:  ${c.border};

  /* text */
  --ink:          ${c.fg};
  --ink-soft:     ${c.fgMuted};
  --ink-muted:    ${c.fgMuted};
  --ink-dim:      ${c.fgDim};

  /* slot accents — colour as text only, fill via -soft (alpha) */
  --canonical:     ${c.ok};
  --canonical-soft:${c.okSoft};
  --canonical-tint:${c.okSoft};

  --warm:         ${c.warn};
  --warm-soft:    ${c.warnSoft};
  --warm-tint:    ${c.warnSoft};

  --cold:         ${c.bot};
  --cold-soft:    ${c.botSoft};
  --cold-tint:    ${c.botSoft};

  /* status accents */
  --hot:          ${c.hot};
  --hot-soft:     ${c.hotSoft};
  --hot-tint:     ${c.hotSoft};

  --info:         ${c.accent};
  --info-soft:    ${c.accentSoft};
  --info-tint:    ${c.accentSoft};

  --bot:          ${c.bot};
  --bot-soft:     ${c.botSoft};
  --bot-tint:     ${c.botSoft};

  /* shadows — flatten in dark themes; the pastel cream casts shadows,
     monochrome dark surfaces don't need them */
  --shadow-sm:    none;
  --shadow-md:    none;
  --shadow-lg:    0 4px 12px rgba(0, 0, 0, 0.4);

  /* diff colours — mapped to ok/hot families on a dark surface */
  --diff-add-bg:  ${c.okSoft};
  --diff-add-fg:  ${c.ok};
  --diff-del-bg:  ${c.hotSoft};
  --diff-del-fg:  ${c.hot};
  --diff-ctx-fg:  ${c.fgMuted};
  --diff-hunk-bg: ${c.bgElev};
  --diff-hunk-fg: ${c.fgDim};
}

/* Override the gradient-y / shadow-heavy bits of pastel that read as
   "bright cream paper" — keep dark themes flat. */
.focus,
.standby-card {
  background: transparent !important;
}
.layout, .layout.feature, .triage, .layout.feature .rail {
  background: var(--paper) !important;
}
button.btn.primary,
button.action-btn.primary {
  background: var(--ink); border-color: var(--ink); color: var(--paper);
}
button.btn.primary:hover,
button.action-btn.primary:hover { background: #fff; }
.crumb .leaf { background: transparent; border: 1px solid var(--canonical-soft); color: var(--canonical); }
`.trim();
}
