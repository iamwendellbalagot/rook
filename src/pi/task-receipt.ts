import { relative, resolve, sep } from "node:path";
import {
  captureReceiptWorkspace,
  isReceiptPath,
} from "./plan-inspection-tool.js";

const MAX_ROWS = 12;
const CHECK_PREFIX =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w:-]{1,32})?|check|typecheck|lint|build)|(?:npx\s+)?(?:vitest|jest|mocha|pytest|tsc|eslint)|(?:go|cargo)\s+test|node\s+--test|python(?:3)?\s+-m\s+pytest)(?=\s|$)/;
const READ_ONLY_TOOLS = new Set([
  "read",
  "ls",
  "find",
  "rook_inspect",
  "rook_search",
  "rook_map",
  "rook_code",
  "rook_impact",
]);

type Check = {
  label: string;
  status: "blocked" | "started" | "passed" | "failed or incomplete";
  revision: number;
  sandboxUnavailable: boolean;
  fingerprint?: string;
};

export class TaskReceipt {
  private readonly start: ReturnType<typeof snapshot>;
  private readonly edits = new Set<string>();
  private readonly pendingEdits = new Map<string, string | undefined>();
  private readonly checks = new Map<string, Check>();
  private revision = 0;
  private partial = false;
  outcome: "finished" | "failed" | "cancelled" = "finished";

  constructor(private readonly cwd: string) {
    this.start = snapshot(cwd);
  }

  blocked(
    tool: string,
    id: string,
    input: Record<string, unknown>,
    reason: string,
  ) {
    if (tool !== "bash") return;
    this.recordCheck(
      id,
      input.command,
      "blocked",
      reason.includes("required Bubblewrap sandbox runtime is unavailable"),
    );
  }

  started(tool: string, id: string, args: unknown) {
    if (this.checks.get(id)?.status === "blocked") return;
    const input =
      args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    if (tool === "edit" || tool === "write") {
      this.revision++;
      const path =
        typeof input.path === "string"
          ? relative(this.cwd, resolve(this.cwd, input.path))
              .split(sep)
              .join("/")
          : "";
      this.pendingEdits.set(id, isReceiptPath(path) ? path : undefined);
    } else if (tool === "bash") {
      // Bash may change files even when it looks like a verification command.
      this.revision++;
      this.recordCheck(id, input.command, "started");
    } else if (!READ_ONLY_TOOLS.has(tool)) {
      // External/unknown tools do not have a filesystem attribution contract.
      this.revision++;
    }
  }

  finished(id: string, isError: boolean) {
    if (this.pendingEdits.has(id)) {
      const path = this.pendingEdits.get(id);
      this.pendingEdits.delete(id);
      if (!isError) {
        if (path && (this.edits.has(path) || this.edits.size < MAX_ROWS)) {
          this.edits.add(path);
        } else this.partial = true;
      }
    }
    const check = this.checks.get(id);
    if (check?.status === "started") {
      check.status = isError ? "failed or incomplete" : "passed";
      const value = fingerprint(snapshot(this.cwd));
      if (value !== undefined) check.fingerprint = value;
    }
  }

  render(): string {
    const end = snapshot(this.cwd);
    const before = this.start;
    const lines = [`Build-mode run ${this.outcome} · task receipt`];
    const list = (label: string, paths: Iterable<string>) => {
      const items = [...paths];
      const remaining =
        items.length > MAX_ROWS ? ` (+${items.length - MAX_ROWS} more)` : "";
      if (items.length) {
        lines.push(
          `  ${label}: ${items.slice(0, MAX_ROWS).join(", ")}${remaining}`,
        );
      }
    };
    list("Successful Rook edit/write", this.edits);
    if (before) list("Dirty at run start", before.paths.keys());
    if (before && end && before.head === end.head) {
      const observed = (scope: typeof before, path: string) =>
        scope.paths.get(path) !== undefined ||
        (!scope.partial && !scope.paths.has(path));
      const paths = new Set([...before.paths.keys(), ...end.paths.keys()]);
      list(
        "Observed dirty-state changes not attributed to file tools",
        [...paths].filter(
          (path) =>
            !this.edits.has(path) &&
            observed(before, path) &&
            observed(end, path) &&
            before.paths.get(path) !== end.paths.get(path),
        ),
      );
    }
    if (
      !before ||
      !end ||
      before.head !== end.head ||
      before.partial ||
      end.partial ||
      this.partial ||
      this.pendingEdits.size
    ) {
      lines.push("  Receipt is partial; inspect /diff for the current state.");
    }
    if (!this.edits.size)
      lines.push("  No successful in-workspace file edits recorded.");
    if (!this.checks.size)
      lines.push("  No recognized checks observed in this run.");
    let hasPass = false;
    for (const check of this.checks.values()) {
      let status: string;
      switch (check.status) {
        case "started":
          status = "Incomplete";
          break;
        case "blocked":
          status = check.sandboxUnavailable
            ? "Blocked (sandbox unavailable)"
            : "Blocked";
          break;
        case "failed or incomplete":
          status = "Failed or incomplete";
          break;
        case "passed":
          hasPass = true;
          status =
            check.revision === this.revision &&
            check.fingerprint !== undefined &&
            check.fingerprint === fingerprint(end)
              ? "Passed when run"
              : "Passed before a later operation or workspace change (freshness uncertain)";
          break;
      }
      lines.push(`  ${status}: ${check.label}`);
    }
    if (hasPass) {
      lines.push(
        "  A pass records the command outcome, not verification of the full final diff.",
      );
    }
    lines.push("  Current diff: /diff");
    return lines.join("\n");
  }

  private recordCheck(
    id: string,
    command: unknown,
    status: "blocked" | "started",
    sandboxUnavailable = false,
  ) {
    if (typeof command !== "string") return;
    const trimmed = command.trim();
    const prefix = CHECK_PREFIX.exec(trimmed)?.[0];
    // Do not infer a check outcome from compound shell syntax or log raw arguments.
    if (!prefix || /[^a-zA-Z0-9_./:@%+=,\- \t]/.test(trimmed)) return;
    if (!this.checks.has(id) && this.checks.size >= MAX_ROWS) {
      this.checks.delete(this.checks.keys().next().value!);
      this.partial = true;
    }
    const label = prefix
      .replace(/test:[\w:-]+$/, "test:<script>")
      .replace(/\s+/g, " ");
    this.checks.set(id, {
      label: label + (prefix.length < trimmed.length ? " …" : ""),
      status,
      revision: this.revision,
      sandboxUnavailable,
    });
  }
}

function fingerprint(value: ReturnType<typeof snapshot>): string | undefined {
  if (!value || value.partial) return undefined;
  return JSON.stringify([
    value.head,
    [...value.paths.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function snapshot(cwd: string) {
  try {
    return captureReceiptWorkspace(cwd);
  } catch {
    return undefined;
  }
}
