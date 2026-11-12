/** Facts the site, the app and the served text all state. Code reads them from
 * here; prose that repeats them is checked against them in
 * server/test/copy-drift.test.ts. */

/** The line every setup offers for the AI's standing instructions. */
export const STANDING_LINE =
  "Before writing anything for me, call Milton's get_report.";

/** The free trial's length, in days. */
export const TRIAL_DAYS = 30;

/** The one plan's monthly price, in US dollars. */
export const PRICE_USD = "5.01";
