import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { patchPiOAuthBundle } from "../../scripts/patch-pi-oauth-page.mjs";

const upstreamFixture = `const LOGO_SVG = "pi";
function escapeHtml(value){return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}
function renderPage(options){return "old Pi page"}
function oauthSuccessHtml(message){return renderPage({title:"Authentication successful",heading:"Authentication successful",message})}
async function startOAuthCallbackServer(){return "unchanged OAuth logic"}`;

describe("Pi OAuth callback page build patch", () => {
  it("replaces only the callback renderer and is idempotent", () => {
    const first = patchPiOAuthBundle(upstreamFixture);
    expect(first.changed).toBe(true);
    expect(first.source).toContain('data-rook-auth-page="true"');
    expect(first.source).toContain("function oauthSuccessHtml(message)");
    expect(first.source).toContain('return "unchanged OAuth logic"');

    const second = patchPiOAuthBundle(first.source);
    expect(second).toEqual({ source: first.source, changed: false });
  });

  it("renders branded success and error pages with escaped dynamic text", () => {
    const patched = patchPiOAuthBundle(upstreamFixture).source;
    const rendererSource = patched.slice(
      patched.indexOf("function renderPage(options)"),
      patched.indexOf(
        "function oauthSuccessHtml(",
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
    expect(success).toContain("Rook</span>");
    expect(success).toContain("Sign-in complete");
    expect(success).toContain("You can close this tab and return to Rook.");

    const error = renderer({
      title: "Authentication failed",
      heading: "OpenAI sign-in failed.",
      message: "Try again.",
      details: `unexpected <script>alert("x")</script> & 'bad'`,
    });
    expect(error).toContain("Sign-in issue");
    expect(error).toContain(
      "unexpected &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;bad&#39;",
    );
    expect(error).not.toContain("<script>");
  });

  it("fails loudly when Pi changes the bundled callback template", () => {
    expect(() => patchPiOAuthBundle("unrecognized Pi bundle")).toThrow(
      "Expected exactly one Pi OAuth callback page template; found 0",
    );
    expect(() =>
      patchPiOAuthBundle(`${upstreamFixture} ${upstreamFixture}`),
    ).toThrow("found 2");
  });
});
