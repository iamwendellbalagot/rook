import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { CHANGE_REVIEW_CONTEXT_BUDGET, reviewContextUnits } from "plyth";

/** Per-invocation guard. It supplements (never replaces) Rook's tool policy. */
export class ReviewBudget {
  readonly limitations = new Set<string>();
  private calls = 0;
  private remaining: number;
  private readonly supplementalBudget: number;

  constructor(prompt: string) {
    this.remaining = CHANGE_REVIEW_CONTEXT_BUDGET - reviewContextUnits(prompt);
    this.supplementalBudget = this.remaining;
    if (this.remaining < 0)
      throw new RangeError("Review context budget exceeded.");
  }

  admit(name: string): boolean {
    if (
      !["read", "rook_search"].includes(name) ||
      this.calls >= 2 ||
      this.remaining < 128
    ) {
      this.limitations.add(
        "Supplementary inspection was blocked by the two-call or context budget.",
      );
      return false;
    }
    this.calls++;
    return true;
  }

  bound(text: string): string {
    const cost = (value: string) =>
      reviewContextUnits(JSON.stringify([{ type: "text", text: value }]));
    if (cost(text) > this.remaining) {
      this.limitations.add(
        "Supplementary content was omitted because the context budget was exhausted.",
      );
      text = "[Review context budget exhausted; report partial coverage.]";
    }
    if (cost(text) > this.remaining) return "";
    this.remaining -= cost(text);
    return text;
  }

  extension(): InlineExtension {
    return (pi) => {
      pi.on("tool_call", (event) => {
        if (!this.admit(event.toolName))
          return {
            block: true,
            reason:
              "Review inspection budget exhausted or unsupported tool; report partial coverage.",
          };
      });
      pi.on("tool_result", (event) => {
        if (event.content.some((part) => part.type !== "text"))
          this.limitations.add("Non-text supplementary content was omitted.");
        return {
          content: [
            {
              type: "text",
              text: this.bound(
                event.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              ),
            },
          ],
          details: undefined,
        };
      });
      // Blocked calls can become transcript results without a tool_result hook.
      // Recheck the entire supplementary transcript before each provider turn.
      pi.on("context", (event) => {
        let remaining = this.supplementalBudget;
        const messages: typeof event.messages = event.messages.map(
          (message) => {
            if (message.role !== "toolResult") return message;
            let content = message.content.filter(
              (part) => part.type === "text",
            );
            const cost = reviewContextUnits(JSON.stringify(content));
            if (cost > remaining) {
              content = [];
              this.limitations.add(
                "Supplementary transcript exceeded the context budget; coverage is partial.",
              );
            } else remaining -= cost;
            const bounded = { ...message, content };
            delete bounded.details;
            delete bounded.nestedCalls;
            return bounded;
          },
        );
        return { messages };
      });
    };
  }
}
