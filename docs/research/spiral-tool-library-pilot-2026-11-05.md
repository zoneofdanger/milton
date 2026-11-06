# Tool-library writing pilot: Milton and Spiral

Research date: November 5, 2026, Pacific time. See [the teardown](spiral-teardown-2026-11-05.md) for the source set, guide reconstruction, and product observations.

## What was run

The intended shared input was the three Paul Graham essay bodies described in the teardown. One Milton-assisted first draft was recorded in the existing Codex conversation before either generated Spiral guide or any Spiral draft was seen. The user later supplied three Spiral drafts from the web app. The model behind each product and the exact Spiral generation request were not independently captured.

The brief below is preserved exactly. The outputs below preserve the draft wording, punctuation, and paragraph breaks; the Spiral titles are kept in their headings. Bodies exclude titles when counting words.

The Milton arm had already read the samples through MCP and verified their exact text. It also had the prior competitive discussion and existing writing guidance in context. It was not a fresh consumer ChatGPT session. The Spiral account's final sample set, selected style, writing rules, and generation context were not independently inspected. The prompt's request for the public author's voice does not prove existing guidance had no effect.

## Exact shared brief

```text
This is an evaluation of writing in the public reference author's voice, rather than the account owner's personal voice. Use the saved PG comparison samples as the style reference.

Write a 300-400 word essay for general readers about why a community tool library should start with fewer tools.

Use this hypothetical scenario:
- A neighborhood is starting a tool library.
- Its budget covers either 20 frequently requested tools plus maintenance and spare parts, or 60 different tools with little left for upkeep.
- Borrowers need to know whether a tool will be available and usable.
- Starting small lets the organizers learn what is actually borrowed before buying more.
- A narrow selection can still fail if it omits the tools the neighborhood needs.

Develop an argument from those facts. Do not invent statistics, sources, quotations, or personal experiences. Return only the essay.
```

## Checks and initial reading

| Draft    | Body words | Paragraphs | 300–400 words | En dashes | Em dashes |
| -------- | ---------: | ---------: | ------------- | --------: | --------: |
| Milton   |        342 |          8 | Pass          |         0 |         0 |
| Spiral 1 |        368 |          7 | Pass          |         2 |         0 |
| Spiral 2 |        341 |          7 | Pass          |         0 |         0 |
| Spiral 3 |        339 |          6 | Pass          |         3 |         0 |

All four essays cover the maintenance tradeoff, learning from borrowing, and the risk of choosing the wrong initial tools. None presents a named external source or a purported quotation. The twenty/sixty quantities come from the brief.

The following is an editorial assessment by the same assistant that wrote the Milton draft. It is not an independent or blind judgment, and it assigns no numerical voice score.

- **Milton:** orderly and cautious, with the reliability argument and selection caveat preserved. Phrases such as “a smaller set of possibilities” are more abstract than the tool examples in Spiral. The ending connects growth to jobs finished rather than inventory size.
- **Spiral 1:** more emphatic and conversational, with concrete hypothetical tools and an assertive closing. The shift from sixty different tools to “a lot of drills” changes the scenario, and “most of which were probably fine when they arrived” adds an unsupported implication about condition. The pressure-washer and saw examples are explicitly hypothetical; introducing them is not itself a violation of the brief.
- **Spiral 2:** starts with the strongest objection and uses a vivid conditional bathroom example. “If I'm planning” describes a hypothetical, not an asserted personal experience. The claim that stated need and actual borrowing tend to differ greatly goes beyond the supplied facts. The first-year horizon is also an added detail.
- **Spiral 3:** gives a clear two-requirement explanation and a memorable stockpile contrast. The prediction that tools will sit unused for years because nobody tiles floors is stronger and more specific than the facts supplied. Its final claim that everything besides reliability is secondary also understates the selection requirement it acknowledges earlier.

Spiral offers more rhetorical variety across three outputs. The single Milton draft remains readable and addresses the same argument. This supports continuing the evaluation; it does not establish an 80–90% quality ratio or a winner. Do not compare the best of three Spiral outputs with the single Milton output as if equal generation effort had been tested.

The Spiral texts use spaced en dashes, not em dashes. Their dash counts therefore do not demonstrate adherence to the second guide's explicit em-dash instruction.

## Outputs

### Milton: first draft

The easiest way to make a new tool library look useful is to buy a lot of different tools. Each addition is another thing someone could do. But there is a difference between a tool someone could borrow and one they can count on borrowing.

Suppose a neighborhood has enough money for 60 different tools, with little left for upkeep, or 20 frequently requested tools plus maintenance supplies and spare parts. The first choice buys more possibilities. The second makes a smaller set of possibilities more dependable.

At first this may seem like a choice between ambition and caution. But the purpose of the library is to help people use tools. A broken tool can still appear in the inventory. It just can't do the thing that justified buying it.

Availability matters too. Someone borrowing a tool has a particular job in mind. They need to know whether they can get it and whether it will work. The number of other tools in the library won't answer either question.

Starting with fewer tools gives the organizers another advantage: they can find out which tools people actually borrow. Requests are useful, but borrowing tells them something different. They can use that information to decide what to buy next, rather than commit the whole budget before the library has lent anything.

