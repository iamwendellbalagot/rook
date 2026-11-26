import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TaskReceipt } from "../../src/pi/task-receipt.js";

it("distinguishes a mixed edit, an unattributed change, and checks before cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rook-receipt-"));
  try {
    const cwd = await realpath(root);
    const file = (name: string) => join(cwd, name);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init");
    await writeFile(file("mixed.ts"), "initial\n");
    await writeFile(file("readme.md"), "initial\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Initial",
    );
    await writeFile(file("mixed.ts"), "user change\n");
    await writeFile(file("readme.md"), "already dirty\n");

    const receipt = new TaskReceipt(cwd);
    receipt.started("bash", "test", {
      command: "npm run typecheck -- --sensitive-argument=placeholder",
    });
    receipt.finished("test", false);
    expect(receipt.render()).toContain("Passed when run: npm run typecheck");
    await writeFile(file("readme.md"), "external editor change\n");
    expect(receipt.render()).toContain(
      "workspace change (freshness uncertain)",
    );
    receipt.started("edit", "edit", { path: file("mixed.ts") });
    await writeFile(file("mixed.ts"), "user and Rook change\n");
    receipt.finished("edit", false);
    await writeFile(file("readme.md"), "unattributed change\n");
    receipt.blocked(
      "bash",
      "blocked",
      { command: "node --test src/cache.test.mjs" },
      "The required Bubblewrap sandbox runtime is unavailable.",
    );
    receipt.outcome = "cancelled";

    const text = receipt.render();
    expect(text).toContain("Build-mode run cancelled");
    expect(text).toContain("Successful Rook edit/write: mixed.ts");
    expect(text).toContain("Dirty at run start: mixed.ts, readme.md");
    expect(text).toContain(
      "Observed dirty-state changes not attributed to file tools: readme.md",
    );
    expect(text).toContain(
      "Passed before a later operation or workspace change (freshness uncertain): npm run typecheck",
    );
    expect(text).toContain("Blocked (sandbox unavailable): node --test");
    expect(text).not.toContain("placeholder");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
