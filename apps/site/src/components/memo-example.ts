// The fictional illustration's exact display strings, scored at build time.
export const memoExample = {
  request: "Clean this up.",
  original:
    "hey team, tps reports are late again bc the new cover sheets didnt come in. ill have them on everyones desk monday, sorry about that. The cover sheets are the problem, not the reports.",
  outputs: [
    {
      id: "plain",
      label: "Illustrative plain AI",
      text: "Hi team, I hope this message finds you well. I wanted to provide a quick update regarding the TPS reports, which are running behind schedule due to a delay in receiving the new cover sheets. Rest assured, they will be on everyone's desk by Monday. We're working through a minor paperwork issue. Thank you for your patience!",
    },
    {
      id: "milton",
      label: "Illustrative Milton",
      text: "Hey team, TPS reports are late again because the new cover sheets didn't come in. I'll have them on everyone's desk Monday, sorry about that. The cover sheets are the problem, not the reports.",
    },
  ],
} as const;
