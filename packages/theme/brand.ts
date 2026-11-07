// Shared plain folder navigation mark. The printer favicons live in public/.
export const folderMark =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="#D99A1E" stroke="#221F1B" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6.5a1 1 0 0 1 1-1h5l2 2.2h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"></path></svg>';

// Every product uses the same icon selection. The app passes its
// content-versioned URLs; the site keeps the named cache revision.
export const faviconLinksFor = (url: (path: string) => string) =>
  `<link rel="icon" type="image/x-icon" href="${url("/favicon.ico")}" sizes="16x16 32x32 48x48 64x64"><link rel="icon" type="image/svg+xml" href="${url("/favicon.svg")}" sizes="any">`;
export const faviconLinks = faviconLinksFor((path) => `${path}?v=printer`);
