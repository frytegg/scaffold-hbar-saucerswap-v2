import { type PlanInput, type PlanReads, buildSwapPlan } from "../swapPlan";
import { SAUCERSWAP_UNAVAILABLE, blocks } from "../swapPresentation";
import { describe, expect, it } from "vitest";
import {
  type EvmAddress,
  type MirrorAccount,
  MirrorError,
  allowanceVerdict,
  costVerdict,
  recipientVerdict,
  testnet,
  tinybar,
} from "~~/lib/hedera";

// Every refusal this route can show before a wallet opens, with the reads replaced: the messages below are the
// library's own, and none of these tests touches the network.

const ACCOUNT: EvmAddress = "0x3b7A9A1B874Dd0994cc4137047daCF2803Bb6C01";
const POOL = testnet.hbarSaucePool;
/** What QuoterV2 answered for 0.1 HBAR on 22 September 2026, and eth_gasPrice on the same day. */
const QUOTE_OUT = 4_643_294n;
const GAS_PRICE = 1_140_000_000_000n;
const WEIBAR_PER_TINYBAR = 10_000_000_000n;

function mirrorAccount(slots: number): MirrorAccount {
  return {
    accountId: "0.0.10645914",
    evmAddress: ACCOUNT,
    maxAutomaticTokenAssociations: slots,
    balance: tinybar(100_000_000n),
  };
}

function reads(overrides: Partial<PlanReads> = {}): { reads: PlanReads; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reads: {
      quote: async (path, amountIn) => {
        calls.push("quote");
        return overrides.quote === undefined ? QUOTE_OUT : overrides.quote(path, amountIn);
      },
      recipient: async (recipient, token) => {
        calls.push("recipient");
        return overrides.recipient === undefined
          ? recipientVerdict(recipient, mirrorAccount(-1), null, token)
          : overrides.recipient(recipient, token);
      },
      allowance: async (owner, token, amountIn) => {
        calls.push("allowance");
        return overrides.allowance === undefined
          ? allowanceVerdict(amountIn, amountIn, token)
          : overrides.allowance(owner, token, amountIn);
      },
      cost: async request => {
        calls.push("cost");
        return overrides.cost === undefined
          ? costVerdict({
              gas: 214_509n,
              gasPrice: GAS_PRICE,
              autoAssociates: request.autoAssociates,
              token: request.token,
              hbarOut: request.hbarOut,
            })
          : overrides.cost(request);
      },
    },
  };
}

function planInput(patch: Partial<PlanInput> & Pick<PlanInput, "reads">): PlanInput {
  return {
    account: ACCOUNT,
    pool: POOL,
    direction: "hbar-to-token",
    amountInput: "0.1",
    slippageInput: "0.5",
    deadlineSeconds: 1_200,
    now: 1_700_000_000_000,
    ...patch,
  };
}

