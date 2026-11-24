import { File, type FileOptions } from "@pierre/diffs/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import {
  FILE_LINK_REVEAL_ATTRIBUTE,
  FILE_LINK_REVEAL_UNSAFE_CSS,
} from "~/components/files/fileSurfaceChrome";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

export interface CodeLocation {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
}

const PEEK_HEIGHT = 340;
const PEEK_MAX_WIDTH = 1040;
const VIEWPORT_MARGIN = 16;

// The file panel opens workspace paths; a location outside it (a system library) only lists.
export const inWorkspace = (path: string) => !path.startsWith("/");

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const directoryName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** Positions the peek under the clicked name, or above it when the viewport has no room below. */
function peekPlacement(anchor: { readonly x: number; readonly y: number }) {
  const width = Math.min(PEEK_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.x - 48),
    window.innerWidth - width - VIEWPORT_MARGIN,
  );
  const below = anchor.y + 6;
  const top =
    below + PEEK_HEIGHT <= window.innerHeight - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, anchor.y - PEEK_HEIGHT - 28);
  return { left, top, width };
}

/**
 * A VS Code style peek: the selected location's file on the left with its line revealed, the
 * locations grouped by file on the right. Arrow keys move, Enter opens, Escape closes.
 */
export function CodePeek(props: {
  readonly title: string;
  readonly name: string;
  readonly locations: ReadonlyArray<CodeLocation>;
  /** Shown instead of the panes while there is nothing to list (searching, none found, an error). */
  readonly status: ReactNode | null;
  readonly note?: string | null;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onOpen: (location: CodeLocation) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { locations, onOpen, onClose } = props;
  const selected = locations[Math.min(selectedIndex, locations.length - 1)] ?? null;
  const placement = peekPlacement(props.anchor);

  const groups = new Map<string, { location: CodeLocation; index: number }[]>();
  locations.forEach((location, index) => {
    const group = groups.get(location.path);
    if (group) group.push({ location, index });
    else groups.set(location.path, [{ location, index }]);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- arrow keys, Enter, Escape and outside clicks drive the floating peek
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (locations.length === 0) return;
        event.preventDefault();
        setSelectedIndex((index) =>
          event.key === "ArrowDown"
            ? Math.min(locations.length - 1, index + 1)
            : Math.max(0, index - 1),
        );
      } else if (event.key === "Enter") {
        const location = locations[selectedIndex];
        if (location === undefined || !inWorkspace(location.path)) return;
        event.preventDefault();
        onOpen(location);
      }
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
  }, [locations, selectedIndex, onOpen, onClose]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={props.title}
      className="fixed z-50 flex flex-col overflow-hidden rounded-md border border-primary/40 bg-popover text-sm text-popover-foreground shadow-xl"
      style={{ ...placement, height: PEEK_HEIGHT }}
    >
      <header className="flex items-center gap-2 border-b border-border bg-primary/10 px-3 py-1.5">
        {selected === null ? null : (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium">{baseName(selected.path)}</span>
            <span className="truncate text-xs text-muted-foreground">
              {directoryName(selected.path)}
            </span>
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {props.note ? `${props.title} · ${props.note}` : props.title}
        </span>
        <button
          type="button"
          aria-label={gt("Close")}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </header>
      {props.status !== null ? (
        <div className="px-3 py-2 text-muted-foreground">{props.status}</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(14rem,32%)]">
          <PeekPreview environmentId={props.environmentId} cwd={props.cwd} location={selected} />
          <ul className="min-h-0 overflow-y-auto border-l border-border bg-muted/30 py-1">
            {[...groups].map(([path, items]) => {
              const isCollapsed = collapsed.has(path);
              return (
                <li key={path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-accent"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                  >
                    {isCollapsed ? (
                      <ChevronRightIcon className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate text-xs font-medium">{baseName(path)}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {directoryName(path)}
                    </span>
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-3xs text-muted-foreground">
                      {items.length}
                    </span>
                  </button>
                  {isCollapsed ? null : (
                    <ul>
                      {items.map(({ location, index }) => (
                        <li key={`${location.path}:${location.lineNumber}`}>
                          <button
                            type="button"
                            className={`flex w-full items-baseline gap-2 py-0.5 pr-2 pl-6 text-left font-mono text-xs ${
                              selected === location
                                ? "bg-primary/20 text-foreground"
                                : "text-muted-foreground hover:bg-accent"
                            }`}
                            onClick={() => setSelectedIndex(index)}
                            onDoubleClick={() => {
                              if (inWorkspace(location.path)) onOpen(location);
                            }}
                          >
                            <HighlightedLine text={location.lineContent.trim()} name={props.name} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function HighlightedLine(props: { readonly text: string; readonly name: string }) {
  const parts = props.text.split(props.name);
  return (
    <span className="min-w-0 truncate">
      {parts.map((part, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- the parts of one line never reorder
        <span key={index}>
          {part}
          {index < parts.length - 1 ? (
            <span className="font-semibold text-foreground">{props.name}</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** The location's file, read-only and highlighted, scrolled so its line sits in the middle. */
function PeekPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly location: CodeLocation | null;
}) {
  const resolvedTheme = useRenderedAppearance();
  const paneRef = useRef<HTMLDivElement>(null);
  const location = props.location;
  const readable = location !== null && inWorkspace(location.path);
  const file = useProjectFileQuery(
    props.environmentId,
    props.cwd,
    readable ? location.path : null,
    readable,
  );
  const contents = file.data?.contents;
  const line = location?.lineNumber ?? null;

  const reveal: NonNullable<FileOptions<unknown, undefined>["onPostRender"]> = (node, _, phase) => {
    if (phase === "unmount" || line === null) return;
    const root = node.shadowRoot ?? node;
    for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
      element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
    }
    const lineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
    lineElement?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
    root
      .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
      ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
    const pane = paneRef.current;
    if (lineElement === null || pane === null) return;
    requestAnimationFrame(() => {
      const paneRect = pane.getBoundingClientRect();
      const lineRect = lineElement.getBoundingClientRect();
      pane.scrollTop += lineRect.top - paneRect.top - (pane.clientHeight - lineRect.height) / 2;
    });
  };

  if (location === null) return <div />;
  if (!readable || contents === undefined) {
    return (
      <div className="min-h-0 overflow-auto p-3 font-mono text-xs text-muted-foreground">
        {readable ? null : `${location.lineNumber}: ${location.lineContent}`}
      </div>
    );
  }
  return (
    <div ref={paneRef} className="min-h-0 overflow-auto [--code-background:var(--background)]">
      <DiffWorkerPoolProvider>
        <File
          key={`${location.path}:${resolvedTheme}`}
          file={{ name: location.path, contents }}
          options={{
            disableFileHeader: true,
            overflow: "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            onPostRender: reveal,
          }}
        />
      </DiffWorkerPoolProvider>
    </div>
  );
}
