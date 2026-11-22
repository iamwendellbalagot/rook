import type { Readable, Writable } from "node:stream";

export type SemanticAction = "definition" | "references" | "diagnostics";

const MAX_FRAME_BYTES = 512 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const analysis = { diagnosticMode: "openFilesOnly", typeCheckingMode: "basic" };

/** One bounded LSP exchange. Never dispatch a server request into Rook tools. */
export function queryLanguageServer(
  streams: { input: Readable; output: Writable },
  query: {
    action: SemanticAction;
    rootUri: string;
    uri: string;
    languageId: "python" | "go";
    text: string;
    position?: { line: number; character: number };
    signal: AbortSignal;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { input, output } = streams;
    let buffer = Buffer.alloc(0);
    let messageSize: number | undefined;
    let total = 0;
    let initialized = false;
    let settled = false;
    const cleanup = () => {
      settled = true;
      query.signal.removeEventListener("abort", abort);
      input.off("data", receive);
      input.off("end", closed);
      input.off("error", closed);
      output.off("error", closed);
    };
    const fail = (message: string) => {
      if (settled) return;
      cleanup();
      reject(new Error(message));
    };
    const finish = (result: unknown) => {
      if (settled) return;
      cleanup();
      resolve(result);
    };
    const abort = () =>
      fail("Language server request was cancelled or timed out.");
    const closed = () =>
      fail("Language server closed before returning a result.");
    const send = (payload: Record<string, unknown>) => {
      if (settled) return;
      const body = JSON.stringify({ jsonrpc: "2.0", ...payload });
      output.write(
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        (error) => {
          if (error) closed();
        },
      );
    };
    const folders = [{ uri: query.rootUri, name: "workspace" }];
    const handle = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (typeof message.method === "string") {
        if (Object.hasOwn(message, "id")) {
          if (message.method === "workspace/configuration") {
            const params = message.params as
              | { items?: { section?: string }[] }
              | undefined;
            const items = Array.isArray(params?.items)
              ? params.items.slice(0, 64)
              : [];
            send({
              id: message.id,
              result: items.map((item) =>
                item?.section === "python.analysis"
                  ? analysis
                  : item?.section === "python"
                    ? { analysis }
                    : {},
              ),
            });
          } else if (message.method === "workspace/workspaceFolders") {
            send({ id: message.id, result: folders });
          } else if (
            message.method === "client/registerCapability" ||
            message.method === "client/unregisterCapability"
          ) {
            send({ id: message.id, result: null });
          } else {
            send({
              id: message.id,
              error: { code: -32601, message: "Server request not supported" },
            });
          }
        } else if (
          initialized &&
          query.action === "diagnostics" &&
          message.method === "textDocument/publishDiagnostics"
        ) {
          const params = message.params as
            | { uri?: string; diagnostics?: unknown }
            | undefined;
          if (params?.uri === query.uri && Array.isArray(params.diagnostics))
            finish(params.diagnostics);
        }
        return;
      }
      if (message.id === 1 && !initialized) {
        if (message.error || !message.result)
          return fail("Language server could not initialize.");
        initialized = true;
        send({ method: "initialized", params: {} });
        send({
          method: "textDocument/didOpen",
          params: {
            textDocument: {
              uri: query.uri,
              languageId: query.languageId,
              version: 1,
              text: query.text,
            },
          },
        });
        if (query.action !== "diagnostics")
          send({
            id: 2,
            method: `textDocument/${query.action}`,
            params: {
              textDocument: { uri: query.uri },
              position: query.position,
              ...(query.action === "references"
                ? { context: { includeDeclaration: true } }
                : {}),
            },
          });
      } else if (
        message.id === 2 &&
        initialized &&
        query.action !== "diagnostics"
      ) {
        if (message.error || !Object.hasOwn(message, "result"))
          return fail("Language server could not answer the query.");
        finish(message.result);
      }
    };
    function receive(chunk: Buffer) {
      total += chunk.length;
      if (total > MAX_STREAM_BYTES)
        return fail("Language server output exceeded its limit.");
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled) {
        if (messageSize === undefined) {
          const split = buffer.indexOf("\r\n\r\n");
          if (split < 0 && buffer.length <= 1024) return;
          const headers =
            split >= 0 && split <= 1024
              ? buffer.subarray(0, split).toString("ascii")
              : "";
          const lengths = [
            ...headers.matchAll(/^Content-Length: *(\d+)\r?$/gim),
          ];
          messageSize = Number(lengths[0]?.[1]);
          if (
            lengths.length !== 1 ||
            !Number.isInteger(messageSize) ||
            messageSize < 2 ||
            messageSize > MAX_FRAME_BYTES
          ) {
            return fail(
              "Language server returned an invalid or oversized frame.",
            );
          }
          buffer = buffer.subarray(split + 4);
        }
        if (buffer.length < messageSize) return;
        const frame = buffer.subarray(0, messageSize);
        buffer = buffer.subarray(messageSize);
        messageSize = undefined;
        let payload: unknown;
        try {
          payload = JSON.parse(frame.toString("utf8"));
        } catch {
          return fail("Language server returned invalid JSON.");
        }
        handle(payload);
      }
    }
    if (query.signal.aborted) return abort();
    input.on("data", receive);
    input.once("end", closed);
    input.once("error", closed);
    output.once("error", closed);
    query.signal.addEventListener("abort", abort, { once: true });
    send({
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        rootUri: query.rootUri,
        workspaceFolders: folders,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            definition: { linkSupport: true },
          },
        },
      },
    });
  });
}
