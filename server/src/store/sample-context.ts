import { z } from "zod";

export const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => v.isWellFormed() && !/[\r\n\0]/.test(v));
const value = () => oneLine(60);
/** Fixed dimensions, open bounded vocabulary. Unknown values remain absent. */
export const contextDimensions = z.strictObject({
  purposes: z
    .array(value())
    .min(1)
    .max(8)
    .refine((v) => new Set(v).size === v.length)
    .optional(),
  medium: value().optional(),
  audience: z
    .strictObject({
      relationship: value().optional(),
      role: value().optional(),
      familiarity: value().optional(),
      expertise: value().optional(),
      group: value().optional(),
    })
    .refine((v) => Object.keys(v).length > 0)
    .optional(),
  interaction: value().optional(),
  scope: z
    .strictObject({
      unit: z.enum(["whole", "excerpt"]),
      role: value().optional(),
    })
    .refine((v) => v.role === undefined || v.unit === "excerpt")
    .optional(),
  language: value().optional(),
  // Preserves approved labels from the baseline without maintaining another representation.
  register: value().optional(),
});
export const sampleContextInput = contextDimensions
  .extend({
    version: z.literal(1),
    summary: oneLine(200),
  })
  .describe(
    "Approved reusable situation: version 1 and a useful summary on EVERY sample save; optional known dimensions only. Values are bounded, not a fixed taxonomy. Use generic roles, never identities or private project facts. Show this context with the exact text before one retention approval; unchanged approved metadata needs no second approval.",
  );
export type SampleContext = z.infer<typeof sampleContextInput>;
export type ContextDimensions = z.infer<typeof contextDimensions>;

/** Fixed scalar paths used for deterministic equality matching and display. */
export const contextValues = (c: ContextDimensions): [string, string][] => [
  ...["medium", "interaction", "language", "register"].flatMap((key) => {
    const value = c[key as "medium" | "interaction" | "language" | "register"];
    return value === undefined ? [] : [[key, value] as [string, string]];
  }),
  ...Object.entries(c.audience ?? {}).map(([key, value]): [string, string] => [
    `audience.${key}`,
    value,
  ]),
  ...Object.entries(c.scope ?? {}).map(([key, value]): [string, string] => [
    `scope.${key}`,
    value,
  ]),
];
export function contextMatch(
  sample: SampleContext,
  requested?: ContextDimensions,
) {
  const values = new Map(contextValues(sample));
  return {
    purposes: (requested?.purposes ?? []).filter((p) =>
      sample.purposes?.includes(p),
    ),
    dimensions: requested
      ? contextValues(requested)
          .filter(([key, value]) => values.get(key) === value)
          .map(([key]) => key)
      : [],
  };
}
export const contextDetails = (c: SampleContext) =>
  [
    ...(c.purposes ? [`purposes: ${c.purposes.join(", ")}`] : []),
    ...contextValues(c).map(
      ([key, value]) =>
        `${key.replace("audience.", "audience ").replace("scope.unit", "scope").replace("scope.role", "excerpt role")}: ${value}`,
    ),
  ].join("; ");
