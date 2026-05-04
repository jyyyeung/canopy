/**
 * Minimal unified-diff parser for the feature dashboard.
 *
 * Splits an aggregated diff string into per-file blocks and per-block
 * hunks. Just enough structure to render the mockup's diff stack —
 * `+`/`-`/context lines + hunk headers + line numbers. Truncates long
 * hunks to keep the webview snappy; the user can expand.
 *
 * This is intentionally NOT a replacement for VS Code's diff viewer.
 * Click-through to native diff is the path for editing.
 */

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Repo name as labelled in the diff input (controller threads it in). */
  repo: string;
  oldPath: string;
  newPath: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when the file is binary; we render a stub for it. */
  binary: boolean;
}

/**
 * Parse a unified-diff string into per-file blocks. Accepts the output
 * of `git diff` (or canopy's aggregated equivalent). The optional
 * `repoTag` prepends every parsed file with the same repo name when the
 * diff is single-repo; multi-repo callers should slice by repo first.
 */
export function parseUnifiedDiff(text: string, repoTag = ""): DiffFile[] {
  if (!text) return [];
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  const finalize = () => {
    if (current) files.push(current);
    current = null;
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      finalize();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        repo: repoTag,
        oldPath: match?.[1] ?? "",
        newPath: match?.[2] ?? "",
        additions: 0,
        deletions: 0,
        hunks: [],
        binary: false,
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("similarity ") ||
        line.startsWith("rename ") || line.startsWith("new file mode") ||
        line.startsWith("deleted file mode")) {
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = match ? parseInt(match[1], 10) : 0;
      newNo = match ? parseInt(match[2], 10) : 0;
      current.hunks.push({
        header: line,
        lines: [{ kind: "hunk", oldNo: null, newNo: null, text: line }],
      });
      continue;
    }

    const hunk = current.hunks[current.hunks.length - 1];
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo, text: line.slice(1) });
      current.additions += 1;
      newNo += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldNo: oldNo, newNo: null, text: line.slice(1) });
      current.deletions += 1;
      oldNo += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", oldNo: oldNo, newNo: newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
    // Lines we don't recognize (e.g. "\ No newline at end of file") are dropped.
  }
  finalize();
  return files;
}
