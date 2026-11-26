import type { ScopedThreadRef } from "@t3tools/contracts";

export interface ExplainRequest {
  readonly threadRef: ScopedThreadRef;
  readonly text: string;
  readonly titleSeed: string;
}

type ExplainHandler = (request: ExplainRequest) => boolean;

const handlers = new Set<ExplainHandler>();

/**
 * Code views ask the open chat to explain a selection; the chat owns the model and permission
 * settings a side chat starts with. Resolves false when no chat for the thread took it.
 */
export function requestExplain(request: ExplainRequest): boolean {
  for (const handler of handlers) if (handler(request)) return true;
  return false;
}

export function handleExplainRequests(handler: ExplainHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

const FENCE_LANGUAGES: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  css: "css",
  html: "html",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  sql: "sql",
  md: "markdown",
};

/** The message a side chat starts with: where the code is and the code itself, fenced. */
export function explainPrompt(input: {
  readonly code: string;
  readonly path: string | null;
  readonly lines: { readonly start: number; readonly end: number } | null;
}): { readonly text: string; readonly titleSeed: string } {
  const extension = input.path?.slice(input.path.lastIndexOf(".") + 1).toLowerCase() ?? "";
  const language = FENCE_LANGUAGES[extension] ?? "";
  const longestFence = Math.max(2, ...(input.code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestFence + 1);
  const where =
    input.path === null
      ? ""
      : input.lines === null
        ? ` from \`${input.path}\``
        : input.lines.start === input.lines.end
          ? ` from \`${input.path}\` (line ${input.lines.start})`
          : ` from \`${input.path}\` (lines ${input.lines.start}–${input.lines.end})`;
  return {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- a prompt for the agent, not UI copy
    text: `Explain this code${where}. What does it do, and how does it fit into the surrounding code?\n\n${fence}${language}\n${input.code.replace(/\n+$/, "")}\n${fence}`,
    titleSeed: `Explain ${input.path ?? "code"}${input.lines ? `:${input.lines.start}` : ""}`,
  };
}
