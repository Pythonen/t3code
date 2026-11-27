import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { codeHover } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

// Loaded on first hover: chat's renderer is heavy and diff views should not wait for it.
const ChatMarkdown = lazy(() => import("../ChatMarkdown"));

const CARD_MAX_HEIGHT = 320;
const CARD_MAX_WIDTH = 640;
const VIEWPORT_MARGIN = 8;

export interface HoverTarget {
  readonly name: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly character: number;
  readonly rect: { readonly left: number; readonly top: number; readonly bottom: number };
}

/** The language server's hover for a name: its signature, then its documentation. */
export function CodeHoverCard(props: {
  readonly target: HoverTarget;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}) {
  const { target } = props;
  const result = useEnvironmentQuery(
    codeHover({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        relativePath: target.sourcePath,
        line: target.line,
        character: target.character,
        name: target.name,
      },
    }),
  );
  const markdown = result.data?.status === "ok" ? result.data.markdown : null;
  if (markdown === null || markdown.trim().length === 0) return null;

  const width = Math.min(CARD_MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, target.rect.left),
    window.innerWidth - width - VIEWPORT_MARGIN,
  );
  const fitsBelow = target.rect.bottom + CARD_MAX_HEIGHT + VIEWPORT_MARGIN <= window.innerHeight;
  return (
    <div
      role="tooltip"
      className="fixed z-50 overflow-auto rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
      style={{
        left,
        maxWidth: width,
        maxHeight: CARD_MAX_HEIGHT,
        ...(fitsBelow
          ? { top: target.rect.bottom + 4 }
          : { bottom: window.innerHeight - target.rect.top + 4 }),
      }}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      <Suspense fallback={null}>
        <ChatMarkdown
          text={markdown}
          cwd={props.cwd}
          threadRef={props.threadRef}
          environmentId={props.environmentId}
        />
      </Suspense>
    </div>
  );
}
