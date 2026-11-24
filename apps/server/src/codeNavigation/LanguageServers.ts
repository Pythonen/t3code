// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a long-lived stdio JSON-RPC client; its framing and timers live outside Effect like the native spawner.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  CodeDefinitionError,
  type CodeDefinitionInput,
  type CodeDefinitionLocation,
  type CodeDefinitionResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const IDLE_SHUTDOWN_MS = 10 * 60_000;
const MAX_LOCATIONS = 50;
// The desktop backend can start with a minimal PATH; Homebrew and npm-global binaries live here.
const EXTRA_PATH_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"];

const LANGUAGE_IDS: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  pyi: "python",
};

interface ServerSpec {
  readonly key: string;
  readonly label: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly root: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly initializationOptions?: unknown;
}

const searchPath = () =>
  [...(process.env.PATH ?? "").split(NodePath.delimiter), ...EXTRA_PATH_DIRECTORIES].filter(
    (directory) => directory.length > 0,
  );

function which(binary: string): string | null {
  for (const directory of searchPath()) {
    const candidate = NodePath.join(directory, binary);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/** The nearest directory from `start` up to and including `stop` that satisfies `test`. */
function findUp(start: string, stop: string, test: (directory: string) => boolean): string | null {
  for (let directory = start; ; directory = NodePath.dirname(directory)) {
    if (test(directory)) return directory;
    if (directory === stop || directory === NodePath.dirname(directory)) return null;
  }
}

const exists = (path: string) => NodeFS.existsSync(path);

function resolveServerSpec(workspaceRoot: string, absolutePath: string): ServerSpec | null {
  const extension = NodePath.extname(absolutePath).slice(1).toLowerCase();
  const language = LANGUAGE_IDS[extension];
  const directory = NodePath.dirname(absolutePath);
  if (language === "python") {
    const command = which("pyright-langserver") ?? which("basedpyright-langserver");
    if (command === null) return null;
    const venvRoot = findUp(directory, workspaceRoot, (candidate) =>
      exists(NodePath.join(candidate, ".venv", "bin", "python")),
    );
    const root = venvRoot ?? workspaceRoot;
    const pythonPath = venvRoot === null ? null : NodePath.join(venvRoot, ".venv", "bin", "python");
    return {
      key: `${command}\0${root}`,
      label: NodePath.basename(command),
      command,
      args: ["--stdio"],
      root,
      settings: pythonPath === null ? {} : { python: { pythonPath } },
    };
  }
  if (language === undefined) return null;
  const packageRoot = findUp(directory, workspaceRoot, (candidate) =>
    exists(NodePath.join(candidate, "node_modules", "typescript", "package.json")),
  );
  if (packageRoot === null) return null;
  const typescriptDirectory = NodePath.join(packageRoot, "node_modules", "typescript");
  const version = (() => {
    try {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(typescriptDirectory, "package.json"), "utf8"),
      ) as { version?: unknown };
      return typeof manifest.version === "string" ? manifest.version : "";
    } catch {
      return "";
    }
  })();
  // TypeScript 7 is native and serves LSP itself; earlier versions go through tsserver.
  if (Number.parseInt(version, 10) >= 7) {
    const command = NodePath.join(packageRoot, "node_modules", ".bin", "tsc");
    if (!exists(command)) return null;
    return {
      key: `${command}\0${packageRoot}`,
      label: `tsc ${version} --lsp`,
      command,
      args: ["--lsp", "--stdio"],
      root: packageRoot,
      settings: {},
    };
  }
  const command = which("typescript-language-server");
  const tsserver = NodePath.join(typescriptDirectory, "lib", "tsserver.js");
  if (command === null || !exists(tsserver)) return null;
  return {
    key: `${command}\0${packageRoot}`,
    label: `typescript-language-server (TypeScript ${version})`,
    command,
    args: ["--stdio"],
    root: packageRoot,
    settings: {},
    initializationOptions: { tsserver: { path: tsserver } },
  };
}

