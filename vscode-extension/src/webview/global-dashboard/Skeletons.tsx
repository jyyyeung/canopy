/**
 * Two tiny skeleton atoms. Used inline inside sections when their
 * async data hasn't arrived — the surrounding chrome (topbar,
 * section heads, sidebar) renders normally so the page doesn't reflow.
 *
 * Style guideline: barely-there. A 1-px line with a slow shimmer
 * sweep, single-colour, no card silhouettes, no chip explosions.
 * If you find yourself reaching for a third atom, it's probably the
 * wrong place — show actual data sourced from stateReader sync reads,
 * or the existing `.placeholder` italic muted text.
 */

/**
 * A thin underline-style placeholder. Default width is intentionally
 * narrow (50%) so the skeleton never spans the full container — that
 * reads "missing data" rather than "blank container."
 */
export function Shimmer({ width = "50%", style }: {
  width?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="skel-line"
      style={{ width, ...(style ?? {}) }}
      aria-hidden="true"
    />
  );
}

/**
 * Italic muted "loading…" text — for places where a label conveys
 * intent better than a graphic shimmer (rail sections, button rows).
 * Pure text; no animation.
 */
export function LoadingHint({ label = "loading" }: { label?: string }) {
  return <span className="loading-hint">{label}…</span>;
}
