import { afterEach, describe, expect, it } from "vitest";
import {
  setCapabilityOverrides,
  stripTerminalSequences,
  Markdown,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { markdownTheme, tone } from "../../src/tui/theme.js";
import { highlightCode } from "../../src/tui/syntax-highlight.js";

describe("fenced code syntax highlighting", () => {
  afterEach(() => setCapabilityOverrides({}));

  it("highlights TypeScript tokens and preserves the source text", () => {
    setCapabilityOverrides({ trueColor: true });
    const source =
      'export function add(a: number, b: number): number {\n  return a + b;\n}\nconst markup = "<tag>&";';
    const highlighted = highlightCode(source, "ts", tone);
    expect(highlighted).toHaveLength(4);
    expect(highlighted.join("\n")).toContain("\x1b[38;2;");
    expect(highlighted.map(stripTerminalSequences).join("\n")).toBe(source);
    expect(
      new Set(highlighted.join("").match(/\x1b\[38;2;[^m]+m/g)).size,
    ).toBeGreaterThan(2);
    const multiline = highlightCode(
      "/* first\nsecond */ const x = 1;",
      "ts",
      tone,
    );
    expect(multiline[1]).toContain("\x1b[38;2;");
    expect(stripTerminalSequences(multiline[1]!)).toContain("second */");
  });

  it.each([
    ["json", '{"enabled": true, "count": 3}'],
    ["bash", 'echo "hello"'],
    ["python", "def greet():\n    return 'hello'"],
  ])("supports %s fences", (language, source) => {
    const highlighted = highlightCode(source, language, tone);
    expect(highlighted.map(stripTerminalSequences).join("\n")).toBe(source);
    expect(highlighted.join("\n")).toContain("\x1b[");
  });

  it("keeps unknown, unlabelled, and oversized blocks as safe readable text", () => {
    const code = 'const markup = "<tag>&";';
    for (const language of ["unknown-language", undefined]) {
      const result = highlightCode(code, language, tone);
      expect(result.map(stripTerminalSequences).join("\n")).toBe(code);
    }
    expect(
      stripTerminalSequences(
        highlightCode("x".repeat(100_001), "typescript", tone)[0]!,
      ),
    ).toBe("x".repeat(100_001));
  });

  it("uses readable indexed colors when truecolor is unavailable", () => {
    setCapabilityOverrides({ trueColor: false });
    const rendered = highlightCode(
      "const count: number = 1;",
      "typescript",
      tone,
    );
    expect(rendered.join("\n")).toContain("\x1b[38;5;");
    expect(rendered.map(stripTerminalSequences).join("\n")).toBe(
      "const count: number = 1;",
    );
  });

  it("uses highlighted code in the Markdown renderer for streamed and restored content", () => {
    setCapabilityOverrides({ trueColor: true });
    const markdown = "```ts\nconst answer: number = 42;\n```";
    const component = new Markdown("", 0, 0, markdownTheme);
    component.setText("```ts\nconst answer: number = 42;\n");
    const streamed = component.render(100).join("\n");
    expect(streamed).toContain("```ts");
    expect(streamed).toContain("\x1b[38;2;");

    component.setText(markdown);
    const lines = component.render(100);
    const rendered = lines.join("\n");
    expect(rendered).toContain("```ts");
    expect(rendered).toContain("\x1b[38;2;");
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);

    component.setText(markdown);
    expect(component.render(100).join("\n")).toBe(rendered);
    const restored = new Markdown(markdown, 0, 0, markdownTheme).render(100);
    expect(restored.join("\n")).toBe(rendered);
  });
});
