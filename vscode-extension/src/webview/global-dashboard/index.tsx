/**
 * Webview entry — mounts the React tree into the panel's `<div id="root"/>`
 * and wires the controller's `data` messages into component state.
 *
 * Bundled to `dist/webview/global-dashboard.js` by esbuild
 * (`esbuild.config.mjs:globalDashboard`). The pastel palette + base styles
 * are inlined into the panel HTML by the controller, not bundled here, so
 * editing pastel.css doesn't require a webview rebuild.
 */
import { createRoot } from "react-dom/client";
import { Dashboard } from "./Dashboard";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<Dashboard />);
}
