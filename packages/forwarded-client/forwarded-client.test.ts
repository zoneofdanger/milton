import { expect, test } from "bun:test";
import { forwardedClient as client } from "./forwarded-client";

test("the client is the entry the load balancer appended, never a leading one", () => {
  const lb = "34.149.0.10";
  expect(client(`203.0.113.7, ${lb}`)).toEqual({ ipv4: "203.0.113.7" });
  expect(client(`198.51.100.9, ${lb}`)).toEqual({ ipv4: "198.51.100.9" });
  // A client cannot claim someone else's address with leading entries.
  expect(client(`198.51.100.9, 203.0.113.66, ${lb}`)).toEqual({
    ipv4: "203.0.113.66",
  });
  for (const forged of ["192.0.2.1", "192.0.2.2, 192.0.2.3", "unknown"])
    expect(client(`${forged}, 198.51.100.7, 203.0.113.1`)).toEqual({
      ipv4: "198.51.100.7",
    });
  // IPv6 clients are their /64, lowercase, whatever the zone id.
  expect(client(`2001:db8:1:2::5, ${lb}`)).toEqual({
    ipv6Prefix: "2001:db8:1:2",
  });
  expect(client(`2001:DB8:1:2:aa::9, ${lb}`)).toEqual({
    ipv6Prefix: "2001:db8:1:2",
  });
  expect(client(`fe80::1%eth0, ${lb}`)).toEqual({ ipv6Prefix: "fe80:0:0:0" });
  // IPv4-mapped IPv6 clients are their IPv4 address, never one shared /64.
  for (const mapped of [
    "::ffff:192.0.2.1",
    "::FFFF:c000:201",
    "0:0:0:0:0:ffff:192.0.2.1",
  ])
    expect(client(`${mapped}, ${lb}`)).toEqual({ ipv4: "192.0.2.1" });
  expect(client(`::ffff:198.51.100.2, ${lb}`)).toEqual({
    ipv4: "198.51.100.2",
  });
  // No well-formed pair: each caller picks its own fallback.
  for (const malformed of [
    null,
    "",
    "203.0.113.7",
    `nonsense, ${lb}`,
    "203.0.113.7, x",
  ])
    expect(client(malformed)).toBeUndefined();
});
