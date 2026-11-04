/** @jsxImportSource hono/jsx */
import { z } from "zod";
import type { Child } from "hono/jsx";
import { deleteAccount, lookupIdentityAccount, StoreError } from "./store";
import { AuthError } from "./token";
import { endStripeCustomer } from "./billing";
import { logUnexpected } from "./error-log";
import { page } from "./pages";
import { supportEmail } from "./config";
import { timed, type PageContext, type SessionUser } from "./auth-session";
import { consentList, readConsents } from "./auth-assistants";

// Account deletion. The phrase must match exactly; nothing is deleted
// until Milton has recorded a disconnect for every live consent.
const deletePhrase = "delete my account";
const deletionUnavailable = () =>
  new AuthError(
    "deletion_unavailable",
    "Account deletion is unavailable right now. Nothing was deleted. Try again.",
    503,
  );
const activeAccount = async (ctx: PageContext, user: SessionUser) => {
  const { config } = ctx;
  try {
    await lookupIdentityAccount(config, {
      provider: "neon",
      subject: user.id,
    });
  } catch (error) {
    if (error instanceof StoreError && error.code === "account_unavailable")
      throw new StoreError(
        "account_unavailable",
        "This Milton account is unavailable. It may already be deleted.",
        403,
      );
    throw error;
  }
};
const deletionPage = (
  { csrfField, config }: PageContext,
  user: SessionUser,
  notice: Child = null,
  status = 200,
) =>
  page(
    "Delete your account",
    <>
      {notice}
      <p>
        Deleting your Milton account cannot be undone. To keep a copy of your
        report, <a href="/download">download TPS.md</a> first.
      </p>
      <h2>Deleted now</h2>
      <p>
        Your rules, approved samples, report and its history, save receipts,
        usage counters, and Milton's link to your sign-in. Every connected
        assistant is disconnected and you are signed out. If you have a Stripe
        customer record, it and any subscription end immediately, with no
        refund.
      </p>
      <h2>Kept</h2>
      <ul>
        <li>
          A record of the assistants you connected (sign-in ID and assistant ID,
          no content), so their old tokens cannot reach a new account.
        </li>
        <li>
          A one-way fingerprint of your sign-in, so a new account does not get a
          second trial.
        </li>
        <li>
          If you received an early-access invitation, that invitation entry
          (your sign-in ID), which an operator can remove.
        </li>
        <li>
          Your sign-in record (email, name, Google or GitHub link) stays with
          our sign-in provider. To remove it, email{" "}
          <a href={`mailto:${supportEmail(config)}`}>{supportEmail(config)}</a>.
        </li>
        <li>Stripe keeps past invoices and payment records.</li>
        <li>
          Copies in database backups are not erased immediately; they are
          removed when those backups expire or are deleted.
        </li>
      </ul>
      <form method="post" action="/account/delete">
        {csrfField()}
        <label>
          <span>
            Type <code>{deletePhrase}</code> to confirm.
          </span>
          <input
            name="confirm"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            required
          />
        </label>
        <button class="secondary">Delete my account</button>
      </form>
    </>,
    status,
    null,
    { account: { csrf: csrfField, email: user.email } },
  );
export const accountDeletion = async (ctx: PageContext): Promise<Response> => {
  const {
    config,
    request,
    auth,
    signedIn,
    readForm,
    writeCookie,
    csrfName,
    loopName,
  } = ctx;
  if (request.method !== "GET" && request.method !== "POST")
    return page(
      "Method not allowed",
      <p>Use the page's controls to continue.</p>,
      405,
    );
  if (request.method === "GET") {
    const user = await signedIn();
    await activeAccount(ctx, user);
    return deletionPage(ctx, user);
  }
  const form = await readForm();
  const user = await signedIn();
  await activeAccount(ctx, user);
  if (form.get("confirm") !== deletePhrase)
    return deletionPage(
      ctx,
      user,
      <p role="alert">
        Type {deletePhrase} exactly to delete your account. Nothing was deleted.
      </p>,
      400,
    );
  let consents: z.infer<typeof consentList>;
  try {
    consents = await readConsents(ctx, user);
  } catch (error) {
    if (error instanceof AuthError && error.code === "session_required")
      throw error;
    throw deletionUnavailable();
  }
  // Stripe first: otherwise a deleted account keeps being charged and Milton has
  // lost the customer id. If the delete below fails, a retry finds the 404.
  const { userId } = await lookupIdentityAccount(config, {
    provider: "neon",
    subject: user.id,
  });
  try {
    await endStripeCustomer(config, userId);
  } catch (error) {
    logUnexpected("billing", error);
    throw deletionUnavailable();
  }
  await deleteAccount(
    config,
    { provider: "neon", subject: user.id },
    consents.map((consent) => consent.clientId),
  );
  // Best effort from here: Milton already refuses every listed assistant.
  await Promise.allSettled(
    consents.map((consent) =>
      timed(auth.oauth2.deleteConsent({ id: consent.id })),
    ),
  );
  let signedOut = false;
  try {
    signedOut = !(await timed(auth.signOut())).error;
  } catch {
    /* The account is gone either way. */
  }
  writeCookie(csrfName, "", 0);
  writeCookie(loopName, "", 0);
  return page(
    "Account deleted",
    <>
      <p role="status">Your Milton account is deleted.</p>
      <p>
        Your rules, approved samples, report and its history, save receipts and
        usage counters are gone, and Milton no longer links to your sign-in.
        Every connected assistant is disconnected.
        {signedOut
          ? " This browser is signed out."
          : " Signing this browser out did not finish; sign out of your Google or GitHub account if this is a shared computer."}
      </p>
      <p>
        If you had a Stripe customer record, it and any subscription ended
        immediately, with no refund. Stripe keeps past invoices and payment
        records.
      </p>
      <p>
        Copies in database backups are not erased immediately; they are removed
        when those backups expire or are deleted. Your sign-in record stays with
        our sign-in provider. To remove it, email{" "}
        <a href={`mailto:${supportEmail(config)}`}>{supportEmail(config)}</a>.
      </p>
      <p>
        <a href="/">Milton home</a>
      </p>
    </>,
  );
};
