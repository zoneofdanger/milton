import type { APIRoute } from "astro";

/** RFC 9116 security contact, approved by Peter, 2026-11-19. Expires must stay
 * in the future: renew it before 2027-11-19. */
const body = `Contact: mailto:support@meetmilton.com
Expires: 2027-11-19T00:00:00Z
Preferred-Languages: en
Canonical: https://www.meetmilton.com/.well-known/security.txt
`;

export const GET: APIRoute = () =>
  new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
