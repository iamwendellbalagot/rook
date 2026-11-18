export class InferenceTimings {
  private lastAt: number;
  private readonly tools = new Set<string>();
  private approvals = 0;
  private toolMs = 0;
  private approvalMs = 0;
  private firstResponseMs?: number;
  private requests = 0;

  constructor(private readonly startedAt: number) {
    this.lastAt = startedAt;
  }

  private tick(now: number): void {
    const elapsed = Math.max(0, now - this.lastAt);
    if (this.approvals) this.approvalMs += elapsed;
    else if (this.tools.size) this.toolMs += elapsed;
    this.lastAt = now;
  }

  request(): void {
    this.requests++;
  }

  response(now: number): void {
    this.firstResponseMs ??= Math.max(0, now - this.startedAt);
  }

  tool(id: string, active: boolean, now: number): void {
    this.tick(now);
    if (active) {
      this.response(now);
      this.tools.add(id);
    } else this.tools.delete(id);
  }

  approval(active: boolean, now: number): void {
    this.tick(now);
    this.approvals = Math.max(0, this.approvals + (active ? 1 : -1));
  }

  finish(now: number) {
    this.tick(now);
    return {
      requests: this.requests,
      ...(this.firstResponseMs === undefined
        ? {}
        : { firstResponseMs: this.firstResponseMs }),
      toolMs: this.toolMs,
      approvalMs: this.approvalMs,
    };
  }
}
