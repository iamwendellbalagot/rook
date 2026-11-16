import { describe, expect, it } from "vitest";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { MockAgentGateway } from "../../src/pi/mock-agent-gateway.js";
import { createRookTui } from "../../src/tui/rook-tui.js";

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 36;
  kittyProtocolActive = false;
  started = 0;
  stopped = 0;
  writes: string[] = [];
  private onInput?: (data: string) => void;
  private onResize?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started += 1;
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop(): void {
    this.stopped += 1;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgramStatus(): void {}
  setProgress(): void {}

  input(data: string): void {
    this.onInput?.(data);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
}

describe("Rook TUI shell", () => {
  it("renders the home view, handles resize, and restores the terminal on exit", async () => {
    const terminal = new FakeTerminal();
    const app = createRookTui({
      cwd: "/workspace/sample-project",
      branch: "feature/ui",
      gateway: new MockAgentGateway(),
      terminal,
    });
    const finished = app.start();
    app.tui.renderNow(true);

    expect(terminal.started).toBe(1);
    expect(terminal.writes.join("")).toContain("rook.");

    await app.submit("hello");
    app.tui.renderNow(true);
    expect(terminal.writes.join("")).toContain("Mock response to: hello");

    const writesBeforeResize = terminal.writes.length;
    terminal.resize(60, 20);
    app.tui.renderNow(true);
    expect(terminal.writes.length).toBeGreaterThan(writesBeforeResize);
    expect(app.tui.render(60).every((line) => visibleWidth(line) <= 60)).toBe(
      true,
    );

    terminal.input("\u0003");
    await finished;
    expect(terminal.stopped).toBe(1);
  });
});