This argument has an important limit. A small collection of the wrong tools is still the wrong collection. If the neighborhood needs something the library doesn't have, keeping the existing tools in perfect condition won't make the missing one appear. Starting small is useful only if the organizers are willing to change their selection as they learn.

The first 20 tools should therefore be an attempt to answer a question, not a final judgment about what the neighborhood needs. Which tools are worth making reliably available?

Once the organizers know more about that, they can buy more. The useful thing to grow is the number of jobs people can finish, and the size of the inventory is only an imperfect measure of it.

### Spiral 1: Start with fewer tools

When a neighborhood starts a tool library, the tempting move is to stock it with as many tools as possible. More tools means more people helped, right? This gets the problem backwards.

The number of tools you have isn't the real question. It's whether the tools you have are actually available. A tool that's broken or missing isn't just useless – it's worse than useless, because someone planned around it.

A group starting a tool library has roughly two options. They can buy twenty frequently used tools and keep enough budget for maintenance and spare parts. Or they can buy sixty different tools and have almost nothing left over. The first library has a drill that works. The second library has a lot of drills, most of which were probably fine when they arrived.

There's a subtler reason to start small too. When you're guessing what a neighborhood needs, you're almost certainly wrong about some of it. The organizers might think everyone wants a pressure washer. They might be right. But they might find out that what people actually want is a good reciprocating saw and nobody thought to ask for one. If you've already spent the budget on sixty items, you can't do much about it. If you've started with twenty, you've still got room to maneuver.

Starting small is how you find out what small means. You learn which tools vanish immediately because demand is so high, and which ones sit untouched because nobody actually needed them. That information is worth something. You can't get it without running the library for a while.

The failure mode of starting small isn't smallness – it's starting with the wrong twenty tools. A narrow selection that misses what the neighborhood actually needs has just made a smaller version of the same mistake. The goal is to pick things people genuinely want, not to pick things that look useful on a list.

A version of a tool library that serves its neighbors well probably doesn't start with sixty tools. It starts with fewer, keeps them in good shape, pays attention to what gets borrowed, and grows from there. That's not a compromise. That's just how you build something that works.

### Spiral 2: The case for the smaller tool library

The obvious objection to starting a tool library with twenty tools instead of sixty is that you're leaving people out. Someone wanted that tile saw. Someone else needed a drain snake. With a bigger selection, you help more people.

That's true as far as it goes. Availability matters more than variety.

A tool library isn't useful just because it has the right tools. It's useful because borrowers can count on them. If I'm planning to regrout my bathroom on Saturday, I need to know that the grout float will be there and will work. A library that has everything but can't maintain anything doesn't give me that. It gives me the anxiety of showing up and finding the tool I needed is broken.

The budget math is brutal here. You can stock twenty tools and have money left for maintenance and spare parts, or you can stock sixty tools and have almost nothing left for either. The second library might look more impressive on a flyer. But impressing people on a flyer and actually serving them are different things.

Then there's the question of what you're guessing versus what you know. When a tool library is just getting started, the organizers don't really know what their neighbors want. They can ask around. They can look at what other libraries stock. But the gap between what people say they need and what they actually borrow tends to be large. The only way to find out is to run the library and see what gets borrowed.

This is the underrated argument for starting small. It's cheaper and more informative. Twenty tools with real borrowing data is worth more than sixty tools with none.

The danger is picking the wrong twenty. A small selection that consistently lacks what people actually need fails just as badly as a large one that's always broken. The point isn't smallness for its own sake. It's starting with the things your neighborhood genuinely wants, keeping them in good shape, and learning enough in the first year to get better.

### Spiral 3: What a tool library is actually for

People who start community tool libraries usually think of the problem as one of supply. The more tools, the better. That's not quite the right way to think about it.

A tool library has to do two things. It has to have the tools people want. And it has to have them in a condition where they can actually be used. The second requirement is less glamorous than the first, and it's the one that gets underestimated.

Say you're starting a library and you have enough budget to do one of two things. You can stock twenty frequently requested tools and keep enough in reserve for maintenance and spare parts. Or you can stock sixty different tools and have almost nothing left over. The first option sounds limiting. The second option sounds generous. But if the second library can't fix or replace anything that breaks, it's not really generous – it's just a temporary stockpile.

The other problem with buying sixty tools upfront is that you're making a lot of guesses. You don't know what your neighborhood actually borrows until people start borrowing. Some of what you bought will be in constant demand. Some of it will sit untouched for years because it turned out nobody around here tiles their own floors. With twenty tools, you've made fewer guesses, and you still have room to respond when you're wrong.

None of this means small is automatically better. A library that stocks twenty tools but chooses poorly – missing the things the neighborhood genuinely needs – has just made the same mistake on a smaller scale. Getting the selection right matters. The argument for starting small is that it makes the selection easier to get right, not that it doesn't matter.

There's something appealing about the idea of a tool library with everything. But the ones that actually work are the ones where you can trust that what they have will be there when you need it. That reliability is what people are really looking for. Everything else is secondary.

## Next gate

Use fresh writing conversations, independently verify the same imported text and relevant guidance, record the model and style selection where visible, and collect an equal number of first drafts per arm. Blind the outputs for a human judge and measure the actual edits needed. Repeat with an unfamiliar writer and ordinary email/message tasks before generalizing to Milton's intended use.
