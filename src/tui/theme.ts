import {
  getTerminalColorMode,
  parseColor,
  styleText,
  type EditorTheme,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

const palette = {
  text: parseColor("#E9ECF0"),
  muted: parseColor("#A7B2BE"),
  dim: parseColor("#7C8A97"),
  border: parseColor("#25D9FF"),
  green: parseColor("#98DEAC"),
  blue: parseColor("#9BC7ED"),
  cyan: parseColor("#27D8F3"),
  purple: parseColor("#C7BCF1"),
  amber: parseColor("#E6D6A3"),
  error: parseColor("#F09BA5"),
};

export function tone(
  text: string,
  color: keyof typeof palette,
  bold = false,
): string {
  return styleText(text, { fg: palette[color], bold }, getTerminalColorMode());
}

export const editorTheme: EditorTheme = {
  borderColor: (text) => tone(text, "border"),
  selectList: {
    selectedPrefix: (text) => tone(text, "green", true),
    selectedText: (text) => tone(text, "text", true),
    description: (text) => tone(text, "muted"),
    scrollInfo: (text) => tone(text, "dim"),
    noMatch: (text) => tone(text, "dim"),
  },
};

export const selectListTheme = editorTheme.selectList;

export const markdownTheme: MarkdownTheme = {
  heading: (text) => tone(text, "text", true),
  link: (text) => tone(text, "blue"),
  linkUrl: (text) => tone(text, "dim"),
  code: (text) => tone(text, "green"),
  codeBlock: (text) => tone(text, "text"),
  codeBlockBorder: (text) => tone(text, "border"),
  quote: (text) => tone(text, "muted"),
  quoteBorder: (text) => tone(text, "blue"),
  hr: (text) => tone(text, "border"),
  listBullet: (text) => tone(text, "blue"),
  bold: (text) => tone(text, "text", true),
  italic: (text) =>
    styleText(text, { fg: palette.text, italic: true }, getTerminalColorMode()),
  strikethrough: (text) =>
    styleText(
      text,
      { fg: palette.dim, strikethrough: true },
      getTerminalColorMode(),
    ),
  underline: (text) =>
    styleText(
      text,
      { fg: palette.text, underline: true },
      getTerminalColorMode(),
    ),
};

export const roleColors = {
  user: "purple",
  assistant: "green",
  muted: "muted",
  error: "error",
} as const;
