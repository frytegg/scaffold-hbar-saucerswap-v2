// How the plain-text reports of this template are laid out. Nothing here knows what a report says: it takes labelled
// lines and returns them wrapped, so that the commands that print one differ in what they read, never in how it looks.

/** One labelled fact, and — when the library produced a sentence for it — that sentence, quoted verbatim. */
export type LabelledLine = {
  readonly label: string;
  readonly text: string;
  /** A sentence the library returned just now. It is printed in quotes, under the text it belongs to. */
  readonly says?: string;
};

export const REPORT_WIDTH = 96;
export const REPORT_INDENT = "  ";
/** Past this, a label stops widening the gutter and the text beside it wraps instead. */
export const MAX_LABEL = 22;

/** A whole number with its digits in groups of three, which is how the gas figures of a report are read. */
export function thousands(value: bigint | number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `text` cut into lines of at most `width` characters, broken between words only; a longer word keeps its line. */
export function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** The labelled lines of one block, aligned on the widest label they share and wrapped to the report's width. */
export function renderLines(entries: readonly LabelledLine[]): string[] {
  const labelWidth = Math.min(MAX_LABEL, Math.max(...entries.map(entry => entry.label.length)));
  const gutter = `${REPORT_INDENT}  ${" ".repeat(labelWidth)}  `;
  return entries.flatMap(entry => {
    const head = `${REPORT_INDENT}  ${entry.label.padEnd(labelWidth)}  `;
    const body = wrapped(entry.text, REPORT_WIDTH - gutter.length).map((line, index) =>
      index === 0 ? `${head}${line}` : `${gutter}${line}`,
    );
    const quote =
      entry.says === undefined
        ? []
        : wrapped(`"${entry.says}"`, REPORT_WIDTH - gutter.length - 2).map(line => `${gutter}  ${line}`);
    return [...body, ...quote];
  });
}
