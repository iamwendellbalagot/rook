import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  loadRookOAuthDesign,
  patchPiOAuthPageModule,
} from "../../scripts/patch-pi-oauth-page.mjs";

const upstreamFixture = `const LOGO_SVG = "pi";
function escapeHtml(value){return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}
function renderPage(options) { return "old Pi page" }
export function oauthSuccessHtml(message){return renderPage({title:"Authentication successful",heading:"Authentication successful",message})}
async function startOAuthCallbackServer(){return "unchanged OAuth logic"}`;

const designFixture = {
  css: "body{color:#292e39}",
  traveler: "data:image/webp;base64,dHJhdmVsZXI=",
  scarf: "data:image/png;base64,c2NhcmY=",
  castle: "data:image/png;base64,Y2FzdGxl",
  emblem: "data:image/png;base64,ZW1ibGVt",
  wordmark: "data:image/png;base64,d29yZG1hcms=",
  favicon: "data:image/png;base64,ZmF2aWNvbg==",
};

describe("Pi OAuth callback page build patch", () => {
  it("replaces only the callback renderer and is idempotent", () => {
    const first = patchPiOAuthPageModule(upstreamFixture, designFixture);
    expect(first.changed).toBe(true);
    expect(first.source).toContain('data-rook-auth-page="editorial-v1"');
    expect(first.source).toContain("function oauthSuccessHtml(message)");
    expect(first.source).toContain('return "unchanged OAuth logic"');

    const second = patchPiOAuthPageModule(first.source, designFixture);
    expect(second).toEqual({ source: first.source, changed: false });
    const updated = patchPiOAuthPageModule(first.source, {
      ...designFixture,
      css: "body{color:#000}",
    });
    expect(updated.changed).toBe(true);
    expect(updated.source).toContain("body{color:#000}");
  });

  it("renders branded success and error pages with escaped dynamic text", () => {
    const patched = patchPiOAuthPageModule(
      upstreamFixture,
      designFixture,
    ).source;
    const rendererSource = patched.slice(
      patched.indexOf("function renderPage(options)"),
      patched.indexOf(
        "\nexport function oauthSuccessHtml(",
        patched.indexOf("function renderPage(options)"),
      ),
    );
    const renderer = runInNewContext(`(${rendererSource})`, {
      escapeHtml: (value: string) =>
        value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;"),
    }) as (options: {
      title: string;
      heading: string;
      message: string;
      details?: string;
    }) => string;

    const success = renderer({
      title: "Authentication successful",
      heading: "Authentication successful",
      message: "Signed in to OpenAI.",
    });
    expect(success).toContain("<span>ROOK</span>");
    expect(success).toContain("SIGN-IN COMPLETE");
    expect(success).toContain(designFixture.traveler);
    expect(success).toContain(designFixture.css);
    expect(success).not.toContain('src="assets/');
    expect(success).toContain("You can close this tab and return to Rook.");

    const error = renderer({
      title: "Authentication failed",
      heading: "OpenAI sign-in failed.",
      message: "Try again.",
      details: `unexpected <script>alert("x")</script> & 'bad'`,
    });
    expect(error).toContain("SIGN-IN ISSUE");
    expect(error).toContain("status-label--error");
    expect(error).toContain(
      "unexpected &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;bad&#39;",
    );
    expect(error).not.toContain("<script>");
  });

  it("fails loudly when Pi changes the callback template", () => {
    expect(() =>
      patchPiOAuthPageModule("unrecognized Pi module", designFixture),
    ).toThrow("Expected exactly one Pi OAuth callback page template; found 0");
    expect(() =>
      patchPiOAuthPageModule(
        `${upstreamFixture} ${upstreamFixture}`,
        designFixture,
      ),
    ).toThrow("found 2");
  });

  it("loads all design resources as embedded local data", async () => {
    const design = await loadRookOAuthDesign();
    expect(design.css).toContain(".editorial-frame");
    expect(design.traveler).toMatch(/^data:image\/webp;base64,/);
    expect(design.scarf).toMatch(/^data:image\/png;base64,/);
    expect(design.castle).toMatch(/^data:image\/png;base64,/);
    expect(design.emblem).toMatch(/^data:image\/png;base64,/);
    expect(design.wordmark).toMatch(/^data:image\/png;base64,/);
    expect(design.favicon).toMatch(/^data:image\/png;base64,/);
  });
});
