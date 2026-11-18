import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const EXPECTED_PI_VERSION = "1.5.2";
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/@earendil-works/pi-ai",
);
const PACKAGE_JSON = resolve(PACKAGE_ROOT, "package.json");
const OAUTH_PAGE_MODULE = resolve(PACKAGE_ROOT, "dist/utils/oauth-page.js");
const START_MARKER = "function renderPage(options) {";
const END_MARKER = "\nexport function oauthSuccessHtml(";

export function renderRookOAuthPage(options) {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : "";
  const success = options.title === "Authentication successful";
  const icon =
    '<svg viewBox="0 0 64 64" role="img" aria-label="Rook"><path d="M14 52h36v-5H46V32h5V17h-8v7h-7v-7h-8v7h-7v-7h-8v15h5v15h-4v5Zm9-5V32h18v15H23Z" fill="currentColor"/><path d="M18 12h7v5h-7zm14 0h7v5h-7zm14 0h7v5h-7z" fill="currentColor"/></svg>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${title} · Rook</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101820; color: #e9ecf0; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(ellipse at 50% 0%, #1b3441 0, #101820 58%); }
    main { width: min(100%, 520px); padding: 42px; border: 1px solid #36505c; border-radius: 20px; background: #151f27; box-shadow: 0 24px 80px #0006; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 34px; color: #27d8f3; }
    .brand svg { width: 38px; height: 38px; }
    .brand span { color: #e9ecf0; font-size: 17px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    .status { margin: 0 0 10px; color: ${success ? "#98deac" : "#f09ba5"}; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0 0 12px; font-size: clamp(25px, 6vw, 32px); line-height: 1.2; }
    p { margin: 0; color: #a7b2be; font-size: 15px; line-height: 1.7; }
    .details { margin-top: 16px; padding: 12px 14px; border-radius: 8px; background: #0d151b; color: #a7b2be; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
    .close { margin-top: 28px; color: #7c8a97; font-size: 13px; }
    @media (max-width: 480px) { main { padding: 30px 24px; } }
  </style>
</head>
<body>
  <main data-rook-auth-page="true">
    <div class="brand">${icon}<span>Rook</span></div>
    <p class="status">${success ? "Sign-in complete" : "Sign-in issue"}</p>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
    ${success ? '<p class="close">You can close this tab and return to Rook.</p>' : ""}
  </main>
</body>
</html>`;
}

export function patchPiOAuthPageModule(source) {
  const startCount = source.split(START_MARKER).length - 1;
  if (
    (startCount === 0 || startCount === 1) &&
    source.includes('data-rook-auth-page="true"')
  ) {
    return { source, changed: false };
  }
  if (startCount !== 1) {
    throw new Error(
      `Expected exactly one Pi OAuth callback page template; found ${startCount}. Pi may have changed its bundled template.`,
    );
  }
  const endCount = source.split(END_MARKER).length - 1;
  if (endCount !== 1) {
    throw new Error(
      `Expected exactly one end marker for Pi's OAuth callback page; found ${endCount}. Pi may have changed its bundled template.`,
    );
  }

  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER, start + START_MARKER.length);
  if (end < 0) {
    throw new Error(
      "Could not find the end of Pi's OAuth callback page template. Pi may have changed its module.",
    );
  }

  // Reuse the renderer's source as the replacement function. It relies only
  // on Pi's existing escapeHtml helper and doesn't touch OAuth control flow.
  const renderedFunction = renderRookOAuthPage
    .toString()
    .replace("renderRookOAuthPage", "renderPage");
  return {
    source: `${source.slice(0, start)}${renderedFunction}${source.slice(end)}`,
    changed: true,
  };
}

export async function patchInstalledPiOAuthPage() {
  const packageInfo = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  if (packageInfo.version !== EXPECTED_PI_VERSION) {
    throw new Error(
      `Rook's OAuth-page patch targets @earendil-works/pi-ai ${EXPECTED_PI_VERSION}, but found ${packageInfo.version}. Review the patch before upgrading Pi.`,
    );
  }
  const source = await readFile(OAUTH_PAGE_MODULE, "utf8");
  const result = patchPiOAuthPageModule(source);
  if (result.changed) await writeFile(OAUTH_PAGE_MODULE, result.source);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await patchInstalledPiOAuthPage();
  } catch (error) {
    console.error(
      `Failed to patch Pi's OAuth callback page: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