type JsonValue = unknown;

interface LspMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
}

/** One language server process speaking LSP over stdio. */
class LanguageServerConnection {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();
  private readonly documents = new Map<string, { version: number; mtimeMs: number }>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly ready: Promise<void>;
  exited = false;

  readonly spec: ServerSpec;
  private readonly onExit: () => void;

  constructor(spec: ServerSpec, onExit: () => void) {
    this.spec = spec;
    this.onExit = onExit;
    this.child = NodeChildProcess.spawn(spec.command, [...spec.args], {
      cwd: spec.root,
      env: { ...process.env, PATH: searchPath().join(NodePath.delimiter) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", () => {});
    this.child.on("exit", () => this.handleExit());
    this.child.on("error", () => this.handleExit());
    const rootUri = NodeURL.pathToFileURL(spec.root).href;
    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: NodePath.basename(spec.root) }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          synchronization: { didSave: false },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
      ...(spec.initializationOptions === undefined
        ? {}
        : { initializationOptions: spec.initializationOptions }),
    }).then(() => this.notify("initialized", {}));
    this.touch();
  }

  async definition(absolutePath: string, line: number, character: number): Promise<JsonValue> {
    await this.ready;
    this.touch();
    const uri = NodeURL.pathToFileURL(absolutePath).href;
    const stat = NodeFS.statSync(absolutePath);
    const known = this.documents.get(uri);
    if (known === undefined || known.mtimeMs !== stat.mtimeMs) {
      const text = NodeFS.readFileSync(absolutePath, "utf8");
      if (known === undefined) {
        const extension = NodePath.extname(absolutePath).slice(1).toLowerCase();
        this.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: LANGUAGE_IDS[extension] ?? "plaintext",
            version: 1,
            text,
          },
        });
        this.documents.set(uri, { version: 1, mtimeMs: stat.mtimeMs });
      } else {
        const version = known.version + 1;
        this.notify("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
        this.documents.set(uri, { version, mtimeMs: stat.mtimeMs });
      }
    }
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  dispose() {
    if (this.exited) return;
    clearTimeout(this.idleTimer);
    this.request("shutdown", null)
      .catch(() => undefined)
      .finally(() => {
        this.notify("exit", null);
        setTimeout(() => this.child.kill(), 1_000).unref();
      });
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_SHUTDOWN_MS);
    this.idleTimer.unref();
  }

  private handleExit() {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.idleTimer);
    for (const entry of this.pending.values()) entry.reject(new Error("Language server exited"));
    this.pending.clear();
    this.onExit();
  }

  private send(message: Record<string, unknown>) {
    if (this.exited) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private notify(method: string, params: JsonValue) {
    this.send({ method, params });
  }

  private request(method: string, params: JsonValue): Promise<JsonValue> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.spec.label} did not answer ${method} in time`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message: LspMessage;
      try {
        message = JSON.parse(body) as LspMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: LspMessage) {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(Number(message.id));
      this.pending.delete(Number(message.id));
      if (message.error) entry?.reject(new Error(message.error.message ?? "Language server error"));
      else entry?.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      const items =
        message.method === "workspace/configuration" &&
        typeof message.params === "object" &&
        message.params !== null &&
        "items" in message.params &&
        Array.isArray(message.params.items)
          ? (message.params.items as ReadonlyArray<{ section?: string }>)
          : null;
      this.send({
        id: message.id,
        result:
          items === null ? null : items.map((item) => this.spec.settings[item.section ?? ""] ?? {}),
      });
    }
  }
}

interface RawLocation {
  readonly uri?: string;
  readonly targetUri?: string;
  readonly range?: { readonly start: { readonly line: number } };
  readonly targetSelectionRange?: { readonly start: { readonly line: number } };
}

function toLocations(workspaceRoot: string, raw: JsonValue): ReadonlyArray<CodeDefinitionLocation> {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as ReadonlyArray<RawLocation>;
  const seen = new Set<string>();
  const locations: CodeDefinitionLocation[] = [];
  const fileLines = new Map<string, ReadonlyArray<string>>();
  for (const entry of list) {
    const uri = entry.targetUri ?? entry.uri;
    const range = entry.targetSelectionRange ?? entry.range;
    if (uri === undefined || range === undefined || !uri.startsWith("file:")) continue;
    const absolutePath = NodeURL.fileURLToPath(uri);
    const lineNumber = range.start.line + 1;
    const key = `${absolutePath}:${lineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let lines = fileLines.get(absolutePath);
    if (lines === undefined) {
      try {
        lines = NodeFS.readFileSync(absolutePath, "utf8").split("\n");
      } catch {
        lines = [];
      }
      fileLines.set(absolutePath, lines);
    }
    const relative = NodePath.relative(workspaceRoot, absolutePath);
    locations.push({
      path: relative.startsWith("..") || NodePath.isAbsolute(relative) ? absolutePath : relative,
      lineNumber,
      lineContent: (lines[range.start.line] ?? "").slice(0, 400),
    });
    if (locations.length >= MAX_LOCATIONS) break;
  }
  return locations;
}

