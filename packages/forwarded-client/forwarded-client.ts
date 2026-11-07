import { isIP } from "node:net";

/** An IPv4 client, or an IPv6 client's /64: its four leading hex groups. */
export type ForwardedClient = { ipv4: string } | { ipv6Prefix: string };

/**
 * The client address Google's external Application Load Balancer saw. The
 * load balancer appends "<client-ip>,<load-balancer-ip>" to X-Forwarded-For
 * and "does not verify any IP addresses that precede" them
 * (https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header),
 * so only the second-to-last entry is trusted; the first is whatever the
 * client sent. This holds only while the service's ingress is
 * internal-and-cloud-load-balancing
 * (https://docs.cloud.google.com/run/docs/securing/ingress). IPv4-mapped IPv6
 * clients (dotted or hex) are their IPv4 address; other IPv6 clients are
 * their /64, as `ipv6Prefix` ("2001:db8:1:2", lowercase, zone id dropped).
 * Without a well-formed pair (the last entry an IP, the one before it an IPv4
 * or IPv6 address), undefined: each caller picks its own fallback.
 */
export function forwardedClient(
  forwarded: string | null,
): ForwardedClient | undefined {
  const hops = (forwarded ?? "").split(",").map((hop) => hop.trim());
  const client = hops.at(-2) ?? "";
  if (hops.length < 2 || !isIP(hops.at(-1)!)) return undefined;
  if (isIP(client) === 4) return { ipv4: client };
  if (isIP(client) !== 6) return undefined;
  const groups = (part = "") =>
    part
      .split(":")
      .filter(Boolean)
      .flatMap((g) => {
        if (!g.includes(".")) return [parseInt(g, 16)];
        const [a, b, c, d] = g.split(".").map(Number);
        return [a! * 256 + b!, c! * 256 + d!];
      });
  const [head, tail] = client.split("%")[0]!.split("::");
  const left = groups(head),
    right = groups(tail);
  const full =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  // An IPv4-mapped address (::ffff:a.b.c.d, dotted or hex) is that IPv4 client.
  if (full.slice(0, 5).every((g) => g === 0) && full[5] === 0xffff)
    return {
      ipv4: [full[6]! >> 8, full[6]! & 255, full[7]! >> 8, full[7]! & 255].join(
        ".",
      ),
    };
  return {
    ipv6Prefix: full
      .slice(0, 4)
      .map((g) => g.toString(16))
      .join(":"),
  };
}
