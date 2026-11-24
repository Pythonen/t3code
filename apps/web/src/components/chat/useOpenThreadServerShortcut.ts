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

/** The thread's web app: a JavaScript dev server first (not its API), then the lowest port. */
function pickThreadWebServer(
  servers: ReadonlyArray<DiscoveredLocalServer>,
): DiscoveredLocalServer | null {
  const isWeb = (server: DiscoveredLocalServer) =>
    server.processName !== null && WEB_RUNTIME_PROCESS.test(server.processName);
  return (
    servers.toSorted(
      (left, right) => Number(isWeb(right)) - Number(isWeb(left)) || left.port - right.port,
    )[0] ?? null
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
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: m(msg("No local server is running in this thread.")),
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
