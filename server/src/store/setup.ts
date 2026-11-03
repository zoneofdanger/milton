/** First-setup script, served on the cover sheet while an account holds nothing.
 * Pick-the-sample questions, not adjectives: each answer maps to one rule. The
 * assistant runs it in chat, shows the complete draft, and saves only on approval. */
export const setupScript = `First setup. Run this in chat, one question at a time, in the person's words where they give any. Offer the choices as written and accept any answer in their own words. Each answer becomes one short rule. Never guess an answer or fill a skipped question. When a block is done, show its complete rules, and once the person approves them save them with one create_memo: text "Setup baseline", and rules [{ report, text }] with one entry per rule, report cover for All writing or the block's report (email, chat, post, document or speech), text the rule exactly as approved. A real sample always outranks a baseline. Start with All writing, then Email. Offer Chat, Post, Document and Speech afterwards, and stop whenever the person says so.

All writing (cover sheet)
1. Em dashes: (a) never (b) sparingly (c) freely.
2. Oxford comma: (a) yes (b) no.
3. Exclamation points: (a) never (b) at most one, in an opening line (c) freely.
4. Sentences: (a) short and plain (b) mixed (c) long and detailed.

Email
1. Which greeting is yours? (a) "Hi [first name]," (b) "Hello [first name]," (c) "[First name]," (d) none, straight into the message.
2. Which sign-off is yours? (a) "Best," plus first name (b) "Thanks," plus first name (c) "Cheers," plus first name (d) first name only (e) a full signature block.
3. How long is a typical email from you? (a) two or three sentences (b) one short paragraph (c) up to three short paragraphs (d) as long as it takes.
4. Which of these would you actually write? Pick all that apply: (a) "Hope you're doing well!" (b) "Quick question:" (c) "Following up on this." (d) "Let me know if you have any questions." (e) none of these. The rest become lines to avoid.
5. Contractions: (a) always (I'm, we're, don't) (b) never (c) only in casual email.
6. Paste one email you sent and were happy with, exactly as sent. File it as a sample: create_memo with sample { report: "email", new_kind: a short label of one or two words such as "follow-up email", context: one line on the situation, text: the email exactly }. Names stay unless the person asks for placeholders.

Chat, Post, Document, Speech
Ask the same shape for each report the person wants: one question on opening, one on length, one on the phrases they actually use, then one pasted message, post, document or spoken piece they were happy with, filed as a sample under that report.`;
