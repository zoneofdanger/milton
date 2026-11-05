/** The historical Baseline catalog remains valid for existing approved rules.
 * The default served setup below starts with samples, not the retired quiz. */
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

const setupBlocks: Block[] = [
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
/** Every canonical historical baseline, each once per report. */
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

/** Shared by the public setup widget and the app's empty state. The served
 * script holds the detailed flow, so clients do not carry separate quizzes. */
export const SETUP_PROMPT =
  "Help me connect Milton using https://www.meetmilton.com/setup, then read what I have on file. Help me choose a few messages that sound like me. If you already have access to my sent messages, find a few candidates; otherwise I'll paste them. Use only my own writing; skip automated, forwarded and third-party text. Show me the exact examples with private details removed, and save only the ones I approve. Preserve what's already on file. Then help me write my next email or DM.";

const setupWriting = {
  email: {
    examples: "emails",
    task: "email",
    text: "Hi [name],\n\nFriday works. Thanks!",
  },
  chat: {
    examples: "DMs or texts",
    task: "DM",
    text: "Friday works. Thanks!",
  },
  post: {
    examples: "posts",
    task: "post",
    text: "A small update: the guide is ready. Thanks for your feedback.",
  },
  document: {
    examples: "documents or excerpts",
    task: "document",
    text: "The guide is ready for review. Next, we will check the examples.",
  },
  speech: {
    examples: "speeches or excerpts",
    task: "speech",
    text: "Thanks for joining us today. Let’s start with what changed and what comes next.",
  },
};

/** Optional help only for a report with no rules or approved samples. */
export function reportSetup(documents: Documents, report: ReportId) {
  if (!documents.reports.find((r) => r.id === report)!.is_empty) return;
  const title = REPORTS.find((r) => r.id === report)!.title;
  const { examples, task, text } = setupWriting[report];
  const firstEmail = documents.is_empty && report === "email";
  const opening = documents.is_empty
    ? "First setup: offer setup once; a request to set up Milton accepts the conversation. Do not repeat a declined offer and never block an explicit writing task."
    : `Optional setup for ${title}, on request only. Existing guidance is usable, including samples with zero rules; never block an explicit writing task.`;
  return [
    opening,
    "Setup permission authorizes this conversation only, not mailbox access, account changes, transcript import or saving unseen text. Milton keeps approved writing word for word and does not read an inbox. Do not connect an inbox, request Gmail permissions, bulk import or save unseen text.",
    "1. Read the current cover sheet and relevant reports; preserve all existing rules and samples. If relevant examples exist, use them and offer adding examples only when useful. Do not rerun setup because rules are absent. Rules remain supported when explicitly requested: show the complete proposed list and save only exact approved wording; do not infer standing rules from one example or turn sample facts into preferences.",
    `2. Ask for a few ${firstEmail ? "emails or DMs" : examples} the person likes, or let them skip. If the person asks you to find candidates and you already have authorized access, use only that access; otherwise accept pasted examples. Never promise access. Exclude automated, forwarded and third-party text. Do not assume a sent item represents the person's voice; let the person choose what sounds like them.`,
    `3. Show each proposed sample with private details replaced by placeholders; preserve the wording and style otherwise, make excerpts explicit, and ask for exact retention approval of the displayed text. A yes to saving that exact displayed text is sufficient. Do not silently sanitize after approval; ask again only if the proposed text changes, including redaction.${firstEmail ? " File emails under email, and DMs, texts or Slack messages under chat." : ""} Save each approved sample separately with create_memo: use a valid kind_id from the relevant report, or a concise new_kind only when none fits, minimal non-private context and supported labels. Use the cover sheet version as expected_version and a new request_id per save; retry an uncertain outcome with the same request_id and exact input. Reread after saved, unchanged or conflict and compare exact text before confirming retention. Resolve a changed version before saving without re-asking about unchanged text; never invent approval.`,
    "Sample save example (fictional, replace with the approved sample):\n```json\n" +
      JSON.stringify(
        {
          text: "Keep the approved setup sample.",
          request_id: "00000000-0000-4000-8000-000000000001",
          expected_version: "a".repeat(64),
          sample: {
            report,
            new_kind: `${task} example`,
            context: `A fictional ${task}.`,
            audience: "colleague",
            purpose: "update",
            register: "plain",
            text,
          },
        },
        null,
        2,
      ) +
      "\n```\nThis illustrates the save shape, not permission to save this fictional text. Reuse kind_id instead of new_kind when a kind fits; never send both.",
    `4. Ask what the next real ${firstEmail ? "email or DM" : task} should accomplish. Read the relevant report with that intent, then draft using its examples and the cover sheet. If examples are skipped, help with the real draft without claiming to know the voice. No need to fill all five reports or accumulate rules before drafting. After a draft is approved, show the exact text before the single offer to keep it as a sample; use the same approval rule above. Praise or permission to send is not retention permission.`,
    "5. Offer the standing instruction separately: Before writing anything for me, call Milton's get_cover_sheet, then get_report for the matching report. Offer to add it where this assistant supports standing instructions, only after separate consent; otherwise show where the person can paste it. Verify an actual successful read before confirming the connection works. Setup completion does not guarantee the assistant follows the instruction.",
  ].join("\n\n");
}
/** Keep list_reports compact; a report with guidance needs no setup hint. */
export const setupHint = (report: ReportId) =>
  `Optional sample-first setup on request: call get_report for ${report} with intent. Never block an explicit writing task; rules are not required.`;
