/** Ordered word matching; display slices always retain the original punctuation. */
export function compareWords(original: string, output: string) {
  const tokenize = (text: string) =>
    Array.from(
      text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu),
      (match) => ({
        text: match[0],
        start: match.index,
        normalized: match[0].toLowerCase().replaceAll("’", "'"),
      }),
    );
  const source = tokenize(original);
  const target = tokenize(output);
  const lengths = Array.from({ length: source.length + 1 }, () =>
    Array<number>(target.length + 1).fill(0),
  );
  for (let i = source.length - 1; i >= 0; i--) {
    for (let j = target.length - 1; j >= 0; j--) {
      lengths[i][j] =
        source[i].normalized === target[j].normalized
          ? 1 + lengths[i + 1][j + 1]
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const matched = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < source.length && j < target.length) {
    if (source[i].normalized === target[j].normalized) {
      matched.add(j);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  const segments: { text: string; changed: boolean }[] = [];
  let end = 0;
  target.forEach((word, index) => {
    if (word.start > end)
      segments.push({ text: output.slice(end, word.start), changed: false });
    segments.push({ text: word.text, changed: !matched.has(index) });
    end = word.start + word.text.length;
  });
  if (end < output.length)
    segments.push({ text: output.slice(end), changed: false });
  return {
    kept: matched.size,
    originalWords: source.length,
    outputWords: target.length,
    percent: source.length
      ? Math.round((100 * matched.size) / source.length)
      : 0,
    segments,
  };
}
