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
const DESIGN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../assets/rook-oauth-page",
);
const START_MARKER = "function renderPage(options) {";
const END_MARKER = "\nexport function oauthSuccessHtml(";

export function renderRookOAuthPage(options) {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : "";
  const success = options.title === "Authentication successful";
  const statusLabel = success ? "SIGN-IN COMPLETE" : "SIGN-IN ISSUE";
  const handoff = success
    ? "You can close this tab and return to Rook."
    : "Return to Rook and try signing in again.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#fbf6f0">
  <meta name="description" content="Rook authentication status. Return to your terminal to continue.">
  <link rel="icon" type="image/png" href="${design.favicon}">
  <title>${title} — Rook</title>
  <style>${design.css}</style>
</head>
<body>
  <div class="sheet">
    <div class="editorial-frame" data-rook-auth-page="editorial-v1">
      <header class="running-head" aria-label="Page header">
        <span>ROOK</span>
        <span>[ AUTHENTICATION ]</span>
      </header>
      <div class="registration registration--tl" aria-hidden="true"></div>
      <div class="registration registration--tr" aria-hidden="true"></div>
      <div class="registration registration--bl" aria-hidden="true"></div>
      <div class="registration registration--br" aria-hidden="true"></div>
      <main class="layout">
        <aside class="index-column" aria-label="Rook identity">
          <span class="index-cross" aria-hidden="true"></span>
          <p class="index-label">ROOK</p>
          <span class="index-dash" aria-hidden="true"></span>
          <p class="index-stack">CODE<br>PLAN<br>BUILD<br>LEARN</p>
        </aside>
        <div class="visual-column">
          <picture class="artwork">
            <img src="${design.traveler}" alt="A pixel-art traveler in a red scarf looks toward snowy mountains beneath an open sky." width="487" height="727">
          </picture>
          <img class="scarf-extension" src="${design.scarf}" alt="" aria-hidden="true" width="118" height="125">
          <p class="art-caption">FIG. 01 <span>—</span> A NEW JOURNEY BEGINS</p>
        </div>
        <section class="content-column" aria-labelledby="page-title">
          <div class="brand" aria-label="Rook">
            <img class="brand-emblem" src="${design.emblem}" alt="" width="192" height="249">
            <div class="brand-name">
              <img class="brand-wordmark" src="${design.wordmark}" alt="Rook" width="418" height="174">
              <span class="brand-period" aria-hidden="true"></span>
            </div>
          </div>
          <div class="ornamental-rule" aria-hidden="true"><span>✧</span></div>
          <div class="message">
            <p class="status-label${success ? "" : " status-label--error"}">${statusLabel}</p>
            <h1 id="page-title">${heading}</h1>
            <p class="summary">${message}</p>
            ${details ? `<div class="details">${details}</div>` : ""}
            <div class="handoff-note" role="note">
              <svg class="info-icon" width="27" height="27" viewBox="0 0 28 28" role="img" aria-label="Information">
                <circle cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" stroke-width="1.8"/>
                <circle cx="14" cy="8.2" r="1.25" fill="currentColor"/>
                <path d="M14 12.8v7.4m-2.15-7.4h2.15" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" fill="none"/>
              </svg>
              <span>${handoff}</span>
            </div>
          </div>
        </section>
      </main>
      <img class="castle-engraving" src="${design.castle}" alt="" aria-hidden="true" width="333" height="317">
    </div>
  </div>
</body>
</html>`;
}

const DESIGN_FILES = {
  css: ["styles.css", "text/css"],
  traveler: ["traveler-scene.webp", "image/webp"],
  scarf: ["scarf-extension.png", "image/png"],
  castle: ["castle-engraving.png", "image/png"],
  emblem: ["rook-emblem.png", "image/png"],
  wordmark: ["rook-wordmark-dark.png", "image/png"],
  favicon: ["favicon.png", "image/png"],
};

export async function loadRookOAuthDesign() {
  const design = {};
  for (const [key, [filename, mediaType]] of Object.entries(DESIGN_FILES)) {
    const content = await readFile(resolve(DESIGN_ROOT, filename));
    design[key] =
      key === "css"
        ? content.toString("utf8")
        : `data:${mediaType};base64,${content.toString("base64")}`;
  }
  return design;
}

export function patchPiOAuthPageModule(source, design) {
  const startCount = source.split(START_MARKER).length - 1;
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
    .replace(
      "function renderRookOAuthPage(options) {",
      `function renderPage(options) {\nconst design = ${JSON.stringify(design)};`,
    );
  const patchedSource = `${source.slice(0, start)}${renderedFunction}${source.slice(end)}`;
  return { source: patchedSource, changed: patchedSource !== source };
}

export async function patchInstalledPiOAuthPage() {
  const packageInfo = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  if (packageInfo.version !== EXPECTED_PI_VERSION) {
    throw new Error(
      `Rook's OAuth-page patch targets @earendil-works/pi-ai ${EXPECTED_PI_VERSION}, but found ${packageInfo.version}. Review the patch before upgrading Pi.`,
    );
  }
  const source = await readFile(OAUTH_PAGE_MODULE, "utf8");
  const design = await loadRookOAuthDesign();
  const result = patchPiOAuthPageModule(source, design);
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
