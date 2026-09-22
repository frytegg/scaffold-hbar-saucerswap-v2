import { useEffect, useState } from "react";
import { useIsMounted } from "usehooks-ts";
import { BaseError } from "viem";
import { usePublicClient } from "wagmi";
import { useSelectedNetwork } from "~~/hooks/scaffold-hbar";
import {
  Contract,
  ContractCodeStatus,
  ContractName,
  UseDeployedContractConfig,
  contracts,
} from "~~/utils/scaffold-hbar/contract";

type DeployedContractData<TContractName extends ContractName> = {
  data: Contract<TContractName> | undefined;
  isLoading: boolean;
  /** Why the network could not be asked whether the contract is deployed; null when it answered. */
  error: string | null;
};

/**
 * Gets the matching contract info for the provided contract name from the contracts present in deployedContracts.ts
 * and externalContracts.ts corresponding to targetNetworks configured in scaffold.config.ts
 */
export function useDeployedContractInfo<TContractName extends ContractName>(
  config: UseDeployedContractConfig<TContractName>,
): DeployedContractData<TContractName>;
/**
 * @deprecated Use object parameter version instead: useDeployedContractInfo({ contractName: "YourContract" })
 */
export function useDeployedContractInfo<TContractName extends ContractName>(
  contractName: TContractName,
): DeployedContractData<TContractName>;

export function useDeployedContractInfo<TContractName extends ContractName>(
  configOrName: UseDeployedContractConfig<TContractName> | TContractName,
): DeployedContractData<TContractName> {
  const isMounted = useIsMounted();

  const finalConfig: UseDeployedContractConfig<TContractName> =
    typeof configOrName === "string" ? { contractName: configOrName } : (configOrName as any);

  useEffect(() => {
    if (typeof configOrName === "string") {
      console.warn(
        "Using `useDeployedContractInfo` with a string parameter is deprecated. Please use the object parameter version instead.",
      );
    }
  }, [configOrName]);
  const { contractName, chainId } = finalConfig;
  const selectedNetwork = useSelectedNetwork(chainId);
  const deployedContract = contracts?.[selectedNetwork.id]?.[String(contractName)] as Contract<TContractName>;
  const [status, setStatus] = useState<ContractCodeStatus>(ContractCodeStatus.LOADING);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const publicClient = usePublicClient({ chainId: selectedNetwork.id });

  useEffect(() => {
    const checkContractDeployment = async () => {
      try {
        if (!isMounted() || !publicClient) return;

        if (!deployedContract) {
          setStatus(ContractCodeStatus.NOT_FOUND);
          return;
        }

        const code = await publicClient.getCode({
          address: deployedContract.address,
        });

        // If contract code is `0x` => no contract deployed on that address
        if (code === "0x") {
          setStatus(ContractCodeStatus.NOT_FOUND);
          return;
        }
        setStatus(ContractCodeStatus.DEPLOYED);
      } catch (error: unknown) {
        // "Could not ask" is not "not deployed": the caller gets the reason and decides what to show.
        setLookupError(
          error instanceof BaseError ? [error.shortMessage, error.details].filter(Boolean).join(" ") : String(error),
        );
        setStatus(ContractCodeStatus.UNREACHABLE);
      }
    };

    setLookupError(null);
    checkContractDeployment();
  }, [isMounted, contractName, deployedContract, publicClient]);

  return {
    data: status === ContractCodeStatus.DEPLOYED ? deployedContract : undefined,
    isLoading: status === ContractCodeStatus.LOADING,
    error: lookupError,
  };
}
