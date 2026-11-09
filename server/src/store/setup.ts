/** The default served setup starts with samples. */
import { REPORTS, type Documents, type ReportId } from "./reports";

export { SETUP_PROMPT } from "@milton/theme/setup-prompt";

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
    "1. Read the current cover sheet and relevant reports; preserve all existing rules and samples. Verify an actual successful read before confirming the connection works. If relevant examples exist, use them and offer adding examples only when useful. Do not rerun setup because rules are absent. Rules remain supported when explicitly requested: show the complete proposed list and save only exact approved wording; do not infer standing rules from one example or turn sample facts into preferences.",
    "2. Invite the person to paste something they wrote and ask you to clean it up. If the person explicitly asks to add or import examples, go directly to that conversation instead. For a writing task, help now; do not require samples or rules. Read the relevant report with the task's intent. Change only what they ask, preserve other wording and style, and briefly list changes separately. Follow the sample approval rule below for any approved edit; edit approval alone does not permit retention. If they ask for a new draft instead, help with that task using existing guidance without claiming an unknown voice.",
    `3. Optional, after the task or whenever the person asks: Ask for a few ${firstEmail ? "emails or DMs" : examples} the person likes only when useful, or let them skip. If the person asks you to find candidates and you already have authorized access, use only that access; otherwise accept pasted examples. Never promise access. Exclude automated, forwarded and third-party text. Do not assume a sent item represents the person's voice; let the person choose what sounds like them.`,
    `4. After a draft or edit is approved, show the exact placeholder-safe text and proposed context before the single offer to keep it as a sample; follow the retention approval rule in this step and never include the change list in the sample. Draft or edit approval, praise or permission to send is not retention permission. Show each proposed sample with private details replaced by placeholders; preserve the wording and style otherwise, make excerpts explicit, and ask for exact retention approval of the displayed text AND proposed useful non-private context on EVERY save. A yes to saving that displayed proposal is sufficient; unchanged approved metadata needs no second approval. Do not silently sanitize after approval; ask again only if the proposed text or context changes, including redaction.${firstEmail ? " File emails under email, and DMs, texts or Slack messages under chat." : ""} Save each approved sample separately with create_memo: use a valid kind_id from the relevant report, or a concise new_kind only when none fits, the approved context object (version 1, summary, optional known purposes, medium, audience, interaction, whole/excerpt scope and language). Omit sample_id for a new example; include its stable sample_id only when the person approves revising an active example. Revisions require the complete approved text, context and classification. Use the cover sheet version as expected_version and a new request_id per save. Reread after saved or unchanged and compare exact text before confirming retention; on an error, follow its next. Resolve a changed version before saving without re-asking about unchanged text; never invent approval.`,
    "Sample save example (fictional, replace with the approved sample):\n```json\n" +
      JSON.stringify(
        {
          text: "Keep the approved setup sample.",
          request_id: "00000000-0000-4000-8000-000000000001",
          expected_version: "a".repeat(64),
          sample: {
            report,
            new_kind: `${task} example`,
            context: {
              version: 1,
              summary: `A fictional ${task}.`,
              audience: { relationship: "colleague" },
              purposes: ["update"],
              register: "plain",
              scope: { unit: "whole" },
            },
            text,
          },
        },
        null,
        2,
      ) +
      "\n```\nThis illustrates the save shape, not permission to save this fictional text. Reuse kind_id instead of new_kind when a kind fits; never send both.",
    `5. If the person wants another writing task: Ask what the next real ${firstEmail ? "email or DM" : task} should accomplish. Read the relevant report with that intent, then draft using its examples and the cover sheet. If examples are skipped, help with the real draft without claiming to know the voice. No need to fill all five reports or accumulate rules before drafting.`,
    "6. Offer the standing instruction separately: Before writing anything for me, call Milton's get_cover_sheet, then get_report for the matching report. Offer to add it where this AI supports standing instructions, only after separate consent; otherwise show where the person can paste it. Setup completion does not guarantee the AI follows the instruction.",
  ].join("\n\n");
}
/** Keep list_reports compact; a report with guidance needs no setup hint. */
export const setupHint = (report: ReportId) =>
  `Optional setup on request: call get_report for ${report} with intent. Never block an explicit writing task; rules are not required.`;
