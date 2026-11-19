import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeIntelligenceTool } from "../../src/pi/code-intelligence-tool.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rook-code-intel-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  await writeFile(
    join(root, "src", "lib.ts"),
    "export function calculate(value: number): number { return value; }\n",
  );
  await writeFile(
    join(root, "src", "main.ts"),
    'import { calculate } from "./lib";\nconst result: string = calculate(1);\n',
  );
  return root;
}

async function run(root: string, input: Record<string, unknown>) {
  return createCodeIntelligenceTool(root).execute(
    "code",
    input,
    undefined,
    undefined,
    {} as never,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("coding-aware navigation and diagnostics", () => {
  it("resolves a symbol definition and references", async () => {
    const root = await fixture();
    const definition = JSON.stringify(
      await run(root, {
        action: "definition",
        path: "src/main.ts",
        line: 1,
        column: 10,
      }),
    );
    expect(definition).toContain("src/lib.ts:1:");
    const references = JSON.stringify(
      await run(root, {
        action: "references",
        path: "src/lib.ts",
        line: 1,
        column: 17,
      }),
    );
    expect(references).toContain("src/main.ts:1:");
  });

  it("reports focused TypeScript diagnostics and rejects paths outside the workspace", async () => {
    const root = await fixture();
    const diagnostics = JSON.stringify(
      await run(root, { action: "diagnostics", path: "src/main.ts" }),
    );
    expect(diagnostics).toContain("TS2322");
    await expect(
      run(root, { action: "diagnostics", path: "../outside.ts" }),
    ).rejects.toThrow("within the workspace");
    await expect(
      run(root, {
        action: "definition",
        path: "src/main.ts",
        line: 999,
        column: 1,
      }),
    ).rejects.toThrow("outside the source file");
  });
});
