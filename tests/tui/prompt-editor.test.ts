import { describe, expect, it } from "vitest";
import {
  CURSOR_MARKER,
  ProcessTerminal,
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PromptEditor } from "../../src/tui/prompt-editor.js";
import { editorTheme } from "../../src/tui/theme.js";

function createEditor(): PromptEditor {
  const editor = new PromptEditor(
    new TuiAltScreen(new ProcessTerminal()),
    editorTheme,
  );
  editor.focused = true;
  return editor;
}

describe("prompt editor", () => {
  it("frames a right-aligned prompt with rounded heavy edges and equal margins", () => {
    const editor = createEditor();
    editor.setText("hello");
    const rendered = editor.render(60);
    const lines = rendered.map(stripTerminalSequences);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^  ╭━+╮  $/);
    expect(lines[2]).toMatch(/^  ╰━+╯  $/);
    expect(lines[1]).toMatch(/^  ┃ +rook > hello  ┃  $/);
    expect(lines[1]!.indexOf("rook >")).toBeGreaterThan(30);
    expect(rendered[0]).toContain("\x1b[1m");
    expect(rendered[1]).toContain("\x1b[1m");
    expect(rendered[1]).toContain(CURSOR_MARKER);
    expect(rendered.every((line) => visibleWidth(line) === 60)).toBe(true);
  });

  it.each([0, 1, 4, 9, 10, 11, 16, 17, 18, 24, 40, 80, 120])(
    "keeps empty, Unicode, and wrapped prompts within %i columns",
    (width) => {
      const editor = createEditor();
      for (const text of [
        "",
        "hello",
        "你好 👋 café",
        "a long prompt ".repeat(20),
      ]) {
        editor.setText(text);
        expect(
          editor.render(width).every((line) => visibleWidth(line) <= width),
        ).toBe(true);
        expect(editor.getText()).toBe(text);
      }
    },
  );

  it("keeps the label out of submitted text and preserves cursor editing", () => {
    const editor = createEditor();
    let submitted = "";
    editor.onSubmit = (text) => {
      submitted = text;
    };
    editor.setText("hello");
    editor.render(60);
    editor.handleInput("\x1b[D");
    editor.handleInput("!");
    expect(editor.getText()).toBe("hell!o");
    editor.handleInput("\r");
    expect(submitted).toBe("hell!o");
    expect(editor.getText()).toBe("");
    expect(editor.render(60).map(stripTerminalSequences).join("\n")).toContain(
      "rook >",
    );
  });

  it("preserves pasted text and cursor placement across resizes", () => {
    const editor = createEditor();
    const text = "a pasted prompt with 你好 and several words";
    editor.handleInput(`\x1b[200~${text}\x1b[201~`);
    for (const width of [80, 24, 60]) {
      const lines = editor.render(width);
      const cursorRow = lines.find((line) => line.includes(CURSOR_MARKER))!;
      expect(cursorRow).toBeDefined();
      const cursorColumn = visibleWidth(cursorRow.split(CURSOR_MARKER)[0]!);
      expect(cursorColumn).toBeGreaterThanOrEqual(4);
      expect(cursorColumn).toBeLessThan(width - 4);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
    expect(editor.getExpandedText()).toBe(text);
    editor.handleInput("!");
    expect(editor.getExpandedText()).toBe(`${text}!`);
  });

  it("wraps and scrolls multiline input without losing the cursor or scroll hints", () => {
    const editor = createEditor();
    editor.setText(
      Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
    );
    let lines = editor.render(40);
    expect(stripTerminalSequences(lines[0]!)).toContain("↑");
    expect(lines.join("").split(CURSOR_MARKER)).toHaveLength(2);
    expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);
    editor.handleInput("\x01"); // Ctrl+A: start of the current line.
    for (let i = 0; i < 40; i++) editor.handleInput("\x1b[A");
    lines = editor.render(40);
    expect(stripTerminalSequences(lines.at(-1)!)).toContain("↓");
    expect(lines.join("")).toContain(CURSOR_MARKER);
  });

  it("maps mouse clicks to the editable text after the right-hand prefix", () => {
    const editor = createEditor();
    editor.setText("hello");
    const line = stripTerminalSequences(editor.render(60)[1]!);
    const x = line.indexOf("hello") + 2;
    const result = editor.handleMouse({
      type: "click",
      button: "left",
      x,
      y: 1,
      screenX: x,
      screenY: 1,
      width: 60,
      height: 3,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(result?.focus).toBe(true);
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
    editor.handleInput("!");
    expect(editor.getText()).toBe("he!llo");
  });
});
