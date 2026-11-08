/** @jsxImportSource hono/jsx */
import { navigation, page } from "./pages";
import { cookieValue, type PageContext } from "./auth-session";
import {
  beginLogin,
  cookieName,
  endSessionUrl,
  finishLogin,
  removeSession,
  switchAccountState,
} from "./auth-oidc";

/** Native auth hosts login, consent, passwords and security management. The app
 * handles only its own exact OIDC callback and separate host-only cookie. */
export const signInRoutes = async (ctx: PageContext): Promise<Response> => {
  const {
    config,
    url,
    request,
    writeCookie,
    rotateCsrf,
    session,
    renderMemos,
    readForm,
  } = ctx;
  ctx.loginRecovery = "/login";
  if (url.pathname === "/auth/callback") {
    const result = await finishLogin(
      config,
      url,
      cookieValue(request, cookieName(config, "login")),
    );
    await removeSession(
      config,
      cookieValue(request, cookieName(config, "session")),
    );
    writeCookie(cookieName(config, "login"), "", 0);
    writeCookie(cookieName(config, "session"), result.token, result.maxAge);
    rotateCsrf();
    return Response.redirect(config.appOrigin + result.destination, 303);
  }
  if (url.pathname === "/auth/logged-out") {
    // Local authority ended on the CSRF-protected POST. A delayed or foreign
    // GET callback must never sign out a newer app session.
    if (await session()) return Response.redirect(config.appOrigin + "/", 303);
    // "Switch account": only the exact fixed logout state, never a URL, leads
    // on to Milton's own sign-in, which always asks the auth service to show it.
    const state = url.searchParams.getAll("state");
    if (state.length === 1 && state[0] === switchAccountState)
      return Response.redirect(config.appOrigin + "/login?fresh=1", 303);
    return page(
      "Signed out",
      <>
        <p>
          This browser is signed out of Milton. Your connected assistants stay
          connected.
        </p>
        <p>
          <a href="/login">Sign in</a>
        </p>
      </>,
    );
  }
  if (url.pathname === "/logout") {
    const switching = (await readForm()).get("next") === "login";
    // Local authority is removed before the outbound logout request. Fixed
    // client/callback/state only: no ID token, secret or untrusted metadata in
    // its URL.
    await removeSession(
      config,
      cookieValue(request, cookieName(config, "session")),
    );
    writeCookie(cookieName(config, "session"), "", 0);
    writeCookie(ctx.csrfName, "", 0);
    writeCookie(cookieName(config, "login"), "", 0);
    return navigation((await endSessionUrl(config, switching)).href);
  }
  if (url.pathname === "/account/security") {
    await ctx.signedIn();
    return Response.redirect(new URL("/security", config.issuer), 303);
  }
  if (url.pathname === "/login") {
    const destination = url.searchParams.get("next");
    const next =
      destination === "/account/delete" || destination === "/assistants"
        ? destination
        : "/";
    const result = await beginLogin(
      config,
      next,
      url.searchParams.get("fresh") === "1",
    );
    writeCookie(cookieName(config, "login"), result.browser, 600);
    return Response.redirect(result.url, 303);
  }
  const user = await session();
  if (!user)
    return page(
      "Make your agents write like you.",
      <>
        <p>
          Keep writing examples you approve, ready for connected assistants to
          use in your next email or message.
        </p>
        <p>
          <a class="button" href="/login">
            Sign in to Milton
          </a>
        </p>
        <p>
          New to Milton? Try it free for 30 days. No credit card required. Then
          $5.01 USD/month if you add a card.
        </p>
        <p>
          <a href="https://www.meetmilton.com/pricing">Pricing</a>
          {" · "}
          <a href="https://www.meetmilton.com/privacy">Privacy</a>
          {" · "}
          <a href="https://www.meetmilton.com/terms">Terms</a>
        </p>
      </>,
    );
  return renderMemos(user);
};