/** The column where `name` sits on `line`, preferring the requested one; null if it is gone. */
function locateName(line: string, character: number, name: string): number | null {
  if (line.slice(character, character + name.length) === name) return character;
  let best: number | null = null;
  for (let index = line.indexOf(name); index >= 0; index = line.indexOf(name, index + 1)) {
    if (best === null || Math.abs(index - character) < Math.abs(best - character)) best = index;
  }
  return best;
}

export class LanguageServers extends Context.Service<
  LanguageServers,
  {
    readonly definition: (
      input: CodeDefinitionInput,
    ) => Effect.Effect<CodeDefinitionResult, CodeDefinitionError>;
  }
>()("t3/codeNavigation/LanguageServers") {}

const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const connections = new Map<string, LanguageServerConnection>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const connection of connections.values()) connection.dispose();
      connections.clear();
    }),
  );

  const connectionFor = (spec: ServerSpec) => {
    const existing = connections.get(spec.key);
    if (existing !== undefined && !existing.exited) return existing;
    const connection = new LanguageServerConnection(spec, () => {
      if (connections.get(spec.key) === connection) connections.delete(spec.key);
    });
    connections.set(spec.key, connection);
    return connection;
  };

  const definition = Effect.fn("LanguageServers.definition")(function* (
    input: CodeDefinitionInput,
  ) {
    const toError = (message: string) => (cause: unknown) =>
      new CodeDefinitionError({ message, cause });
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(input.cwd)
      .pipe(Effect.mapError(toError("The workspace is not available.")));
    const { absolutePath } = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: input.relativePath })
      .pipe(Effect.mapError(toError("The file is outside the workspace.")));
    const spec = resolveServerSpec(workspaceRoot, absolutePath);
    if (spec === null)
      return { status: "unsupported", locations: [] } satisfies CodeDefinitionResult;
    const lineText = yield* Effect.try({
      try: () => NodeFS.readFileSync(absolutePath, "utf8").split("\n")[input.line - 1] ?? "",
      catch: toError("The file could not be read."),
    });
    const character = locateName(lineText, input.character, input.name);
    if (character === null)
      return { status: "stale", locations: [] } satisfies CodeDefinitionResult;
    const raw = yield* Effect.tryPromise({
      try: () => connectionFor(spec).definition(absolutePath, input.line - 1, character),
      catch: (cause) =>
        new CodeDefinitionError({
          message: cause instanceof Error ? cause.message : "The language server failed.",
          cause,
        }),
    });
    return {
      status: "ok",
      locations: toLocations(workspaceRoot, raw),
      server: spec.label,
    } satisfies CodeDefinitionResult;
  });

  return LanguageServers.of({ definition });
});

export const layer = Layer.effect(LanguageServers, make);
