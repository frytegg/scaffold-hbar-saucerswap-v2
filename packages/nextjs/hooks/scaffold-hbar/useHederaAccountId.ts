import { useEffect, useState } from "react";
import { chainIdToHederaNetwork, lookupHederaAccountId } from "~~/utils/scaffold-hbar";

type AccountIdState = {
  accountId: string | null;
  isLoading: boolean;
  /** Set when the lookup itself failed; an address the network has not seen yet is not an error. */
  error: string | null;
};

const IDLE: AccountIdState = { accountId: null, isLoading: false, error: null };

export function useHederaAccountId(evmAddress: string | undefined, chainId?: number): AccountIdState {
  const [state, setState] = useState<AccountIdState>(IDLE);

  useEffect(() => {
    if (!evmAddress) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    setState({ accountId: null, isLoading: true, error: null });

    lookupHederaAccountId(evmAddress, chainIdToHederaNetwork(chainId ?? 296)).then(result => {
      if (cancelled) return;
      setState(
        result.ok
          ? { accountId: result.accountId, isLoading: false, error: null }
          : { accountId: null, isLoading: false, error: result.error.message },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, chainId]);

  return state;
}
