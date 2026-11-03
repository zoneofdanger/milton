/** First setup as data: the paste-first quiz, one block per report. The served
 * script text and the catalog of baseline rules are both rendered from these
 * blocks, so they cannot diverge. Snippets and rules are copied from the
 * approved proposal; "⏎" marks a line break and " • " a bullet on its own line,
 * as there. Every rule is filed as "Baseline: " + its text here. */
import {
  BASELINE,
  REPORTS,
  ruleText,
  type Documents,
  type Filing,
  type ReportId,
} from "./reports";

type Dimension = { name: string; report: Filing; confirm?: true };
type Pick = {
  id: string;
  title: string;
  ask: string;
  /** One per rule an option files, in order: a bundle files one rule each. */
  dims: Dimension[];
  options: { snippet: string; rules: string[] }[];
};
type Tells = {
  id: string;
  title: string;
  ask: string;
  tells: { report: Filing; rule: string }[];
};
type Block = {
  report: ReportId;
  /** What the paste step asks for. */
  piece: string;
  /** An example label for the pasted sample's kind. */
  kind: string;
  /** How a "⏎" in this block's snippets prints. */
  lineBreak: string;
  questions: (Pick | Tells)[];
};

const dim = (report: Filing, name: string, confirm = false): Dimension => ({
  name,
  report,
  ...(confirm ? { confirm: true } : {}),
});

const e7a =
  "Can you send the memo by Friday? I want to review it before Monday's call.";
const e7b =
  e7a +
  " I mostly need the pricing section; the rest can stay rough. If Friday is tight, pricing alone is fine.";
const p1a =
  "Show your work before it feels ready. ⏎ People catch problems while they're cheap to fix. ⏎ You stop polishing parts nobody needed.";

