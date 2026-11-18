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
    {
      subject: "Implement project memory indexing",
      files: ["src/memory/index.ts", "tests/memory.test.ts"],
      fileCount: 2,
    },
    {
      subject: "Refactor agent harness",
      files: ["src/agent.ts"],
      fileCount: 1,
    },
    {
      subject: "Plan: change-impact testing",
      files: ["src/pi/change-impact.ts"],
      fileCount: 1,
    },
  ],
};

describe("home dashboard", () => {
  beforeEach(() => setCapabilityOverrides({ trueColor: true, images: null }));
  afterEach(() => setCapabilityOverrides({}));

  it("keeps the existing brand left of the mountain scene", () => {
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
    const brandStart = plain[1]!.indexOf("██  ██");
    const mountainStart = plain[1]!.indexOf("▄");
    expect(mountainStart).toBeGreaterThanOrEqual(0);
    expect(brandStart).toBeGreaterThanOrEqual(0);
    expect(mountainStart).toBeGreaterThan(brandStart);
    expect(mountainStart - (brandStart + 29)).toBeGreaterThanOrEqual(4);
    expect(plain[0]).toBe("");
  });

  it("hides the mountain below 120 columns and preserves the brand", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    const lines = dashboard.render(119);
    const screen = lines.map(stripTerminalSequences);
    expect(screen.join("\n")).toContain(
      "A coding agent that grows with your codebase.",
    );
    expect(lines.join("")).not.toContain("\x1b[38;5;");
    expect(screen[0]).toBe("");
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

  it("shows commit subjects and changed files without raw control sequences", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData({
      ...data,
      recentActivity: [
        {
          subject: "Check\u001b[31m suspicious \u0007 output",
          files: ["src/check.ts"],
          fileCount: 1,
        },
      ],
    });
    const screen = dashboard.render(160).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("Check suspicious output");
    expect(screen).toContain("src/check.ts");
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

  it("renders the selected mode without a redundant mode label", () => {
    const dashboard = new HomeScreenBody();
    dashboard.setDashboardData(data);
    const screen = dashboard.render(100).map(stripTerminalSequences).join("\n");
    expect(screen).toContain("▶ /plan  Analyze and plan · read-only");
    expect(screen).not.toContain("MODE  ▶");
  });
});
