/** The two destinations' icons, drawn on a 24 grid at the size given. */
export function ChatIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4A8 8 0 1 1 20.5 11.5z" />
    </svg>
  );
}

/** The pull request icon, as on the card: open by default, else draft, merged or closed. */
export function PullRequestIcon({
  size,
  state = "open",
  className,
}: {
  size: number;
  state?: "open" | "draft" | "merged" | "closed";
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy={state === "merged" ? 13 : 18} r="2.5" />
      <path d="M6 8.5v7" />
      {state === "merged" ? (
        <path d="M6 8.5c0 3 3 4.5 9.5 4.5" />
      ) : state === "draft" ? (
        <path d="M18 5v.01M18 9.5v.01M18 14v.01" />
      ) : (
        <>
          <path d="M18 15.5V10a4 4 0 0 0-4-4h-3" />
          <path d="M13 3.5 10.5 6 13 8.5" />
          {state === "closed" && <path d="M15.5 3.5l5 5M20.5 3.5l-5 5" />}
        </>
      )}
    </svg>
  );
}
