import {
  type EnvironmentId,
  PROJECT_SEARCH_CONTENTS_QUERY_MAX_LENGTH,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { contextMenuSourceOf } from "~/contextMenuSource";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { codeDefinition, codeReferences, projectContentSearch } from "~/state/projects";

import { CodeHoverCard, type HoverTarget } from "./CodeHoverCard";
import { type CodeLocation, CodePeek, inWorkspace } from "./CodePeek";
import { explainPrompt, requestExplain } from "./explainSelection";
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

interface CodeSelection {
  readonly text: string;
  readonly lines: { readonly start: number; readonly end: number } | null;
}

/**
 * The text selected in the code view the event came from. Pierre renders into a shadow root, so
 * the root's own selection holds the nodes, and their rows carry the line numbers.
 */
function readCodeSelection(event: MouseEvent): CodeSelection | null {
  const shadowRoot = event.composedPath().find((target) => target instanceof ShadowRoot) as
    | (ShadowRoot & { getSelection?: () => Selection | null })
    | undefined;
  const selection = shadowRoot?.getSelection?.() ?? document.getSelection();
  const text = selection?.toString() ?? "";
  if (selection === null || text.trim().length === 0) return null;
  const lineOf = (node: Node | null) => {
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    const value = element?.closest("[data-line]")?.getAttribute("data-line");
    const line = value == null ? Number.NaN : Number.parseInt(value, 10);
    return Number.isFinite(line) ? line : null;
  };
  const anchor = lineOf(selection.anchorNode);
  const focus = lineOf(selection.focusNode);
  return {
    text,
    lines:
      anchor === null || focus === null
        ? null
        : { start: Math.min(anchor, focus), end: Math.max(anchor, focus) },
  };
}

const isNavigationClick = (event: MouseEvent | PointerEvent) =>
  isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;

interface DefinitionLookup {
  readonly mode: "definition" | "references";
  readonly name: string;
  readonly sourcePath: string | null;
  /** 1-based line and 0-based column in the current file; null for removed diff lines. */
  readonly position: { readonly line: number; readonly character: number } | null;
  readonly x: number;
  readonly y: number;
}

interface TokenEvent {
  readonly tokenText: string;
  readonly tokenElement: HTMLElement;
  readonly lineNumber: number;
  readonly lineCharStart: number;
  readonly side?: "deletions" | "additions";
}

const REFERENCES_SEARCH_LIMIT = 300;
const HOVER_DELAY_MS = 500;
const HOVER_HIDE_DELAY_MS = 300;
const HOVER_CARD_SELECTOR = "[data-code-hover-card]";
const INDEXING_REFRESH_MS = 3_000;
const INDEXING_REFRESH_ATTEMPTS = 5;

/**
 * Cmd/Ctrl-click a name in a diff or file to open its definition; Shift-Cmd/Ctrl-click peeks its
 * references. Returns Pierre token callbacks for the view options and the panel to render beside it.
 */
export function useGoToDefinition(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /** The viewed file, for single-file views whose token callbacks carry no item. */
  readonly sourcePath?: string | null;
  readonly enabled: boolean;
}) {
  const gt = useGT();
  const [lookup, setLookup] = useState<DefinitionLookup | null>(null);
  const hoveredRef = useRef<{ readonly token: TokenEvent; readonly context: unknown } | null>(null);
  const { threadRef, environmentId, cwd } = input;
  const enabled = input.enabled && threadRef !== null && environmentId !== null && cwd !== null;
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInCardRef = useRef(false);

  const cancelHide = useStableCallback(() => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  });
  const scheduleHide = useStableCallback(() => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    cancelHide();
    // The diff reports leaving a name after the card has already seen the pointer enter it.
    if (pointerInCardRef.current) return;
    hideTimerRef.current = setTimeout(() => setHover(null), HOVER_HIDE_DELAY_MS);
  });
  const hideNow = useStableCallback(() => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    cancelHide();
    pointerInCardRef.current = false;
    setHover(null);
  });
  const onCardPointerEnter = useStableCallback(() => {
    pointerInCardRef.current = true;
    cancelHide();
  });
  const onCardPointerLeave = useStableCallback(() => {
    pointerInCardRef.current = false;
    scheduleHide();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a hover card follows the pointer; Escape, scrolling and clicks outside it, and unmount dismiss it
  useEffect(() => {
    if (hover === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideNow();
    };
    const onOutside = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(HOVER_CARD_SELECTOR)) return;
      hideNow();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onOutside, true);
    window.addEventListener("pointerdown", onOutside, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onOutside, true);
      window.removeEventListener("pointerdown", onOutside, true);
    };
  }, [hover, hideNow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pending hover timers must not fire after the view unmounts
  useEffect(() => hideNow, [hideNow]);

  const startLookup = useStableCallback(
    (mode: DefinitionLookup["mode"], token: TokenEvent, context: unknown) => {
      const name = definitionTarget(token.tokenText);
      if (name === null) return;
      const rect = token.tokenElement.getBoundingClientRect();
      setLookup({
        mode,
        name,
        sourcePath: sourcePathOf(context) ?? input.sourcePath ?? null,
        position:
          token.side === "deletions"
            ? null
            : { line: token.lineNumber, character: token.lineCharStart },
        x: rect.left,
        y: rect.bottom,
      });
    },
  );

  const explainSelection = useStableCallback((selection: CodeSelection, context: unknown) => {
    if (threadRef === null) return;
    const prompt = explainPrompt({
      code: selection.text,
      path: sourcePathOf(context) ?? input.sourcePath ?? null,
      lines: selection.lines,
    });
    requestExplain({ threadRef, ...prompt });
  });

  // Right-clicking selected code offers Explain; right-clicking a name offers the lookups.
  // Anywhere else the usual menu stays.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for context menus on the code under the pointer
  useEffect(() => {
    if (!enabled) return;
    const onContextMenu = (event: MouseEvent) => {
      const hovered = hoveredRef.current;
      const api = readLocalApi();
      if (hovered === null || api === undefined || api === null) return;
      if (!event.composedPath().includes(hovered.token.tokenElement)) return;
      const selection = readCodeSelection(event);
      if (selection === null && definitionTarget(hovered.token.tokenText) === null) return;
      event.preventDefault();
      event.stopPropagation();
      void api.contextMenu
        .show(
          selection !== null
            ? [
                { id: "explain", label: gt("Explain") },
                { id: "copy", label: gt("Copy") },
              ]
            : [
                { id: "definition", label: gt("Go to Definition") },
                { id: "references", label: gt("Find All References") },
              ],
          { x: event.clientX, y: event.clientY },
          contextMenuSourceOf(event),
        )
        .then((action) => {
          if (action === "definition" || action === "references") {
            startLookup(action, hovered.token, hovered.context);
          } else if (action === "explain" && selection !== null) {
            explainSelection(selection, hovered.context);
          } else if (action === "copy" && selection !== null) {
            void navigator.clipboard.writeText(selection.text);
          }
        });
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, [enabled, gt, startLookup, explainSelection]);

  if (!enabled) {
    return { tokenOptions: {}, picker: null };
  }

  const tokenOptions = {
    onTokenEnter: (token: TokenEvent, event: PointerEvent, context?: unknown) => {
      hoveredRef.current = { token, context };
      const name = definitionTarget(token.tokenText);
      if (name === null) return;
      if (isNavigationClick(event)) {
        token.tokenElement.style.textDecoration = "underline";
        token.tokenElement.style.cursor = "pointer";
        return;
      }
      // Hover: the language server's signature and docs after the pointer rests on a name.
      const sourcePath = sourcePathOf(context) ?? input.sourcePath ?? null;
      if (sourcePath === null || token.side === "deletions") return;
      cancelHide();
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = setTimeout(() => {
        hoverTimerRef.current = null;
        if ((window.getSelection()?.toString() ?? "").length > 0) return;
        const rect = token.tokenElement.getBoundingClientRect();
        setHover({
          name,
          sourcePath,
          line: token.lineNumber,
          character: token.lineCharStart,
          rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
        });
      }, HOVER_DELAY_MS);
    },
    onTokenLeave: (token: TokenEvent) => {
      scheduleHide();
      if (hoveredRef.current?.token.tokenElement === token.tokenElement) hoveredRef.current = null;
      token.tokenElement.style.removeProperty("text-decoration");
      token.tokenElement.style.removeProperty("cursor");
    },
    onTokenClick: (token: TokenEvent, event: MouseEvent, context?: unknown) => {
      if (!isNavigationClick(event) || definitionTarget(token.tokenText) === null) return;
      event.preventDefault();
      hideNow();
      startLookup(event.shiftKey ? "references" : "definition", token, context);
    },
  };

  const panelProps =
    lookup === null
      ? null
      : {
          lookup,
          threadRef,
          environmentId,
          cwd,
          onClose: () => setLookup(null),
        };
  const lookupPanel =
    panelProps === null ? null : panelProps.lookup.mode === "references" ? (
      <ReferencesPeek key={`${lookup!.name}:${lookup!.x}:${lookup!.y}`} {...panelProps} />
    ) : (
      <DefinitionPicker key={`${lookup!.name}:${lookup!.x}:${lookup!.y}`} {...panelProps} />
    );
  const hoverCard =
    hover === null || lookup !== null ? null : (
      <CodeHoverCard
        key={`${hover.sourcePath}:${hover.line}:${hover.character}`}
        target={hover}
        environmentId={environmentId}
        cwd={cwd}
        threadRef={threadRef}
        onPointerEnter={onCardPointerEnter}
        onPointerLeave={onCardPointerLeave}
      />
    );
  return {
    tokenOptions,
    picker: (
      <>
        {hoverCard}
        {lookupPanel}
      </>
    ),
  };
}

interface PanelProps {
  readonly lookup: DefinitionLookup;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onClose: () => void;
}

function DefinitionPicker(props: PanelProps) {
  const gt = useGT();
  const { lookup, threadRef, onClose } = props;
  // The language server answers first; text search covers unsupported files, edits since render,
  // removed lines, and servers that fail or find nothing.
  const lsp = useEnvironmentQuery(
    lookup.sourcePath === null || lookup.position === null
      ? null
      : codeDefinition({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            relativePath: lookup.sourcePath,
            line: lookup.position.line,
            character: lookup.position.character,
            name: lookup.name,
          },
        }),
  );
  const lspLocations = lsp.data?.status === "ok" ? lsp.data.locations : [];
  const needsTextSearch = !lsp.isPending && lspLocations.length === 0;
  const search = useEnvironmentQuery(
    needsTextSearch
      ? projectContentSearch({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            ...definitionQuery(lookup.name),
            limit: DEFINITION_SEARCH_LIMIT,
            caseSensitive: true,
          },
        })
      : null,
  );
  const declaration = definitionRegex(lookup.name);
  const matches: ReadonlyArray<CodeLocation> =
    lspLocations.length > 0
      ? lspLocations
      : rankDefinitions(
          (search.data?.matches ?? []).filter((match) => declaration.test(match.lineContent)),
          lookup.sourcePath,
        );
  const isPending = lsp.isPending || (needsTextSearch && search.isPending);
  const error = needsTextSearch ? search.error : null;
  const onlyMatch =
    !isPending && matches.length === 1 && inWorkspace(matches[0]!.path) ? matches[0] : undefined;

  const open = (location: CodeLocation) => {
    useRightPanelStore.getState().openFile(threadRef, location.path, location.lineNumber);
    onClose();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a single definition opens without a picker once the search returns
  useEffect(() => {
    if (onlyMatch === undefined) return;
    useRightPanelStore.getState().openFile(threadRef, onlyMatch.path, onlyMatch.lineNumber);
    onClose();
  }, [onlyMatch, threadRef, onClose]);

  if (onlyMatch !== undefined) return null;
  return (
    <CodePeek
      title={gt("Definitions of {name}", { name: lookup.name })}
      name={lookup.name}
      locations={matches}
      status={
        isPending
          ? gt("Finding {name}…", { name: lookup.name })
          : error !== null
            ? error
            : matches.length === 0
              ? gt("No definition found for {name}", { name: lookup.name })
              : null
      }
      anchor={lookup}
      environmentId={props.environmentId}
      cwd={props.cwd}
      onOpen={open}
      onClose={onClose}
    />
  );
}

function ReferencesPeek(props: PanelProps) {
  const gt = useGT();
  const { lookup, threadRef, onClose } = props;
  const [refreshes, setRefreshes] = useState(0);
  const lsp = useEnvironmentQuery(
    lookup.sourcePath === null || lookup.position === null
      ? null
      : codeReferences({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            relativePath: lookup.sourcePath,
            line: lookup.position.line,
            character: lookup.position.character,
            name: lookup.name,
          },
        }),
  );
  const lspLocations = lsp.data?.status === "ok" ? lsp.data.locations : [];
  const indexing = lsp.data?.partial === true && refreshes < INDEXING_REFRESH_ATTEMPTS;
  const needsTextSearch = !lsp.isPending && lspLocations.length === 0;
  const search = useEnvironmentQuery(
    needsTextSearch
      ? projectContentSearch({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            query: lookup.name,
            limit: REFERENCES_SEARCH_LIMIT,
            caseSensitive: true,
            wholeWord: true,
            useRegex: false,
          },
        })
      : null,
  );
  const references: ReadonlyArray<CodeLocation> =
    lspLocations.length > 0 ? lspLocations : (search.data?.matches ?? []);
  const isPending = lsp.isPending || (needsTextSearch && search.isPending);
  const error = needsTextSearch ? search.error : null;

  const refreshLsp = lsp.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a language server still indexing is asked again until its answer is complete
  useEffect(() => {
    if (!indexing) return;
    const timer = setTimeout(() => {
      setRefreshes(refreshes + 1);
      refreshLsp();
    }, INDEXING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [indexing, refreshes, refreshLsp]);

  const open = (location: CodeLocation) => {
    useRightPanelStore.getState().openFile(threadRef, location.path, location.lineNumber);
    onClose();
  };

  return (
    <CodePeek
      title={gt("References to {name} ({count})", {
        name: lookup.name,
        count: references.length,
      })}
      name={lookup.name}
      locations={references}
      status={
        isPending && references.length === 0
          ? gt("Finding {name}…", { name: lookup.name })
          : error !== null
            ? error
            : references.length === 0
              ? gt("No references found for {name}", { name: lookup.name })
              : null
      }
      note={indexing ? gt("Indexing…") : null}
      anchor={lookup}
      environmentId={props.environmentId}
      cwd={props.cwd}
      onOpen={open}
      onClose={onClose}
    />
  );
}
