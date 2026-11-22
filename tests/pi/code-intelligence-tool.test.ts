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

async function run(
  root: string,
  input: Record<string, unknown>,
  external = false,
) {
  return createCodeIntelligenceTool(root, () => external).execute(
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
  it.each(["main.py", "main.go"])(
    "reports external support as unavailable in Plan mode for %s",
    async (path) => {
      const root = await fixture();
      await writeFile(join(root, path), "");
      const result = await run(root, { action: "diagnostics", path });
      expect(result.details).toMatchObject({ coverage: "unavailable" });
      expect(JSON.stringify(result)).toContain(
        "require Build mode with sandboxing enabled",
      );
    },
  );
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

// Run explicitly with installed, trusted binaries and a Linux sandbox.
const live =
  process.platform === "linux" &&
  process.env.ROOK_TEST_LANGUAGE_SERVERS === "1";

describe.runIf(live)("sandboxed semantic backends", () => {
  it.each([
    {
      main: "main.py",
      lib: "lib.py",
      use: "from lib import twice\nvalue: str = twice(2)\n",
      declaration: "def twice(n: int) -> int:\n    return n * 2\n",
      line: 2,
      column: 14,
      diagnostic: /not assignable|cannot be assigned/i,
    },
    {
      main: "main.go",
      lib: "lib.go",
      use: "package fixture\n\nvar result string = Twice(2)\n",
      declaration:
        "package fixture\n\nfunc Twice(n int) int { return n * 2 }\n",
      line: 3,
      column: 21,
      diagnostic: /cannot use|cannot assign/i,
    },
  ])(
    "resolves cross-file semantics and a type error in $main",
    async ({ main, lib, use, declaration, line, column, diagnostic }) => {
      const root = await fixture();
      await writeFile(join(root, main), use);
      await writeFile(join(root, lib), declaration);
      if (main.endsWith(".go"))
        await writeFile(
          join(root, "go.mod"),
          "module example.test/fixture\n\ngo 1.20\n",
        );
      const params = { path: main, line, column };
      const definition = await run(
        root,
        { ...params, action: "definition" },
        true,
      );
      expect(definition.details).toMatchObject({ coverage: "partial" });
      expect(JSON.stringify(definition)).toContain(`definition: ${lib}:`);
      const references = await run(
        root,
        { ...params, action: "references" },
        true,
      );
      expect(references.details).toMatchObject({ coverage: "partial" });
      expect(JSON.stringify(references)).toContain(`reference: ${main}:`);
      expect(JSON.stringify(references)).toContain(`reference: ${lib}:`);
      const diagnostics = await run(
        root,
        { path: main, action: "diagnostics" },
        true,
      );
      expect(diagnostics.details).toMatchObject({ coverage: "partial" });
      expect(JSON.stringify(diagnostics)).toMatch(diagnostic);
    },
    70_000,
  );
});
