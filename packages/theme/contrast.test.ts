import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "./contrast";
import * as tokens from "./tokens";

/**
 * Every text colour stays readable on every surface it is set on, in both
 * themes: WCAG 2 AA for body text, 4.5:1. The pairs are the ones the look
 * uses; a colour token that is neither in a pair nor a line fails, so a new
 * colour cannot skip the check.
 */
const PAIRS: [text: string, background: string][] = [
  ["ink", "ground"],
  ["muted", "ground"],
  ["ink", "surface"],
  ["muted", "surface"],
  ["on-ink", "ink"],
  ["on-accent", "accent"],
  ["on-accent", "accent-hover"],
  ["sheet-bar-ink", "sheet-bar"],
  ["on-band", "band"],
  ["band-muted", "band"],
];
/** Hairlines and sheet rules are decorative; inputs are functional boundaries. */
const LINES = ["hairline", "input", "sheet-rule"];
/** A translucent shade cast under a raised surface: never text, never under text. */
const SHADOWS = ["shadow"];

const css = readFileSync(join(import.meta.dir, "base.css"), "utf8");

/** The colours one block of base.css declares, hex or rgba, by token name. */
function colours(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`base.css has no "${selector}" block`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}|rgba\([\d.,\s]+\));/gi)].map(
      (m) => [m[1]!, m[2]!.toLowerCase()],
    ),
  );
}

const THEMES = {
  light: colours(":root"),
  dark: colours(':root:not([data-theme="light"])'),
};

describe("the contrast ratio", () => {
  test("matches WCAG 2's published values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // The lightest grey that passes AA on white, and the next step up that does not.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#FFFFFF", "#111113")).toBe(
      contrastRatio("#ffffff", "#111113"),
    );
  });

  test("refuses anything but a six-digit hex colour", () => {
    for (const bad of ["#fff", "white", "#11111g", "111113", ""])
      expect(() => contrastRatio(bad, "#ffffff")).toThrow();
  });
});

describe("the theme tokens", () => {
  test("every colour token is a checked text colour or background, a line or a shadow", () => {
    const checked = new Set([...PAIRS.flat(), ...LINES, ...SHADOWS]);
    for (const theme of Object.values(THEMES))
      expect(Object.keys(theme).filter((name) => !checked.has(name))).toEqual(
        [],
      );
  });

  test("both themes declare every token the pairs, lines and shadows name", () => {
    for (const [name, theme] of Object.entries(THEMES))
      expect(
        [...PAIRS.flat(), ...LINES, ...SHADOWS]
          .filter((token) => !(token in theme))
          .map((token) => `${name} ${token}`),
      ).toEqual([]);
  });

  test("dark declares every light token, the same whether followed or forced", () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(
      Object.keys(THEMES.light).sort(),
    );
    expect(colours(':root[data-theme="dark"]')).toEqual(THEMES.dark);
  });

  test("every text and background pair reaches 4.5:1 in both themes", () => {
    const failing: string[] = [];
    for (const [name, theme] of Object.entries(THEMES))
      for (const [text, background] of PAIRS) {
        const ratio = contrastRatio(theme[text]!, theme[background]!);
        if (!(ratio >= 4.5))
          failing.push(
            `${name}: ${text} on ${background} is ${ratio.toFixed(2)}:1`,
          );
      }
    expect(failing).toEqual([]);
  });

  test("functional borders reach 3:1 on both working surfaces", () => {
    for (const theme of Object.values(THEMES))
      for (const surface of ["ground", "surface"])
        expect(
          contrastRatio(theme.input!, theme[surface]!),
        ).toBeGreaterThanOrEqual(3);
  });

  test("tokens.ts carries base.css's values for the code that needs them", () => {
    for (const [name, values] of Object.entries({
      light: tokens.light,
      dark: tokens.dark,
    }))
      for (const [token, value] of Object.entries(values))
        expect(`${name} ${token} ${value.toLowerCase()}`).toBe(
          `${name} ${token} ${THEMES[name as keyof typeof THEMES][token]}`,
        );
  });
});
