import { ESLint, type Linter } from "eslint";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const NEXTJS_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/lint/plantedValueViolations.ts", import.meta.url));
const IN_HOOKS = path.join(NEXTJS_ROOT, "hooks", "plantedValueViolations.ts");
const GUARD_RULES = new Set(["no-restricted-syntax", "no-restricted-imports"]);

const source = readFileSync(FIXTURE, "utf8");
const lineOf = (text: string) => source.split("\n").findIndex(line => line.includes(text)) + 1;

type GuardMessage = Pick<Linter.LintMessage, "ruleId" | "line">;

/**
 * The same fixture linted at two paths: inside `hooks/`, where the guard applies, and at its own path inside
 * `lib/hedera`, where it does not. Both are linted once here rather than once per test, because one `ESLint`
 * resolves the flat config on its first lint and that resolution is the whole cost: four of them made a cold run
 * miss the test's own timeout while the other suites were transforming on the neighbouring workers.
 */
let inHooks: GuardMessage[];
let inLibrary: GuardMessage[];

beforeAll(async () => {
  const eslint = new ESLint({ cwd: NEXTJS_ROOT });
  const guardMessagesAt = async (filePath: string): Promise<GuardMessage[]> => {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages
      .filter(message => message.ruleId !== null && GUARD_RULES.has(message.ruleId))
      .map(({ ruleId, line }) => ({ ruleId, line }));
  };
  inHooks = await guardMessagesAt(IN_HOOKS);
  inLibrary = await guardMessagesAt(FIXTURE);
}, 180_000);

describe("the transaction-value lint guard", () => {
  it("fails a planted value: and the ether helpers in hooks/, and nothing else", () => {
    expect(inHooks).toEqual([
      { ruleId: "no-restricted-imports", line: lineOf("formatEther,") },
      { ruleId: "no-restricted-imports", line: lineOf("parseEther,") },
      { ruleId: "no-restricted-syntax", line: lineOf("value: 100_000_000n") },
      { ruleId: "no-restricted-syntax", line: lineOf('value: parseEther("1")') },
      { ruleId: "no-restricted-syntax", line: lineOf("wallet.deployContract(") },
      { ruleId: "no-restricted-syntax", line: lineOf("wallet.prepareTransactionRequest(") },
      { ruleId: "no-restricted-syntax", line: lineOf("client.call(") },
      { ruleId: "no-restricted-syntax", line: lineOf("wallet.sendCalls(") },
      { ruleId: "no-restricted-syntax", line: lineOf("value: 5n") },
      { ruleId: "no-restricted-syntax", line: lineOf("value: 6n") },
      { ruleId: "no-restricted-syntax", line: lineOf('parseUnits("1", 18)') },
    ]);
    expect(inHooks.map(message => message.line)).not.toContain(lineOf("...payable("));
  });

  it("sees a value set on a request object built before the call, asserted or not", () => {
    expect(inHooks).toContainEqual({ ruleId: "no-restricted-syntax", line: lineOf("value: 5n") });
    expect(inHooks).toContainEqual({ ruleId: "no-restricted-syntax", line: lineOf("value: 6n") });
  });

  it("leaves a value that is an ordinary property of an object nothing sends", () => {
    const reported = inHooks.map(message => message.line);
    expect(reported).not.toContain(lineOf('label: "slippage"'));
    // One transaction key is not a transaction: these three are a chart row, a form field and an API payload.
    expect(reported).not.toContain(lineOf("export const chartRow"));
    expect(reported).not.toContain(lineOf("export const formField"));
    expect(reported).not.toContain(lineOf("export const apiPayload"));
  });

  it("does not apply inside lib/hedera, the one place that owns the conversion", () => {
    expect(inLibrary).toEqual([]);
  });
});
