import { describe, expect, it } from "vitest";
import { InferenceTimings } from "../../src/tui/inference-timings.js";

describe("inference timings", () => {
  it("counts requests and measures tools excluding approval waits without double counting overlapping tools", () => {
    const timing = new InferenceTimings(0);
    timing.request();
    timing.tool("a", true, 100);
    timing.tool("b", true, 200);
    timing.approval(true, 300);
    timing.approval(false, 700);
    timing.tool("a", false, 800);
    timing.tool("b", false, 900);
    timing.request();
    timing.response(1000);
    expect(timing.finish(1200)).toEqual({
      requests: 2,
      firstResponseMs: 100,
      toolMs: 400,
      approvalMs: 400,
    });
  });

  it("does not invent a first response for failed requests and includes outstanding waits", () => {
    const timing = new InferenceTimings(100);
    timing.request();
    timing.approval(true, 200);
    expect(timing.finish(600)).toEqual({
      requests: 1,
      toolMs: 0,
      approvalMs: 400,
    });
  });
});
