import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { domainToASCII } from "node:url";

/** What DNS says about mail to a domain. Only "undeliverable" skips a
 * message; "unknown" (a timeout, SERVFAIL or any other resolver error) sends
 * it, so a DNS outage never stops a real person's mail. */
export type MailDomain = "deliverable" | "undeliverable" | "unknown";
export type MailResolver = Pick<
  Resolver,
  "resolveMx" | "resolve4" | "resolve6" | "cancel"
>;

/** The ASCII form of an address's domain, lowercase without a trailing dot,
 * or "" when it has none a resolver could take. */
export function addressDomain(address: string) {
  return domainToASCII(
    address
      .slice(address.lastIndexOf("@") + 1)
      .replace(/\.$/, "")
      .toLowerCase(),
  );
}

/** A short unkeyed digest of a domain for logs: repeats can be counted and an
 * operator can check a named domain by hashing it, but no personal domain is
 * written in clear. */
export const domainDigest = (domain: string) =>
  createHash("sha256").update(domain).digest("hex").slice(0, 12);

const code = (e: unknown) =>
  e && typeof e === "object" && "code" in e ? String(e.code) : "";
// NXDOMAIN (ENOTFOUND) or an existing name without records of the type (ENODATA).
const absent = (e: unknown) => ["ENOTFOUND", "ENODATA"].includes(code(e));

async function lookup(domain: string, r: MailResolver): Promise<MailDomain> {
  try {
    const mx = await r.resolveMx(domain);
    // RFC 7505 null MX: a single record whose exchange is "." (empty here).
    if (mx.length === 1 && ["", "."].includes(mx[0]!.exchange))
      return "undeliverable";
    if (mx.length) return "deliverable";
  } catch (e) {
    if (code(e) === "ENOTFOUND") return "undeliverable";
    if (code(e) !== "ENODATA") return "unknown";
  }
  // RFC 5321 §5.1: with no MX records, the domain's own address is the host.
  const [a, aaaa] = await Promise.allSettled([
    r.resolve4(domain),
    r.resolve6(domain),
  ]);
  if ([a, aaaa].some((x) => x.status === "fulfilled" && x.value.length))
    return "deliverable";
  if ([a, aaaa].every((x) => x.status === "fulfilled" || absent(x.reason)))
    return "undeliverable";
  return "unknown";
}

/** Looks a mail domain up within `deadline` milliseconds (about 2 s by
 * default: one 1-second try for MX, then one for A/AAAA), cancelling the
 * lookup and answering "unknown" when it runs out. A fresh resolver per
 * check, so a cancel touches only this lookup. */
export async function mailDomain(
  domain: string,
  resolver: MailResolver = new Resolver({ timeout: 1000, tries: 1 }),
  deadline = 2000,
): Promise<MailDomain> {
  if (!domain) return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<MailDomain>((resolve) => {
    timer = setTimeout(() => {
      resolver.cancel();
      resolve("unknown");
    }, deadline);
  });
  try {
    return await Promise.race([
      lookup(domain, resolver).catch((): MailDomain => "unknown"),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
