import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect } from "react";

import { resolveExternalServerUrl } from "../../browser/browserTargetResolver";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import { readLocalApi } from "../../localApi";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { registerCommands } from "../../shortcuts/dispatcher";
import { stackedThreadToast, toastManager } from "../ui/toast";

const WEB_RUNTIME_PROCESS = /^(node|bun|deno|vite|next-server)$/i;

/** The thread's web app: its JavaScript dev server with the lowest port, never its API. */
function pickThreadWebServer(
  servers: ReadonlyArray<DiscoveredLocalServer>,
): DiscoveredLocalServer | null {
  return (
    servers
      .filter(
        (server) => server.processName !== null && WEB_RUNTIME_PROCESS.test(server.processName),
      )
      .toSorted((left, right) => left.port - right.port)[0] ?? null
  );
}

/**
 * `thread.openLocalServer` opens the server this thread's terminals or agent started in the
 * system browser. Capture phase, so a focused terminal does not swallow the chord.
 */
export function useOpenThreadServerShortcut(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const servers = useThreadDiscoveredPorts(input);
  const environmentId = input.environmentId;

  const openServer = useStableCallback((event: KeyboardEvent) => {
    if (event.repeat || environmentId === null) return;
    event.preventDefault();
    const server = pickThreadWebServer(servers);
    if (server === null) {
      const others = servers.map((candidate) => `:${candidate.port}`).join(", ");
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: m(msg("No web dev server is running in this thread.")),
          ...(others === "" ? {} : { description: m(msg("Running: {ports}", { ports: others })) }),
        }),
      );
      return;
    }
    const url = resolveExternalServerUrl(environmentId, server.url);
    const localApi = readLocalApi();
    if (localApi === undefined || localApi === null) {
      window.open(url, "_blank", "noopener");
      return;
    }
    void localApi.shell.openExternal(url).catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Unable to open in browser")),
          description: String(error),
        }),
      ),
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open-server shortcut while a thread is open
  useEffect(() => {
    if (!input.enabled) return;
    return registerCommands({ "thread.openLocalServer": openServer }, { capture: true });
  }, [input.enabled, openServer]);
}