export const setupBlocks: Block[] = [
  {
    report: "email",
    piece: "email",
    kind: "follow-up email",
    lineBreak: "\n",
    questions: [
      {
        id: "E1",
        title: "Frame",
        ask: "Which is closest to an email you'd send? Mix and match is fine.",
        dims: [
          dim("email", "greeting", true),
          dim("email", "first line", true),
          dim("email", "sign-off", true),
        ],
        options: [
          {
            snippet:
              "Hi Samir, hope you're well. ⏎ Can you send the memo by Friday? ⏎ Thanks, ⏎ [my first name]",
            rules: [
              'Greet with "Hi" and the first name.',
              "Open with one short pleasantry.",
              'Sign off with "Thanks," and my first name.',
            ],
          },
          {
            snippet:
              "Hello Samir, thanks for yesterday's update. ⏎ Can you send the memo by Friday? ⏎ Best, ⏎ [my first name]",
            rules: [
              'Greet with "Hello" and the first name.',
              "Open by thanking them for their last message.",
              'Sign off with "Best," and my first name.',
            ],
          },
          {
            snippet:
              "Samir, ⏎ Can you send the memo by Friday? ⏎ [my first name]",
            rules: [
              "Greet with the first name alone.",
              "Open with the point itself.",
              "Sign off with my first name on its own line.",
            ],
          },
          {
            snippet: "Can you send the memo by Friday?",
            rules: [
              "No greeting.",
              "Open with the point itself.",
              "No sign-off.",
            ],
          },
        ],
      },
      {
        id: "E2",
        title: "Tone",
        ask: "Which reply is yours?",
        dims: [
          dim("email", "warmth"),
          dim("email", "exclamation points", true),
        ],
        options: [
          {
            snippet: "Thanks for the memo. I'll review it tonight.",
            rules: [
              "Thank people in one plain sentence.",
              "No exclamation points.",
            ],
          },
          {
            snippet: "Thanks for the memo! I'll review it tonight.",
            rules: [
              "Thank people in one plain sentence.",
              "At most one exclamation point, in an opening line.",
            ],
          },
          {
            snippet:
              "Thanks so much for the memo! I really appreciate it. I'll review it tonight.",
            rules: [
              'Add a line of warmth when thanking someone, such as "I really appreciate it".',
              "At most one exclamation point, in an opening line.",
            ],
          },
        ],
      },
      {
        id: "E3",
        title: "Register",
        ask: "Which would you write?",
        dims: [dim("cover", "word choice"), dim("cover", "contractions", true)],
        options: [
          {
            snippet:
              "Thanks for your help. I'll use the new cover sheets and reply by Friday.",
            rules: [
              "Use plain words: help, use, new, reply.",
              "Use contractions.",
            ],
          },
          {
            snippet:
              "Thank you for your assistance. I will utilize the updated cover sheets and respond by Friday.",
            rules: [
              "Prefer formal words: assistance, utilize, updated, respond.",
              "No contractions.",
            ],
          },
        ],
      },
      {
        id: "E4",
        title: "Asking",
        ask: "How would you ask?",
        dims: [dim("email", "asking")],
        options: [
          {
            snippet: "Can you send the memo by Friday?",
            rules: ["Make requests as one plain question."],
          },
          {
            snippet:
              "Could you send the memo by Friday, if you have the bandwidth?",
            rules: [
              'Soften requests with a condition such as "if you have the bandwidth".',
            ],
          },
          {
            snippet: "Please send the memo by Friday.",
            rules: ['Make requests as a "please" imperative.'],
          },
          {
            snippet: "I need the memo by Friday.",
            rules: ["State requests as what I need, not as a question."],
          },
        ],
      },
      {
        id: "E5",
        title: "Asides",
        ask: "How would you set off the aside?",
        dims: [dim("cover", "asides")],
        options: [
          {
            snippet:
              "The draft — mostly the pricing section — needs another pass.",
            rules: ["Set off asides with em dashes."],
          },
          {
            snippet:
              "The draft (mostly the pricing section) needs another pass.",
            rules: ["Set off asides with parentheses, never dashes."],
          },
          {
            snippet:
              "The draft, mostly the pricing section, needs another pass.",
            rules: ["Set off asides with commas, never dashes or parentheses."],
          },
          {
            snippet:
              "The draft needs another pass. Mostly the pricing section.",
            rules: [
              "Put an aside in its own short sentence, never dashes or parentheses.",
            ],
          },
        ],
      },
      {
        id: "E6",
        title: "Several points",
        ask: "Which layout?",
        dims: [dim("email", "several points")],
        options: [
          {
            snippet:
              "Before Friday I need the cover sheet, the timeline, the budget and the test results.",
            rules: ["Run several points together as prose."],
          },
          {
            snippet:
              "Before Friday I need: • the cover sheet • the timeline • the budget • the test results",
            rules: ["Put several points in a list, one per line."],
          },
        ],
      },
      {
        id: "E7",
        title: "Length",
        ask: "Which is closest to the length you'd send?",
        dims: [dim("email", "length")],
        options: [
          { snippet: e7a, rules: ["Keep emails to two or three sentences."] },
          { snippet: e7b, rules: ["Keep emails to one short paragraph."] },
          {
            snippet:
              e7b +
              " ⏎ ⏎ For the call, I'll take pricing first and leave time for questions. Tell me if you want to present any of it.",
            rules: ["Write emails in up to three short paragraphs."],
          },
        ],
      },
      {
        id: "E8",
        title: "The tells, approved once",
        ask: "Assistants tend to add these. Should I keep them out of your writing?",
        tells: [
          { report: "cover", rule: 'No "not X, but Y".' },
          { report: "cover", rule: "No groups of three for effect." },
          {
            report: "cover",
            rule: "No words like delve, crucial, leverage, pivotal.",
          },
          { report: "email", rule: 'No "Hope this finds you well".' },
          {
            report: "email",
            rule: 'No "Let me know if you have any questions".',
          },
          { report: "email", rule: "No bold or headers." },
        ],
      },
    ],
  },
  {
    report: "chat",
    piece: "message",
    kind: "status reply",
    lineBreak: "\n",
    questions: [
      {
        id: "H1",
        title: "Opening and closing",
        ask: "Which is closest to a message you'd send?",
        dims: [dim("chat", "opening", true), dim("chat", "closing")],
        options: [
          {
            snippet:
              "hey Michael, quick one: is the review still on for Thursday? thanks",
            rules: [
              'Open chat with "hey", the first name, and a lead-in such as "quick one:".',
              "End with a quick thanks.",
            ],
          },
          {
            snippet: "Hi Michael, is the review still on for Thursday?",
            rules: [
              'Open chat with "Hi" and the first name.',
              "End on the content.",
            ],
          },
          {
            snippet: "is the review still on for Thursday?",
            rules: ["No greeting or name in chat.", "End on the content."],
          },
        ],
      },
      {
        id: "H2",
        title: "Case and end punctuation",
        ask: "Which is yours?",
        dims: [dim("chat", "case and end punctuation", true)],
        options: [
          {
            snippet: "works for me, see you at Chotchkie's",
            rules: ["In chat, lowercase and no final period."],
          },
          {
            snippet: "Works for me, see you at Chotchkie's.",
            rules: ["In chat, capitalize and end with a period."],
          },
        ],
      },
      {
        id: "H3",
        title: "Emoji",
        ask: "Which is yours?",
        dims: [dim("chat", "emoji", true)],
        options: [
          {
            snippet: "Congrats on the new Initrode job, well deserved 🎉",
            rules: ["At most one emoji, at the end."],
          },
          {
            snippet: "Congrats on the new Initrode job, well deserved.",
            rules: ["No emoji in chat."],
          },
        ],
      },
      {
        id: "H4",
        title: "Length",
        ask: "Someone asks 'where are we on [project]?' Which reply is closest to yours?",
        dims: [dim("chat", "length")],
        options: [
          {
            snippet: "on track for Friday, just waiting on final copy",
            rules: ["Keep chat replies to one line."],
          },
          {
            snippet:
              "on track for Friday ⏎ design is done ⏎ just waiting on final copy",
            rules: ["Write chat replies as a few short lines."],
          },
          {
            snippet:
              "We're on track for Friday. Design wrapped yesterday and the build is in testing. The only open item is final copy.",
            rules: ["Write chat replies as one short paragraph."],
          },
        ],
      },
    ],
  },
  {
    report: "post",
    piece: "post",
    kind: "lesson post",
    // A post puts a blank line between its lines.
    lineBreak: "\n\n",
    questions: [
      {
        id: "P1",
        title: "Layout",
        ask: "Which layout is closest to how you post?",
        dims: [dim("post", "layout", true)],
        options: [
          {
            snippet: p1a,
            rules: ["One idea per line in posts, blank line between."],
          },
          {
            snippet:
              "Show your work before it feels ready. People catch problems while they're cheap to fix, and you stop polishing parts nobody needed.",
            rules: ["Write posts as prose paragraphs."],
          },
        ],
      },
      {
        id: "P2",
        title: "Length",
        ask: "Which length is closest to a post you would publish?",
        dims: [dim("post", "length")],
        options: [
          { snippet: p1a, rules: ["Keep posts to about three lines."] },
          {
            snippet:
              "Show your work before it feels ready. ⏎ For years I held drafts back until they felt finished. It seemed respectful of other people's time. In practice it meant problems surfaced late, when they were expensive to fix, and I spent hours polishing sections nobody needed. ⏎ Now I share early, with a note on what is rough and what kind of feedback would help. People catch the real issues in minutes. I hear what matters to them instead of guessing. The finished version arrives sooner and lands better. ⏎ Rough and early beats polished and late.",
            rules: ["Keep posts to about 100 words."],
          },
          {
            snippet:
              "Show your work before it feels ready. ⏎ Last month I spent two weeks on a plan for [project] before showing it to anyone. I wanted it complete: every section filled in, every question answered, and the formatting clean. I was proud of how tidy it looked. When I finally shared it with [the team], the first reply pointed out that one early assumption was wrong. Half the plan rested on it, and fixing it took another week. ⏎ That was not a disaster, but it was avoidable. The person who spotted it would have spotted it on day two, from a rough outline, in about five minutes. ⏎ So I changed how I work. Now I share a draft as soon as the shape is there, with a short note: what is rough, what I am unsure about, and what kind of feedback would help most. People catch the real problems while they are still cheap to fix. I hear what matters to them instead of guessing. And I stop polishing sections nobody needed. ⏎ It still feels uncomfortable to send something unfinished. I have stopped treating that feeling as a reason to wait. ⏎ Rough and early beats polished and late.",
            rules: ["Let posts run to about 200 words around one story."],
          },
        ],
      },
      {
        id: "P3",
        title: "Ending",
        ask: "How does your post end?",
        dims: [dim("post", "ending")],
        options: [
          {
            snippet: "Rough and early beats polished and late.",
            rules: ["End posts on the point."],
          },
          {
            snippet:
              "Rough and early beats polished and late. ⏎ How early do you share drafts?",
            rules: ["End posts with a question to readers."],
          },
          {
            snippet:
              "Rough and early beats polished and late. ⏎ If you have a story like this, message me.",
            rules: ["End posts with a light invitation to reply."],
          },
        ],
      },
      {
        id: "P4",
        title: "The tells, approved once",
        ask: "Assistants tend to add these. Should I keep them out of your writing?",
        tells: [
          { report: "post", rule: "No hashtags." },
          { report: "post", rule: "No emoji." },
          {
            report: "post",
            rule: 'No "Here\'s what I learned" or "Agree?" hooks.',
          },
          { report: "post", rule: "No groups of three." },
        ],
      },
    ],
  },
  {
    report: "document",
    piece: "document",
    kind: "status update",
    lineBreak: "\n",
    questions: [
      {
        id: "D1",
        title: "Shape",
        ask: "Which is closest to how you'd write this update?",
        dims: [dim("document", "opening and structure", true)],
        options: [
          {
            snippet:
              "The Y2K conversion is on track for the 14th. ⏎ Status ⏎ • Testing finished Friday. • Sign-off due Wednesday.",
            rules: [
              "Bottom line first in one sentence, then short headings with bullets.",
            ],
          },
          {
            snippet:
              "The Y2K conversion is on track for the 14th. Testing finished on Friday, and the only open item is sign-off, due Wednesday.",
            rules: ["Bottom line first in one sentence, then prose."],
          },
          {
            snippet:
              "Testing finished on Friday, and the only open item is sign-off, due Wednesday. The Y2K conversion is on track for the 14th.",
            rules: ["Background first in prose, then the point."],
          },
        ],
      },
      {
        id: "D2",
        title: "Voice",
        ask: "Which is yours?",
        dims: [dim("document", "voice")],
        options: [
          {
            snippet: "We recommend moving staff meetings to Thursdays.",
            rules: ['Recommend in the team voice: "We recommend".'],
          },
          {
            snippet: "I recommend moving staff meetings to Thursdays.",
            rules: ['Recommend in my own voice: "I recommend".'],
          },
          {
            snippet:
              "The recommendation is to move staff meetings to Thursdays.",
            rules: ['Recommend impersonally: "The recommendation is".'],
          },
        ],
      },
      {
        id: "D3",
        title: "Hedging",
        ask: "Which is yours?",
        dims: [dim("document", "hedging")],
        options: [
          {
            snippet: "This will cut TPS filing time in half.",
            rules: ["State claims plainly."],
          },
          {
            snippet:
              "This should cut TPS filing time, possibly by as much as half.",
            rules: ['Hedge claims with "should" and "possibly".'],
          },
        ],
      },
    ],
  },
  {
    report: "speech",
    piece: "spoken piece",
    kind: "toast",
    lineBreak: "\n",
    questions: [
      {
        id: "S1",
        title: "Shape",
        ask: "Which is closest to a toast you'd give?",
        // One rule: a toast's last line answers its first.
        dims: [dim("speech", "opening and closing")],
        options: [
          {
            snippet: "Thanks, everyone, for being here tonight. … Thank you.",
            rules: [
              'Open a toast by thanking everyone; close with a plain "Thank you."',
            ],
          },
          {
            snippet:
              "The first time I met [name], we were both stuck at the printer. … So here's to [name], still my favorite person to be stuck with.",
            rules: [
              "Open a toast with a one-line story; close with a callback to it.",
            ],
          },
          {
            snippet:
              "Anyone who knows me knows I'm not great at speeches, so bear with me. … So please raise a glass to [name].",
            rules: [
              "Open a toast with a joke at my own expense; close by asking everyone to raise a glass.",
            ],
          },
        ],
      },
      {
        id: "S2",
        title: "Address",
        ask: "Which is yours?",
        dims: [dim("speech", "address", true)],
        options: [
          {
            snippet:
              "You're the most generous person I know, [name], and you never make a thing of it.",
            rules: ['Speak to the person honored as "you".'],
          },
          {
            snippet:
              "[Name] is the most generous person I know, and has never once sought credit for it.",
            rules: ["Speak about the person in the third person, to the room."],
          },
        ],
      },
    ],
  },
];

