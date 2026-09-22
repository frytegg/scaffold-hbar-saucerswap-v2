// Planted violations of the transaction-value guard in eslint.config.mjs. lintGuard.test.ts lints this text as a file
// of hooks/, where the guard applies; at this path, inside lib/hedera, it does not apply.
import { hbarToTinybar, payable } from "../../../units";
import { type Address, type Hex, type PublicClient, type WalletClient, formatEther, parseAbi, parseEther } from "viem";

const depositAbi = parseAbi(["function deposit() payable"]);

export async function unscaledValues(wallet: WalletClient, account: Address, to: Address): Promise<string> {
  await wallet.sendTransaction({ account, chain: null, to, value: 100_000_000n });
  await wallet.writeContract({
    account,
    chain: null,
    address: to,
    abi: depositAbi,
    functionName: "deposit",
    value: parseEther("1"),
  });
  return formatEther(0n);
}

export async function unscaledValuesElsewhere(
  wallet: WalletClient,
  client: PublicClient,
  account: Address,
  to: Address,
  bytecode: Hex,
): Promise<void> {
  await wallet.deployContract({ account, chain: null, abi: depositAbi, bytecode, value: 1n });
  await wallet.prepareTransactionRequest({ account, chain: null, to, value: 2n });
  await client.call({ account, to, value: 3n });
  await wallet.sendCalls({ account, calls: [{ to, value: 4n }] });
}

export async function scaledValue(wallet: WalletClient, account: Address, to: Address): Promise<void> {
  await wallet.sendTransaction({ account, chain: null, to, ...payable(hbarToTinybar("1")) });
}

export async function valueSetBeforeTheCall(wallet: WalletClient, account: Address, to: Address): Promise<void> {
  // Not reported: the guard reads the object written in the call, and this one is built first.
  const request = { account, chain: null, to, value: 5n };
  await wallet.sendTransaction(request);
}
