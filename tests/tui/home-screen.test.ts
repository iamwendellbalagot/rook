import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setCapabilityOverrides,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { tone } from "../../src/tui/theme.js";
import { HomeScreenBody } from "../../src/tui/home-screen.js";

const data = {
  cwd: "/workspace/sample-project",
  repositoryName: "sample-project",
  repositoryId: "repo-12345678",
  branch: "feature/dashboard",
  mode: "plan" as const,
  memoryCount: 12,
  snapshotDirty: false,
  recentActivity: [
    { role: "user" as const, text: "Implement project memory indexing" },
    { role: "user" as const, text: "Refactor agent harness" },
    { role: "user" as const, text: "Plan: change-impact testing" },
  ],
};

describe("home dashboard", () => {
  beforeEach(() => setCapabilityOverrides({ trueColor: true, images: null }));
  afterEach(() => setCapabilityOverrides({}));

  it("shows the existing brand and title with the mountain scene at top right", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    const lines = dashboard.render(160);
    const plain = lines.map(stripTerminalSequences);
    expect(plain.join("\n")).toContain(
      "A coding agent that grows with your codebase.",
    );
    expect(plain.some((line) => line.includes("/"))).toBe(true);
    expect(lines.join("")).toContain("\x1b[38;2;");
    expect(lines.join("")).toContain("\x1b[48;2;");
    expect(plain.join("\n")).toContain("PROJECT CONTEXT");
    expect(plain.join("\n")).toContain("feature/dashboard");
    expect(lines.slice(0, 7).every((line) => visibleWidth(line) <= 160)).toBe(
      true,
    );
  });

  it("uses the shared border color for dashboard panels", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    const lines = dashboard.render(120);
    expect(lines.some((line) => line.includes(tone("╭", "border", true)))).toBe(
      true,
    );
    expect(tone("│", "border")).toContain("\x1b[38;2;141;219;255m");
  });

  it("adapts layout from three panels to stacked panels and compact mode", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    const wide = dashboard.render(160).map(stripTerminalSequences).join("\n");
    expect(wide).toContain("QUICK ACTIONS");
    expect(wide).toContain("RECENT ACTIVITY");
    expect(wide).toContain("PROJECT CONTEXT");
    for (const width of [120, 100, 80, 60, 40, 8, 1]) {
      expect(
        dashboard.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
    expect(
      dashboard.render(80).map(stripTerminalSequences).join("\n"),
    ).toContain("PROJECT");
    expect(
      dashboard.render(60).map(stripTerminalSequences).join("\n"),
    ).toContain("/plan");
  });

  it("includes real session activity and avoids raw control sequences", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData({
      ...data,
      recentActivity: [
        { role: "user", text: "Check\u001b[31m suspicious \u0007 output" },
      ],
    });
    const screen = dashboard.render(160).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("Check suspicious output");
    expect(screen).not.toContain("\u001b");
  });

  it("renders plain-text mountain art when color output is unavailable", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    setCapabilityOverrides({ trueColor: false, images: null });
    const previousTerm = process.env.TERM;
    const previousNoColor = process.env.NO_COLOR;
    process.env.TERM = "dumb";
    process.env.NO_COLOR = "1";
    try {
      const screen = dashboard
        .render(160)
        .map(stripTerminalSequences)
        .join("\n");
      expect(screen).toContain("/\\");
    } finally {
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it("uses an indexed 16-color palette when true color is unavailable", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    const previousTerm = process.env.TERM;
    const previousColor = process.env.COLORTERM;
    const previousNoColor = process.env.NO_COLOR;
    process.env.TERM = "xterm";
    delete process.env.COLORTERM;
    delete process.env.NO_COLOR;
    setCapabilityOverrides({ trueColor: false, images: null });
    try {
      const screen = dashboard.render(160).join("");
      expect(screen).toContain("\x1b[38;5;");
      expect(screen).toContain("\x1b[48;5;");
    } finally {
      if (previousTerm === undefined) delete process.env.TERM;
      else process.env.TERM = previousTerm;
      if (previousColor === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = previousColor;
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it("switches the home mode by clicking the mode bar", () => {
    const dashboard = new HomeScreenBody();
    let selected: string | undefined;
    dashboard.setDashboardData({
      ...data,
      onModeChange: (mode) => {
        selected = mode;
      },
    });
    dashboard.handleMouse?.({
      type: "click",
      button: "left",
      x: 80,
      y: 8,
      screenX: 80,
      screenY: 10,
      width: 160,
      height: 40,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(selected).toBe("build");
  });
});
