import type { NextPage } from "next";
import { SwapStation } from "~~/components/swap";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Swap on SaucerSwap V2",
  description: "Swap HBAR for an HTS token and back on Hedera testnet, with the checks the network makes below the EVM",
});

const Swap: NextPage = () => <SwapStation />;

export default Swap;
