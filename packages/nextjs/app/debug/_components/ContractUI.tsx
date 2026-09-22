"use client";

// @refresh reset
import { Contract } from "@scaffold-hbar-ui/debug-contracts";
import { useDeployedContractInfo } from "~~/hooks/scaffold-hbar";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar/useTargetNetwork";
import { ContractName } from "~~/utils/scaffold-hbar/contract";

type ContractUIProps = {
  contractName: ContractName;
  className?: string;
};

/**
 * UI component to interface with deployed contracts.
 **/
export const ContractUI = ({ contractName }: ContractUIProps) => {
  const { targetNetwork } = useTargetNetwork();
  const {
    data: deployedContractData,
    isLoading: deployedContractLoading,
    error: deployedContractError,
  } = useDeployedContractInfo({ contractName });

  if (deployedContractLoading) {
    return (
      <div className="mt-14">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  if (deployedContractError) {
    return (
      <div role="alert" className="alert alert-warning mt-14 max-w-2xl">
        <span>
          Could not reach {targetNetwork.name} to load {String(contractName)}: {deployedContractError} Reload the page
          to try again.
        </span>
      </div>
    );
  }

  if (!deployedContractData) {
    return (
      <p className="text-3xl mt-14">
        No contract found by the name of {String(contractName)} on chain {targetNetwork.name}!
      </p>
    );
  }

  return <Contract contractName={contractName as string} contract={deployedContractData} chainId={targetNetwork.id} />;
};
