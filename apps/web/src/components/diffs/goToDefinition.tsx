import {
  type EnvironmentId,
  PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { isMacPlatform } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { projectContentSearch } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "None",
  "null",
  "return",
  "self",
  "switch",
  "this",
  "throw",
  "true",
  "True",
  "False",
  "try",
  "type",
  "undefined",
  "var",
  "while",
  "with",
  "yield",
]);

const DEFINITION_SEARCH_LIMIT = 200;
const DOCUMENT_EXTENSIONS = new Set(["md", "mdx", "rst", "txt"]);
const LANGUAGE_FAMILY: Record<string, string> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyi: "py",
};

const extensionOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
const languageOf = (path: string) => LANGUAGE_FAMILY[extensionOf(path)] ?? extensionOf(path);

/** Drops documentation hits; definitions in the clicked file's language come first. */
function rankDefinitions<T extends { readonly path: string }>(
  matches: ReadonlyArray<T>,
  sourcePath: string | null,
): ReadonlyArray<T> {
  const code = matches.filter((match) => !DOCUMENT_EXTENSIONS.has(extensionOf(match.path)));
  if (sourcePath === null) return code;
  const language = languageOf(sourcePath);
  const sameLanguage = code.filter((match) => languageOf(match.path) === language);
  return sameLanguage.length > 0 ? sameLanguage : code;
}

/** Pierre passes the clicked diff or file item as the token callbacks' last argument. */
function sourcePathOf(context: unknown): string | null {
  if (typeof context !== "object" || context === null || !("item" in context)) return null;
  const item = (context as { item?: { fileDiff?: { name?: unknown }; file?: { name?: unknown } } })
    .item;
  const name = item?.fileDiff?.name ?? item?.file?.name;
  return typeof name === "string" ? name : null;
}

function definitionTarget(tokenText: string): string | null {
  const name = tokenText.trim();
  return IDENTIFIER.test(name) && !KEYWORDS.has(name) ? name : null;
}

/** Declarations of `name` across TS/JS, Python, Go, Rust and friends; text search, not an LSP. */
function definitionRegex(name: string): RegExp {
  const n = name.replaceAll("$", "\\$");
  return new RegExp(
    [
      `\\b(?:function\\*?|class|interface|type|enum|def|struct|trait|fn|func|namespace|module|const|let|var)\\s+${n}\\b`,
      `\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`,
      `^\\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\\s+)*${n}\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{`,
      `^${n}\\s*=[^=]`,
    ].join("|"),
  );
}

/**
 * The server caps queries at PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH, so it gets a short superset
 * of `definitionRegex` (or a whole-word search for long names) and the results are filtered here.
 */
function definitionQuery(name: string) {
  const n = name.replaceAll("$", "\\$");
  const query = [
    `\\b(?:function|class|interface|type|enum|def|struct|trait|fn|func|const|let|var)\\s+${n}\\b`,
    `^\\s*(?:\\w+\\s+)*${n}\\s*[=(]`,
    `\\b${n}\\s*[:=]\\s*(?:async|function|\\(|\\w+\\s*=>)`,
  ].join("|");
  return query.length <= PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH
    ? { query, useRegex: true, wholeWord: false }
    : { query: name, useRegex: false, wholeWord: true };
}

const isNavigationClick = (event: MouseEvent | PointerEvent) =>
  isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;

interface DefinitionLookup {
  readonly name: string;
  readonly sourcePath: string | null;
  readonly x: number;
  readonly y: number;
}

interface TokenEvent {
  readonly tokenText: string;
  readonly tokenElement: HTMLElement;
}

/**
 * Cmd/Ctrl-click a name in a diff to open its definition in the file panel. Returns Pierre token
 * callbacks for the diff options and the picker to render beside the diff.
 */
export function useGoToDefinition(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /** The viewed file, for single-file views whose token callbacks carry no item. */
  readonly sourcePath?: string | null;
  readonly enabled: boolean;
}) {
  const [lookup, setLookup] = useState<DefinitionLookup | null>(null);
  const { threadRef, environmentId, cwd } = input;
  if (!input.enabled || threadRef === null || environmentId === null || cwd === null) {
    return { tokenOptions: {}, picker: null };
  }

  const tokenOptions = {
    onTokenEnter: (token: TokenEvent, event: PointerEvent) => {
      if (!isNavigationClick(event) || definitionTarget(token.tokenText) === null) return;
      token.tokenElement.style.textDecoration = "underline";
      token.tokenElement.style.cursor = "pointer";
    },
    onTokenLeave: (token: TokenEvent) => {
      token.tokenElement.style.removeProperty("text-decoration");
      token.tokenElement.style.removeProperty("cursor");
    },
    onTokenClick: (token: TokenEvent, event: MouseEvent, context?: unknown) => {
      const name = definitionTarget(token.tokenText);
      if (!isNavigationClick(event) || name === null) return;
      event.preventDefault();
      const rect = token.tokenElement.getBoundingClientRect();
      setLookup({
        name,
        sourcePath: sourcePathOf(context) ?? input.sourcePath ?? null,
        x: rect.left,
        y: rect.bottom,
      });
    },
  };

  return {
    tokenOptions,
    picker:
      lookup === null ? null : (
        <DefinitionPicker
          key={`${lookup.name}:${lookup.x}:${lookup.y}`}
          lookup={lookup}
          threadRef={threadRef}
          environmentId={environmentId}
          cwd={cwd}
          onClose={() => setLookup(null)}
        />
      ),
  };
}

function DefinitionPicker(props: {
  readonly lookup: DefinitionLookup;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement>(null);
  const { lookup, threadRef, onClose } = props;
  const result = useEnvironmentQuery(
    projectContentSearch({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        ...definitionQuery(lookup.name),
        limit: DEFINITION_SEARCH_LIMIT,
        caseSensitive: true,
      },
    }),
  );
  const declaration = definitionRegex(lookup.name);
  const matches = rankDefinitions(
    (result.data?.matches ?? []).filter((match) => declaration.test(match.lineContent)),
    lookup.sourcePath,
  );
  const onlyMatch = !result.isPending && matches.length === 1 ? matches[0] : undefined;

  const open = (path: string, line: number) => {
    useRightPanelStore.getState().openFile(threadRef, path, line);
    onClose();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a single definition opens without a picker once the search returns
  useEffect(() => {
    if (onlyMatch === undefined) return;
    useRightPanelStore.getState().openFile(threadRef, onlyMatch.path, onlyMatch.lineNumber);
    onClose();
  }, [onlyMatch, threadRef, onClose]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape and outside clicks dismiss the floating picker
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  if (onlyMatch !== undefined) return null;
  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={gt("Definitions of {name}", { name: lookup.name })}
      className="fixed z-50 max-h-80 w-[min(36rem,90vw)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ left: lookup.x, top: lookup.y + 4 }}
    >
      {result.isPending ? (
        <p className="px-2 py-1.5 text-muted-foreground">
          {gt("Finding {name}…", { name: lookup.name })}
        </p>
      ) : result.error !== null ? (
        <p className="px-2 py-1.5 text-destructive">{result.error}</p>
      ) : matches.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground">
          {gt("No definition found for {name}", { name: lookup.name })}
        </p>
      ) : (
        matches.map((match) => (
          <button
            type="button"
            key={`${match.path}:${match.lineNumber}`}
            className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => open(match.path, match.lineNumber)}
          >
            <span className="font-mono text-xs text-muted-foreground">
              {match.path}:{match.lineNumber}
            </span>
            <span className="w-full truncate font-mono text-xs">{match.lineContent.trim()}</span>
          </button>
        ))
      )}
    </div>
  );
}
