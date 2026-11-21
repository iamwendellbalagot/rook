import { describe, expect, it } from "vitest";
import { MaskedInput } from "../../src/tui/provider-auth-dialog.js";

const SYNTHETIC_SECRET =
  "AUDIT_ONLY_NOT_A_REAL_CREDENTIAL_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

describe("provider authentication secret input", () => {
  it("masks before narrow-width rendering and preserves the submitted value", () => {
    const input = new MaskedInput();
    input.setValue(SYNTHETIC_SECRET);

    const rendered = input.render(24).join("\n");

    expect(rendered).not.toContain(SYNTHETIC_SECRET);
    expect(rendered).not.toContain("AUDIT_ONLY");
    expect(rendered).toContain("•");
    expect(input.getValue()).toBe(SYNTHETIC_SECRET);
  });

  it("never reveals fragments after cursor movement", () => {
    const input = new MaskedInput();
    input.setValue(SYNTHETIC_SECRET);
    input.handleInput("\u0001"); // line start
    input.handleInput("\u0006"); // cursor right

    const rendered = input.render(120).join("\n");

    expect(rendered).not.toContain(SYNTHETIC_SECRET);
    expect(rendered).not.toContain("AUDIT");
    expect(rendered).not.toContain("CREDENTIAL");
    expect(rendered).toContain("•");
    expect(input.getValue()).toBe(SYNTHETIC_SECRET);
  });
});
