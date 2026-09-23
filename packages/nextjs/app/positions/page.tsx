import type { NextPage } from "next";
import { PositionsStation } from "~~/components/positions";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

export const metadata = getMetadata({
  title: "Your SaucerSwap V2 positions",
  description:
    "Read the liquidity positions an account holds on Hedera testnet: their range, whether the price is inside it, and what closing one would return",
});

const Positions: NextPage = () => <PositionsStation />;

export default Positions;
