import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  isSafeMemoryContent,
  type MemoryCaptureSettings,
  type PendingMemoryConfirmation,
  type RookStore,
} from "../db/store.js";
import type { GitSnapshot, RepositoryIdentity } from "../repo/workspace.js";

const SESSION_CAPTURE_LIMIT = 3;
const PENDING_CONFIRMATION_LIMIT = 3;
const MAX_READ_EVIDENCE = 3;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const EVIDENCE_TOOLS = new Set(["read", "edit", "write"]);

export interface MemoryCaptureStatus extends MemoryCaptureSettings {
  capturedThisSession: number;
  sessionCaptureLimit: number;
  pendingConfirmations: number;
}

export class MemoryCaptureManager {
  private prompt: string | undefined;
  private readonly startedFiles = new Map<
    string,
    { path: string; sourceType: "code" }
  >();
  private capturesThisSession = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly notices = new Set<(notice: string) => void>();

  constructor(
    private readonly store: RookStore,
    private readonly repository: RepositoryIdentity,
    private readonly snapshot: GitSnapshot | null,
  ) {}

  createExtension(): InlineExtension {
    const manager = this;
    return {
      name: "rook-memory-capture",
      factory(pi: ExtensionAPI) {
        pi.on("session_start", () => {
          manager.capturesThisSession = 0;
        });
        pi.on("before_agent_start", (event) => {
          manager.prompt =
            event.messageType === "user" ? event.prompt : undefined;
          manager.startedFiles.clear();
        });
        pi.on("tool_execution_start", (event) => {
          if (!EVIDENCE_TOOLS.has(event.toolName)) return;
          const path =
            typeof event.args?.path === "string" ? event.args.path : undefined;
          if (path)
            manager.startedFiles.set(event.toolCallId, {
              path,
              sourceType: "code",
            });
        });
        pi.on("tool_execution_end", (event) => {
          if (!EVIDENCE_TOOLS.has(event.toolName)) return;
          const file = manager.startedFiles.get(event.toolCallId);
          manager.startedFiles.delete(event.toolCallId);
          if (!event.isError && file)
            manager.startedFiles.set(`ok:${file.path}`, file);
        });
        pi.on("agent_settled", (event) => {
          const prompt = manager.prompt;
          const paths = [...manager.startedFiles.entries()]
            .filter(([id]) => id.startsWith("ok:"))
            .map(([, file]) => file.path);
          manager.prompt = undefined;
          manager.startedFiles.clear();
          if (event.aborted || !prompt) return;
          manager.enqueue(() => manager.captureSettled(prompt, paths));
        });
      },
    };
  }

  subscribeNotices(listener: (notice: string) => void): () => void {
    this.notices.add(listener);
    return () => this.notices.delete(listener);
  }

  status(): MemoryCaptureStatus {
    return {
      ...this.store.getMemoryCaptureSettings(this.repository.id),
      capturedThisSession: this.capturesThisSession,
      sessionCaptureLimit: SESSION_CAPTURE_LIMIT,
      pendingConfirmations: this.pending().length,
    };
  }

  pause(): MemoryCaptureStatus {
    return this.updateSettings({ paused: true });
  }

  resume(): MemoryCaptureStatus {
    return this.updateSettings({ paused: false });
  }

  optOut(): MemoryCaptureStatus {
    this.store.clearPendingMemoryConfirmations(this.repository.id);
    return this.updateSettings({ optedOut: true });
  }

  optIn(): MemoryCaptureStatus {
    return this.updateSettings({ optedOut: false });
  }

  pending(): PendingMemoryConfirmation[] {
    return this.store.listPendingMemoryConfirmations(this.repository.id);
  }

