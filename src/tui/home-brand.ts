import {
  getTerminalColorMode,
  parseColor,
  styleText,
  truncateToWidth,
  type Component,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { tone } from "./theme.js";

// The supplied rook_lockup.png, alpha-cropped and area-averaged to 36×14
// pixels. Each six-character cell is an RGB color or transparent (......).
// Keeping the raster here avoids runtime PNG decoding and image protocols.
const RASTER = [
  "....................................2E9CD0..............................................................................................................................................................................",
  "..............................2399CFA0DFF076CFEA078CCB..................................................................................................................................................................",
  "....................................5CC5E429A7D8........................................................................................................................................................................",
  "........................47688B......085C96............45688E............................................................................................................................................................",
  "..................61AFCE61C0F304215453A7DC438ABF4B6E91299EEA639FC1............................................................................................................020A2D....................................",
  "..................46A9CF1B99FA3E9EDB1684E81B84E13E94D9076CDB4D97C50064B2006DB1..........................................................................................3C425BF8F2EB54576C..............................",
  "..................5486A64BC5FB4AB5FC489CEB449AE94399E946ACEA3F6E9C......008ECD007AB2......474C642229474C5168............40445D4D5169363C58............464B634C5168......3D435CFDF7EF56596E......555A70363C58............",
  "........................51A3D21067D00F47990F3C880E4EA85290BA............008ACD............EDE8E4C4C1C3FDF7EF858794585D73E9E4E0FDF7EFD6D2D12B324E646879F6F0EAFDF7EFAAA9B0343B56FDF7F03D425B9C9CA5EBE6E24F546A............",
  "............0069C100459C3AA8E2004CB23F76A7184F8F0042A43A86C0004CA70065BB..................EEE9E4757787606477696C7EC6C3C58B8D99182141D2CFCF7B7D8CCDCACA83859339405BEBE6E25F6377FDF7F0C0BEC1E1DDDB494F66..................",
  "......12A8DF......37577F27ABF40043A33775A819569A004EB13699E4013685........................EEE9E44C5167............C6C3C5747787......A8A8AF7B7C8BCDCACA6C6F80......D9D5D45F6477FDF7EFF3EDE7C9C6C8373E58......00325600294D",
  "4AD0ED0F81C9......3E7CA8089CF2005FBD07489A093F8E0032882C97EB2C4A75........................EEE9E54C5268............9E9EA6BBB9BD77798AEFE9E55D6174AAA9AFB5B3B88A8B98E8E3DF4A5068FDF7F052576CDEDAD8B8B6BB0F193E00E7F300A6BB",
  "32AADB36B6E02586B82F9DCA3491E312377E88ACC882B3D1223F7F2882DB436F94........................9696A1353C57..................878894A09FA8737686......252D499696A0A09FA8595D72262D4A9F9FA7393E58464C659F9FA8161F430096AD00708C",
  "............4D658D68BCE150B1F4A4DBF318B0FC129FFB8BD0F846A9F164A9CC......................................................................................................................................................",
  "............3280B9005DBE2068BB0966C40050B9004CB40C5EBB0C59B4065AB9225F9A................................................................................................................................................",
].map((row) => row.match(/.{6}/g)!);

function halfBlock(
  top: string,
  bottom: string,
  mode: TerminalColorMode,
): string {
  if (top === "......" && bottom === "......") return " ";
  if (top === "......") {
    return styleText("▄", { fg: parseColor(`#${bottom}`) }, mode);
  }
  if (bottom === "......") {
    return styleText("▀", { fg: parseColor(`#${top}`) }, mode);
  }
  return styleText(
    "▀",
    {
      fg: parseColor(`#${top}`),
      bg: parseColor(`#${bottom}`),
    },
    mode,
  );
}

const logoCache = new Map<TerminalColorMode, string[]>();

function logoLines(mode: TerminalColorMode): string[] {
  let lines = logoCache.get(mode);
  if (!lines) {
    lines = Array.from({ length: RASTER.length / 2 }, (_, row) =>
      RASTER[row * 2]!.map((top, column) =>
        halfBlock(top, RASTER[row * 2 + 1]![column]!, mode),
      ).join(""),
    );
    logoCache.set(mode, lines);
  }
  return lines;
}

export class HomeBrand implements Component {
  render(width: number): string[] {
    return [
      ...logoLines(getTerminalColorMode()).map((line) =>
        truncateToWidth(`  ${line}`, width, ""),
      ),
      truncateToWidth(
        `  ${tone("A coding agent that grows with your codebase.", "muted")}`,
        width,
        "",
      ),
    ];
  }

  invalidate(): void {}
}