const isTells = (q: Pick | Tells): q is Tells => "tells" in q;
type Baseline = { report: Filing; text: string };
/** Every rule a block can file, as filed, with the report it is served for. */
const blockRules = (block: Block): Baseline[] =>
  block.questions.flatMap((q) =>
    isTells(q)
      ? q.tells.map((t) => ({ report: t.report, text: BASELINE + t.rule }))
      : q.options.flatMap((o) =>
          o.rules.map((r, at) => ({
            report: q.dims[at]!.report,
            text: BASELINE + r,
          })),
        ),
  );
const key = (report: Filing, text: string) => JSON.stringify([report, text]);
const baselines = new Map(
  setupBlocks.flatMap(blockRules).map((b) => [key(b.report, b.text), b]),
);
/** Every baseline rule the setup text can file, each once per report. */
export const setupCatalog: readonly Baseline[] = [...baselines.values()];
/** A rule passes unless its text starts with "Baseline: " (after one leading
 * "- ") without being a catalog entry byte for byte, for that report. */
export const knownBaseline = (text: string, report: Filing) =>
  !ruleText(text).startsWith(BASELINE) ||
  baselines.has(key(report, ruleText(text)));
const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** The catalog baseline sharing the most words with `text`; the first wins a tie. */
export function closestBaseline(text: string) {
  const own = words(text);
  let best = setupCatalog[0]!;
  let score = -1;
  for (const rule of setupCatalog) {
    const shared = [...words(rule.text)].filter((w) => own.has(w)).length;
    if (shared > score) [best, score] = [rule, shared];
  }
  return best;
}

