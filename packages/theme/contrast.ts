/** WCAG 2 contrast between two sRGB colours, for the theme's contrast test. */

const HEX = /^#[0-9a-f]{6}$/i;

/** A channel's linear value, from its 0-255 sRGB value. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour: 0 for black, 1 for white. */
export function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`Not a #rrggbb colour: "${hex}"`);
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * linear((n >> 16) & 0xff) +
    0.7152 * linear((n >> 8) & 0xff) +
    0.0722 * linear(n & 0xff)
  );
}

/** The contrast ratio of two colours, from 1 (none) to 21 (black on white), in either order. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}