  confirm(pendingId: string): string {
    const settings = this.store.getMemoryCaptureSettings(this.repository.id);
    if (settings.paused || settings.optedOut) {
      return "Memory capture is paused or opted out; resume/opt in before confirming.";
    }
    if (this.capturesThisSession >= SESSION_CAPTURE_LIMIT) {
      return `Session capture limit reached (${SESSION_CAPTURE_LIMIT}).`;
    }
    const result = this.store.confirmPendingMemory(
      this.repository.id,
      pendingId,
    );
    if (!result) return "No pending memory matches that ID in this repository.";
    if (result.created) this.capturesThisSession += 1;
    return result.created
      ? `Confirmed memory ${result.memory.id}: ${result.memory.title}`
      : `This claim already exists as memory ${result.memory.id}; duplicate was merged.`;
  }

  cancel(pendingId: string): boolean {
    return this.store.cancelPendingMemory(this.repository.id, pendingId);
  }

  forget(memoryId: string): boolean {
    return this.store.forgetMemory(memoryId, "User requested forget.");
  }

  show(): string[] {
    return this.store
      .listMemories(this.repository.id)
      .map((memory) => `${memory.id} · ${memory.status} · ${memory.title}`);
  }

  drainNotices(): string[] {
    const result = [...this.noticeQueue];
    this.noticeQueue.length = 0;
    return result;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private readonly noticeQueue: string[] = [];

  private updateSettings(
    settings: Partial<MemoryCaptureSettings>,
  ): MemoryCaptureStatus {
    this.store.setMemoryCaptureSettings(this.repository.id, settings);
    return this.status();
  }

  private enqueue(capture: () => Promise<void>): void {
    this.queue = this.queue
      .then(capture)
      .catch(() =>
        this.notify(
          "Memory capture could not be completed; the run was unaffected.",
        ),
      );
  }

  private async captureSettled(
    prompt: string,
    readPaths: string[],
  ): Promise<void> {
    const settings = this.store.getMemoryCaptureSettings(this.repository.id);
    if (settings.paused || settings.optedOut) return;
    const explicitClaim = parseRememberPrompt(prompt);
    if (explicitClaim) {
      if (this.pending().length >= PENDING_CONFIRMATION_LIMIT) {
        this.notify(
          `There are already ${PENDING_CONFIRMATION_LIMIT} pending explicit memories; confirm or cancel one first.`,
        );
        return;
      }
      if (!isSafeMemoryContent(explicitClaim)) {
        this.notify(
          "Explicit memory request rejected because it may contain sensitive data.",
        );
        return;
      }
      const kind = classifyKind(explicitClaim);
      const pending = this.store.queueMemoryConfirmation(this.repository.id, {
        kind,
        title: makeTitle(explicitClaim),
        body: explicitClaim,
      });
      this.notify(
        `Pending explicit memory [${pending.id}]: ${pending.title}. Confirm with /memory confirm ${pending.id}, or discard with /memory cancel ${pending.id}.`,
      );
      return;
    }

    if (this.capturesThisSession >= SESSION_CAPTURE_LIMIT) return;
    const statement = extractHighSignalStatement(prompt);
    if (!statement) return;
    const evidence = await collectEvidence(
      this.repository.root,
      readPaths,
      this.snapshot?.headCommit ?? null,
    );
    if (evidence.length === 0) return;
    const currentSettings = this.store.getMemoryCaptureSettings(
      this.repository.id,
    );
    if (currentSettings.paused || currentSettings.optedOut) return;
    const result = this.store.recordMemory({
      repoId: this.repository.id,
      kind: classifyKind(statement),
      title: makeTitle(statement),
      body: statement,
      status: "candidate",
      confidence: 0.55,
      sourceClass: "user",
      evidence,
    });
    if (!result.created) return;
    this.capturesThisSession += 1;
    this.notify(
      `Saved a memory candidate ${result.memory.id.slice(0, 8)} for later review: ${result.memory.title}`,
    );
  }

  private notify(notice: string): void {
    this.noticeQueue.push(notice);
    if (this.noticeQueue.length > 10) this.noticeQueue.shift();
    for (const listener of this.notices) {
      try {
        listener(notice);
      } catch {
        // A detached UI must not interfere with capture persistence.
      }
    }
  }
}

export function parseRememberPrompt(prompt: string): string | undefined {
  const match = /^\s*remember\s*:\s*([\s\S]*?)\s*$/i.exec(prompt);
  const claim = match?.[1] ? normalizeClaim(match[1]) : undefined;
  if (!claim || claim.length < 8 || claim.length > 1000) return undefined;
  return claim;
}

export function extractHighSignalStatement(prompt: string): string | undefined {
  const pattern =
    /(?:we\s+(?:decided|chose|selected|agreed|prefer|fixed)|the\s+(?:project|team)\s+(?:uses|prefers|requires)|the\s+fix\s+(?:is|was)|root\s+cause\s+(?:is|was)|always\s+(?:use|prefer|run)|never\s+(?:use|commit))\b[^\n.!?]{8,500}(?:[.!?]|$)/i;
  const match = pattern.exec(prompt);
  const statement = match?.[0] ? normalizeClaim(match[0]) : undefined;
  return statement && isSafeMemoryContent(statement) ? statement : undefined;
}

function classifyKind(statement: string): string {
  if (/\b(?:decided|chose|selected|agreed)\b/i.test(statement))
    return "decision";
  if (/\b(?:fixed|fix|root cause)\b/i.test(statement)) return "fix";
  if (/\b(?:always|never|prefer|convention)\b/i.test(statement))
    return "convention";
  return "architecture";
}

function makeTitle(statement: string): string {
  const normalized = statement.replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}…`;
}

function normalizeClaim(value: string): string {
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function collectEvidence(
  workspaceRoot: string,
  paths: string[],
  commitSha: string | null,
): Promise<
  Array<{
    path: string;
    contentSha256: string;
    commitSha: string | null;
    sourceType: "code";
  }>
> {
  const root = await realpath(workspaceRoot);
  const evidence = [];
  for (const path of [...new Set(paths)].slice(0, MAX_READ_EVIDENCE)) {
    const validated = await hashSafeRead(root, path);
    if (!validated) continue;
    evidence.push({
      path: relative(root, validated.path),
      contentSha256: validated.contentSha256,
      commitSha,
      sourceType: "code" as const,
    });
  }
  return evidence;
}

async function hashSafeRead(
  root: string,
  inputPath: string,
): Promise<{ path: string; contentSha256: string } | undefined> {
  try {
    if (inputPath.includes("\0")) return undefined;
    const segments = inputPath.split(/[\\/]+/).filter(Boolean);
    if (
      segments.includes("..") ||
      segments.some((segment) => isSensitiveSegment(segment)) ||
      isSensitiveFile(segments.at(-1) ?? "")
    ) {
      return undefined;
    }
    const absolutePath = isAbsolute(inputPath)
      ? resolve(inputPath)
      : resolve(root, inputPath);
    const relativePath = relative(root, absolutePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return undefined;
    }
    const info = await lstat(absolutePath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink > 1 ||
      info.size > MAX_EVIDENCE_BYTES
    ) {
      return undefined;
    }
    const canonicalPath = await realpath(absolutePath);
    const canonicalRelative = relative(root, canonicalPath);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      return undefined;
    }
    const file = await open(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const openedInfo = await file.stat();
      if (
        !openedInfo.isFile() ||
        openedInfo.nlink > 1 ||
        openedInfo.size > MAX_EVIDENCE_BYTES
      ) {
        return undefined;
      }
      const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_EVIDENCE_BYTES) return undefined;
      return {
        path: canonicalPath,
        contentSha256: createHash("sha256")
          .update(buffer.subarray(0, bytesRead))
          .digest("hex"),
      };
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

function isSensitiveSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return (
    normalized === ".git" ||
    normalized === ".ssh" ||
    normalized === ".aws" ||
    normalized === ".azure" ||
    normalized === ".gnupg" ||
    normalized === ".config" ||
    normalized === ".pi" ||
    normalized === "node_modules" ||
    normalized === "credentials" ||
    normalized.startsWith(".env")
  );
}

function isSensitiveFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return (
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx") ||
    normalized === "id_rsa" ||
    normalized === "id_ed25519"
  );
}
