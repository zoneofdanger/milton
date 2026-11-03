// Every line of the hero conversation, once. MemoDemo renders it in order.

/** A saved-report excerpt: the text as kept, then the signature on its own line. */
export interface MemoExcerpt {
  body: string;
  signature: string;
}

export interface MemoTurn {
  speaker: "You" | "Assistant";
  text?: string;
  excerpt?: MemoExcerpt;
}

export interface MemoScene {
  label: string;
  turns: MemoTurn[];
}

const signature = "Peter";

const sample: MemoExcerpt = {
  body: "Bill, Saturday doesn’t work. TPS reports on your desk Monday, cover sheets and all.",
  signature,
};

const draft: MemoExcerpt = {
  body: "Bob, Bob. Can’t do 2:15. I’ll come find you after.",
  signature,
};

export const memoExample: { scenes: MemoScene[] } = {
  scenes: [
    {
      label: "Monday",
      turns: [
        {
          speaker: "You",
          text: "Reply to Lumbergh. I’m not coming in on Saturday.",
        },
        {
          speaker: "Assistant",
          text: "Hi Bill! Thanks so much for reaching out. Unfortunately I won’t be able to...",
        },
        {
          speaker: "You",
          text: "Not me. Here’s what I sent. Keep it as my email sample.",
          excerpt: sample,
        },
        {
          speaker: "Assistant",
          text: "Milton got the memo. Filed under email, word for word.",
        },
      ],
    },
    {
      label: "New chat, next week",
      turns: [
        { speaker: "You", text: "Did you get that memo?" },
        { speaker: "Assistant", text: "Got it. One email sample on file." },
        { speaker: "You", text: "Tell the Bobs I’ll miss the 2:15." },
        { speaker: "Assistant", excerpt: draft },
      ],
    },
  ],
};
