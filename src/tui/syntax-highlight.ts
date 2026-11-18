import hljs from "highlight.js";

const MAX_HIGHLIGHT_LENGTH = 100_000;
const DEFAULT_COLOR = "text";
type TokenColor =
  | "text"
  | "dim"
  | "purple"
  | "amber"
  | "green"
  | "cyan"
  | "blue"
  | "muted";
type Colorize = (text: string, color: TokenColor) => string;

const TOKEN_COLORS: Record<string, TokenColor> = {
  comment: "dim",
  quote: "dim",
  keyword: "purple",
  selector: "purple",
  literal: "amber",
  number: "amber",
  regexp: "amber",
  string: "green",
  built_in: "cyan",
  type: "cyan",
  title: "blue",
  function: "blue",
  attr: "blue",
  name: "blue",
  meta: "muted",
  doctag: "cyan",
};

/** Highlight explicit fenced-code languages and keep unknown/unlabelled blocks readable. */
export function highlightCode(
  code: string,
  language: string | undefined,
  colorize: Colorize,
): string[] {
  const lang = language
    ?.trim()
    .toLowerCase()
    .split(/[\s,{]/, 1)[0];
  if (
    !lang ||
    lang === "text" ||
    lang === "plaintext" ||
    code.length > MAX_HIGHLIGHT_LENGTH ||
    !hljs.getLanguage(lang)
  ) {
    return code.split("\n").map((line) => colorize(line, DEFAULT_COLOR));
  }

  try {
    const html = hljs.highlight(code, {
      language: lang,
      ignoreIllegals: true,
    }).value;
    return renderHighlightedCode(html, colorize);
  } catch {
    return code.split("\n").map((line) => colorize(line, DEFAULT_COLOR));
  }
}

function renderHighlightedCode(html: string, colorize: Colorize): string[] {
  const pieces =
    html.match(/<span class="[^"]+">|<\/span>|[^<]+|<[^>]*>/g) ?? [];
  const colors: TokenColor[] = [DEFAULT_COLOR];
  const lines = [""];
  for (const piece of pieces) {
    const opening = /^<span class="([^"]+)">$/.exec(piece);
    if (opening) {
      const token = opening[1]!
        .split(/\s+/)
        .find((name) => name.startsWith("hljs-"));
      const category = token?.slice("hljs-".length).split(/[._]/, 1)[0];
      colors.push(TOKEN_COLORS[category ?? ""] ?? colors.at(-1)!);
    } else if (piece === "</span>") {
      if (colors.length > 1) colors.pop();
    } else if (!piece.startsWith("<")) {
      const text = decodeHighlightEntities(piece);
      const segments = text.split("\n");
      lines[lines.length - 1] += colorize(segments[0]!, colors.at(-1)!);
      for (const segment of segments.slice(1)) {
        lines.push(colorize(segment, colors.at(-1)!));
      }
    }
  }
  return lines;
}

function decodeHighlightEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      default:
        return "'";
    }
  });
}