const title = (report: ReportId) => REPORTS.find((r) => r.id === report)!.title;
const quoted = (snippet: string, lineBreak: string) =>
  snippet
    .split(/ ?⏎ ?/)
    .map((line) => line.replaceAll(" • ", "\n• "))
    .join(lineBreak)
    .split("\n")
    .map((line) => (line ? "> " + line : ">"))
    .join("\n");
const letter = (i: number) => "(" + String.fromCharCode(97 + i) + ")";
const filed = (report: Filing, rule: string) =>
  `[${report}] ${BASELINE}${rule}`;

function question(q: Pick | Tells, lineBreak: string) {
  if (isTells(q))
    return [
      `${q.id}. ${q.title}`,
      `Ask: "${q.ask}"`,
      "Show exactly:",
      ...q.tells.map((t) => "- " + t.rule),
      "Files on yes, one rule per line; the person can strike any:",
      ...q.tells.map((t) => filed(t.report, t.rule)),
    ].join("\n");
  const confirmable = q.dims.filter((d) => d.confirm).map((d) => d.name);
  return [
    `${q.id}. ${q.title}`,
    `Ask: "${q.ask}"`,
    "Show exactly:",
    ...q.options.map((o, i) => letter(i) + "\n" + quoted(o.snippet, lineBreak)),
    `Files${confirmable.length ? ` (a paste can confirm: ${confirmable.join(", ")})` : ""}:`,
    ...q.options.map(
      (o, i) =>
        letter(i) +
        " " +
        o.rules.map((r, at) => filed(q.dims[at]!.report, r)).join(" | "),
    ),
  ].join("\n");
}

