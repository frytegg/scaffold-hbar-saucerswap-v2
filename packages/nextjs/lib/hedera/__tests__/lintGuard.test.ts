import { ESLint, type Linter } from "eslint";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NEXTJS_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/lint/plantedValueViolations.ts", import.meta.url));
const GUARD_RULES = new Set(["no-restricted-syntax", "no-restricted-imports"]);

const source = readFileSync(FIXTURE, "utf8");
const lineOf = (text: string) => source.split("\n").findIndex(line => line.includes(text)) + 1;

async function guardMessagesAt(filePath: string): Promise<Pick<Linter.LintMessage, "ruleId" | "line">[]> {
  const [result] = await new ESLint({ cwd: NEXTJS_ROOT }).lintText(source, { filePath });
  return result.messages
    .filter(message => message.ruleId !== null && GUARD_RULES.has(message.ruleId))
    .map(({ ruleId, line }) => ({ ruleId, line }));
}

describe("the transaction-value lint guard", () => {
  it("fails a planted value: and the ether helpers in hooks/, and nothing else", async () => {
    const messages = await guardMessagesAt(path.join(NEXTJS_ROOT, "hooks", "plantedValueViolations.ts"));
    const importLine = lineOf('from "viem"');
    expect(messages).toEqual([
      { ruleId: "no-restricted-imports", line: importLine },
      { ruleId: "no-restricted-imports", line: importLine },
      { ruleId: "no-restricted-syntax", line: lineOf("value: 100_000_000n") },
      { ruleId: "no-restricted-syntax", line: lineOf('value: parseEther("1")') },
    ]);
    expect(messages.map(message => message.line)).not.toContain(lineOf("...payable("));
  }, 60_000);

  it("does not apply inside lib/hedera, the one place that owns the conversion", async () => {
    expect(await guardMessagesAt(FIXTURE)).toEqual([]);
  }, 60_000);
});
