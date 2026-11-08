import { generateRandomString, hashPassword } from "better-auth/crypto";
import type pg from "pg";
import { validPassword } from "../src/password.ts";
import { reservedRecipient } from "../src/mail.ts";

/** A fictional address auth never mails (reservedRecipient: the `.invalid`
 * top-level domain), lowercase as native stores emails. */
export const fictionalEmail = (email: string) =>
  reservedRecipient(email) &&
  /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$/.test(email);

/** Owner-only, for the fictional end-to-end check account: one native user with a
 * verified email and a password credential, stored as native sign-up and
 * verification would leave them, with Better Auth's own password hash. Nothing is
 * mailed: no verification, welcome or reset message is queued. Refuses an email
 * outside `.invalid` and an email native already holds. Returns the native user id,
 * the account's OIDC subject. */
export async function createVerifiedUser(
  pool: pg.Pool,
  email: string,
  password: string,
) {
  if (!fictionalEmail(email)) throw new Error("test_email_must_end_invalid");
  if (!validPassword(password)) throw new Error("password_policy");
  const role = await pool.query<{ current_user: string }>(
    "select current_user",
  );
  if (role.rows[0]?.current_user !== "milton_auth_owner")
    throw new Error("migration_owner_required");
  // Native's own id shape and scrypt hash; the user and its credential commit
  // together. The credential gate needs the parent locked first, and a credential
  // made in the user's own transaction advances no security generation.
  const id = generateRandomString(32, "a-z", "A-Z", "0-9");
  const hashed = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const created = await client.query(
      `insert into milton_auth."user"(id,name,email,"emailVerified") values($1,'Milton e2e check',$2,true) on conflict (email) do nothing returning id`,
      [id, email],
    );
    if (!created.rowCount) throw new Error("test_email_exists");
    await client.query("select * from milton_credential.lock_user($1)", [id]);
    await client.query(
      `insert into milton_auth.account(id,"accountId","providerId","userId",password,"updatedAt") values($1,$2,'credential',$2,$3,now())`,
      [generateRandomString(32, "a-z", "A-Z", "0-9"), id, hashed],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return id;
}
