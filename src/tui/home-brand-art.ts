// Fourteen columns by fourteen half-cell pixels: a crenellated rook, tower,
// and flared base. The icon and wordmark share the same solid-block renderer.
export const HOME_ROOK_PIXELS = [
  "..11..11..11..",
  "..11..11..11..",
  "..1111111111..",
  "..1111111111..",
  "...11111111...",
  "...11111111...",
  "....111111....",
  "....122221....",
  "....122221....",
  "....122221....",
  "...11111111...",
  "..1111111111..",
  ".111111111111.",
  ".111111111111.",
] as const;

// Solid silhouette from rook_wordmark.png, sampled per letter to preserve a
// full-cell gap between letters. 1 = ivory, 2 = cyan, . = transparent.
export const HOME_WORDMARK_PIXELS = [
  "....................11.......",
  "....................11.......",
  "....................11.......",
  "11111..1111...1111..11.111...",
  "11111.111111.111111.11111....",
  "11..1.11..11.11..11.1111.....",
  "11....11..11.11..11.1111.....",
  "11....11..11.11..11.11111..22",
  "11....111111.111111.11.11..22",
  "11.....1111...1111..11..11.22",
] as const;