describe("a swap the page refuses before any wallet opens", () => {
  it("stops at the form, and reads nothing at all", async () => {
    const { reads: fake, calls } = reads();
    const result = await buildSwapPlan(planInput({ reads: fake, amountInput: "all of it" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.headline).toBe("Amount and slippage");
    expect(result.check.message).toBe('"all of it" is not an amount of HBAR, such as 1 or 0.25.');
    expect(calls).toEqual([]);
  });

  it("stops at the quote when the quoter refuses it, and builds nothing after that", async () => {
    const { reads: fake, calls } = reads({
      quote: () => Promise.reject(new Error("execution reverted: no pool for this fee tier")),
    });
    const result = await buildSwapPlan(planInput({ reads: fake }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.headline).toBe("Quote");
    expect(result.check.message).toBe("execution reverted: no pool for this fee tier");
    expect(calls).toEqual(["quote"]);
  });

  it("stops when the slippage leaves a minimum output of zero, which accepts any price", async () => {
    const { reads: fake } = reads({ quote: () => Promise.resolve(1n) });
    const result = await buildSwapPlan(planInput({ reads: fake, slippageInput: "50" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.headline).toBe("The swap this page would send");
    expect(result.check.message).toContain("a swap with no minimum accepts any price");
  });

  it("stops when the amount is larger than an HTS amount can be", async () => {
    const { reads: fake } = reads();
    const result = await buildSwapPlan(planInput({ reads: fake, amountInput: "99999999999999" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.check.message).toBe("amountIn must be above 0 and at most 2^63 - 1 (HTS amounts are int64).");
  });
});

describe("a token to HBAR swap, which the router can only make with an allowance", () => {
  it("blocks the send when the router has none, and offers the exact amount to approve", async () => {
    const { reads: fake, calls } = reads({
      allowance: (_owner, token, amountIn) => Promise.resolve(allowanceVerdict(0n, amountIn, token)),
    });
    const result = await buildSwapPlan(planInput({ reads: fake, direction: "token-to-hbar", amountInput: "1" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blocks(result.plan.checks)).toBe(true);
    expect(result.plan.approveAmount).toBe(1_000_000n);
    const [allowance] = result.plan.checks;
    expect(allowance.message).toContain("The SaucerSwap router has no allowance to spend your SAUCE.");
    expect(allowance.actionLabel).toBe("Approve 1 SAUCE for the router");
    expect(calls).not.toContain("cost");
  });

  it("previews the fee once the allowance covers the amount, and says why a wallet announces more", async () => {
    const { reads: fake, calls } = reads();
    const result = await buildSwapPlan(planInput({ reads: fake, direction: "token-to-hbar", amountInput: "1" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blocks(result.plan.checks)).toBe(false);
    expect(calls).toContain("cost");
    const cost = result.plan.checks[result.plan.checks.length - 1];
    expect(cost.message).toContain("Network fee: up to");
    expect(cost.message).toContain("prices the gas limit");
    expect(result.plan.approveAmount).toBeNull();
  });

  it("spends the token, not HBAR: the transaction carries no value", async () => {
    const { reads: fake } = reads();
    const result = await buildSwapPlan(planInput({ reads: fake, direction: "token-to-hbar", amountInput: "1" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.call.value).toBe(0n);
  });
});

describe("an HBAR to token swap, which only arrives at an account that can hold the token", () => {
  it("carries the amount as weibar, ten orders of magnitude above the tinybar of the call", async () => {
    const { reads: fake } = reads();
    const result = await buildSwapPlan(planInput({ reads: fake }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.call.value).toBe(10_000_000n * WEIBAR_PER_TINYBAR);
    expect(result.plan.amountOutMinimum).toBe((QUOTE_OUT * 9_950n) / 10_000n);
  });

  it("blocks the send when the recipient has no free association slot", async () => {
    const { reads: fake, calls } = reads({
      recipient: (recipient, token) => Promise.resolve(recipientVerdict(recipient, mirrorAccount(0), null, token)),
    });
    const result = await buildSwapPlan(planInput({ reads: fake }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blocks(result.plan.checks)).toBe(true);
    const [recipient] = result.plan.checks;
    expect(recipient.message).toContain("no automatic association slot");
    expect(recipient.actionLabel).toBe("Associate the token from that account first");
    expect(calls).not.toContain("cost");
  });

  it("blocks the send, under its own heading, when the mirror node answers nothing", async () => {
    const { reads: fake } = reads({
      recipient: () =>
        Promise.reject(new MirrorError("unavailable", "/api/v1/accounts/x", null, "The mirror node is unavailable.")),
    });
    const result = await buildSwapPlan(planInput({ reads: fake }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blocks(result.plan.checks)).toBe(true);
    const [unreachable] = result.plan.checks;
    expect(unreachable.label).toBe(SAUCERSWAP_UNAVAILABLE);
    expect(unreachable.message).toBe("The mirror node is unavailable.");
    expect(unreachable.actionLabel).toBe("Try again in a few seconds");
  });
});
