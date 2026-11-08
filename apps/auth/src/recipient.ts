/** An address on the reserved `.invalid` top-level domain (RFC 2606), which no
 * mail system delivers to, such as the end-to-end test account's. Auth never
 * queues mail to one (mail.ts), so the delivery job never sends it either. No
 * imports, so the server's end-to-end check bundles it without auth's libraries. */
export const reservedRecipient = (email: string) =>
  /(^|\.)invalid\.?$/i.test(email.slice(email.lastIndexOf("@") + 1));

/** A fictional test-account address: a reserved recipient, lowercase as native
 * stores emails. */
export const fictionalEmail = (email: string) =>
  reservedRecipient(email) &&
  /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$/.test(email);