/** The cover-sheet questions, kept in email's block: the picks that file
 * only to cover and the cover tells. */
const coverQuestions = () =>
  setupBlocks[0]!.questions
    .map((q) =>
      isTells(q)
        ? { ...q, tells: q.tells.filter((t) => t.report === "cover") }
        : q,
    )
    .filter((q) =>
      isTells(q)
        ? q.tells.length > 0
        : q.dims.every((d) => d.report === "cover"),
    );
/** The setup script for one report's block. `first` (no rules anywhere yet)
 * adds the opening lines; `cover` (the cover sheet has no rules) attaches the
 * cover-sheet questions, inline in email's block and after any other's;
 * `next` names the reports still
 * without rules to offer afterwards. */
export function setupText(
  report: ReportId,
  { first, cover, next }: { first: boolean; cover: boolean; next: ReportId[] },
) {
  const block = setupBlocks.find((b) => b.report === report)!;
  const name = title(report);
  // Without the cover-sheet questions, a block keeps only its own rules.
  const own = block.questions
    .map((q) =>
      isTells(q)
        ? { ...q, tells: q.tells.filter((t) => t.report !== "cover") }
        : q,
    )
    .filter((q) =>
      isTells(q)
        ? q.tells.length > 0
        : q.dims.some((d) => d.report !== "cover"),
    );
  const questions: [Pick | Tells, string][] = !cover
    ? own.map((q) => [q, block.lineBreak])
    : report === "email"
      ? block.questions.map((q) => [q, block.lineBreak])
      : [
          ...own.map((q): [Pick | Tells, string] => [q, block.lineBreak]),
          ...coverQuestions().map((q): [Pick | Tells, string] => [q, "\n"]),
        ];
  const groups = cover ? `"All writing" (cover) and "${name}"` : `"${name}"`;
  const start =
    report === "email"
      ? "First, paste one email you sent and were happy with, exactly as sent, or say skip. I'll show you what would be stored before anything is saved. Then a few short choices, two to four pieces of writing each: pick the one that sounds like you, or say neither. Each becomes one rule, marked as a baseline until your real writing replaces it. About four minutes."
      : `Paste one ${block.piece} you sent and were happy with, exactly as sent, or say skip. I'll show you what would be stored before anything is saved.`;
  const opening = first
    ? `First setup: ${name}. Run it as written before any other writing. Before anything else, tell the person: "Milton keeps the writing you approve, word for word. It never rewrites a rule or a sample, and it never reads your inbox." Then say: "${start}"`
    : `Setup for ${name}, on request only: run it when the person asks to set up ${report}, or picks ${name} at the end of another block. Do not offer it otherwise. Run it as written before any other writing, starting with: "${start}"`;
  const how = [
    "Run it in chat, one step at a time. Never reword, shorten or fill in a snippet, a rule or a skipped answer.",
    `1. The paste. Show it back exactly as pasted, with a proposed kind of one or two words and a one-line context, and ask to keep it as a sample, unchanged. On yes, file it right away with its own create_memo: text "Setup sample", sample { report: "${report}", new_kind: a label of one or two words such as "${block.kind}", context: one line on the situation, text: the paste exactly as pasted }, expected_version from this read and a new request_id. Milton keeps the newest two samples per kind. Names stay unless the person asks for placeholders. Skipping the paste gives every pick.`,
    `2. Confirmations. For each habit a Files line says a paste can confirm, if the paste plainly shows it and one listed option matches, ask one line instead of the pick${report === "email" ? `, such as "Your email opens with 'Hi [first name],'. Is that usual?"` : `: name the habit you saw in the ${block.piece} and ask whether it is usual.`} Yes files that option's rule for the habit; no, or "sometimes", asks the pick, which then files only the rules not already filed.`,
    `3. The questions, in order, one at a time. Say the Ask line, then show the Show exactly block as written, every option with its letter. A letter files exactly the rules on its Files line, each to the report in brackets. Mixed answers ("a, but with b's sign-off") are fine: read back the exact rules chosen. "Neither" files nothing. An answer in the person's own words ("it depends", "Cheers,") is read back and filed in their words, without "${BASELINE}". The block stops at its end, on "stop", or after two consecutive skips.`,
    `4. Approval. Show the complete list of rules grouped under ${groups}. Wait for approval; the person can strike or change any line.`,
    `5. Save. Call create_memo once: text "Setup baseline", rules [{ report, text }] with one entry per approved rule, report from its brackets, text copied byte for byte from its Files line (or the person's own words exactly as approved), expected_version from the sample save's result (from this read when no sample was filed) and a new request_id. Milton refuses any rule starting "${BASELINE}" that is not a Files rule byte for byte.`,
    `6. End. Say, with the counts actually filed, the sample from step 1 included: "Filed to ${name}: [n] sample and [n] baseline rules${cover ? ", plus [n] on your cover sheet" : ""}. Read them back any time, here or on your Milton page. To change one, tell me or any connected assistant ("change the sign-off rule to Best"); it is replaced word for word. Samples outrank baselines.${next.length ? ` Next: ${next.map(title).join(", ")}, or stop here?` : ""}"${next.length ? " On a pick, call get_report for that report and run its setup." : ""}`,
  ];
  return [
    opening,
    how.join("\n"),
    ...questions.map(([q, lineBreak]) => question(q, lineBreak)),
  ].join("\n\n");
}

/** Setup keys on rules, not samples: a report's block is served while that
 * report has no rules, with the cover-sheet questions while the cover sheet
 * has none. The cover sheet serves email's while no rules exist anywhere. */
const ruleless = (documents: Documents, report: ReportId) =>
  documents.reports.find((r) => r.id === report)!.rules.length === 0;
export const noRules = (documents: Documents) =>
  documents.cover_rules.length === 0 &&
  documents.reports.every((r) => r.rules.length === 0);
export function reportSetup(documents: Documents, report: ReportId) {
  if (!ruleless(documents, report)) return;
  return setupText(report, {
    first: noRules(documents),
    cover: documents.cover_rules.length === 0,
    next: documents.reports
      .filter((r) => r.rules.length === 0 && r.id !== report)
      .map((r) => r.id),
  });
}
/** list_reports carries this one line, not the block, for each report
 * without rules. */
export const setupHint = (report: ReportId) =>
  `Setup available on request while this report has no rules: when the person asks to set up ${report}, call get_report ${report} and run its setup as written.`;
/** Hook reads carry this line instead of the script, so injected context
 * stays far under client limits (Claude Code's is 10,000 characters). */
export const SETUP_HOOK_POINTER =
  "First setup available: call get_cover_sheet and run its setup as written.";
