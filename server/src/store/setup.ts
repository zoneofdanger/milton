/** The served first setup, while the account has no cover sheet and no memos. */
export { SETUP_PROMPT } from "@milton/theme/setup-prompt";

const example = JSON.stringify(
  {
    request_id: "00000000-0000-4000-8000-000000000001",
    memo: {
      final: "Hi [name],\n\nFriday works. Thanks!\n\n–P",
      context: {
        summary: "accepting a colleague's proposed meeting day",
        medium: "email",
        audience: "a colleague",
        purpose: "accept",
      },
      new_kind: "quick yes",
    },
  },
  null,
  2,
);

export const setupScript = [
  "First setup: offer it once; a request to set up Milton accepts the conversation. Don't repeat a declined offer, and never block a writing task: if they bring one, help with it first. Setup never reads an inbox, connects mail or imports anything the person didn't paste here.",
  "1. Confirm the connection works only after a successful get_cover_sheet read.",
  "2. First ask them to paste about five things they wrote themselves and sent (emails, messages, posts), unedited; a few real pieces make drafts sound like them. Save each piece as its own memo, exactly as pasted, with only final, a one-line context and a kind (no first_draft, mode, rounds or tweaks), and tell them each receipt. Use only their own writing; skip automated, forwarded and other people's text, and anything holding secrets. If they'd rather start with something to write or clean up, do that, then come back.",
  '3. Then offer to start the cover sheet: ask for a few short lines every draft should follow, such as "no em dashes" or "sign off –P", and add each line they give you, in their words, with cover_sheet. Don\'t suggest lines from their writing.',
  '4. Every setup includes the standing instruction: "Before writing anything for me, call Milton\'s get_cover_sheet, then get_report." Show it and ask on its own; add it where this AI supports standing instructions only after they agree, otherwise show where they can paste it.',
  "A pasted memo (fictional; replace it with the person's own writing):\n```json\n" +
    example +
    "\n```",
].join("\n\n");
