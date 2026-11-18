import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { tone } from "./theme.js";

export interface InferenceStats {
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs: number;
  requests?: number;
  firstResponseMs?: number;
  toolMs?: number;
  approvalMs?: number;
}

/** A completed prompt's totals, kept on one line even on narrow terminals. */
export class InferenceStatsLine implements Component {
  constructor(private readonly stats: InferenceStats) {}

  render(width: number): string[] {
    const count = (value: number | undefined): number | undefined =>
      value !== undefined && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const input = count(this.stats.inputTokens);
    const output = count(this.stats.outputTokens);
    const seconds = Number.isFinite(this.stats.elapsedMs)
      ? Math.max(0, this.stats.elapsedMs) / 1000
      : 0;
    const rate =
      output !== undefined && seconds > 0 ? (output / seconds).toFixed(1) : "—";
    let text = `in ${input ?? "—"} · out ${output ?? "—"} · ${rate} tok/s · ${seconds.toFixed(1)}s elapsed`;
    if (this.stats.requests !== undefined) {
      const seconds = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);
      text += ` · ${this.stats.requests} requests · first ${this.stats.firstResponseMs === undefined ? "—" : `${seconds(this.stats.firstResponseMs)}s`} · tools ${seconds(this.stats.toolMs ?? 0)}s · approval ${seconds(this.stats.approvalMs ?? 0)}s`;
    }
    const padding = " ".repeat(Math.min(2, Math.max(0, width - 1)));
    return [
      truncateToWidth(`${padding}${tone(text, "dim")}`, Math.max(0, width)),
    ];
  }

  invalidate(): void {}
}
