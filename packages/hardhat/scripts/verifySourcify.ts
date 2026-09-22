import { readFileSync } from "fs";
import hre from "hardhat";
import path from "path";

import { hashscanContractUrl, hederaNetworkOf } from "../utils/hederaLinks";

/**
 * Verifies this network's deployments on Sourcify through its v2 API.
 *
 * Why this script exists: the verification tooling a Scaffold-HBAR project inherits calls Sourcify's v1 endpoints
 * (`/server/check-all-by-addresses`, `/server/checkByAddresses`), and those answer HTTP 404 with an HTML page since
 * they were removed, so both the hardhat-verify task and hardhat-deploy's own `sourcify` task fail or report
 * nothing. The v2 API takes the standard JSON input that hardhat-deploy already writes next to every deployment, so
 * nothing has to be flattened or re-compiled here.
 *
 * It answers with an exit code: 0 when every deployment of this network is a full match, 1 when one is not, and 1
 * with "Sourcify unavailable" when the service could not be reached — never a hang, because every request has a
 * timeout and the wait for a verification job is bounded.
 */

const SOURCIFY_V2 = "https://sourcify.dev/server/v2";
const REQUEST_TIMEOUT_MS = 20_000;
const JOB_POLL_INTERVAL_MS = 3_000;
const JOB_POLL_ATTEMPTS = 40;
const FULL_MATCH = "exact_match";

class SourcifyUnavailable extends Error {
  /** This package compiles against the ES2020 library, whose `Error` type has no `cause` field yet. */
  readonly cause: unknown;

  constructor(what: string, cause?: unknown) {
    super(`Sourcify unavailable: ${what}`);
    this.name = "SourcifyUnavailable";
    this.cause = cause;
  }
}

type SourcifyAnswer = { status: number; body: Record<string, unknown> };

async function ask(url: string, init?: RequestInit): Promise<SourcifyAnswer> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error: unknown) {
    throw new SourcifyUnavailable(`${url} did not answer`, error);
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch (error: unknown) {
    // A body that is not JSON is how the removed v1 endpoints answered: an HTML page with HTTP 404.
    throw new SourcifyUnavailable(`${url} answered HTTP ${response.status} with ${text.slice(0, 120)}`, error);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** The standard JSON input hardhat-deploy wrote for this deployment, under the Hardhat network's own name. */
function standardJsonInput(solcInputHash: string): unknown {
  const file = path.join("deployments", hre.network.name, "solcInputs", `${solcInputHash}.json`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Waits for one verification job, then reports what Sourcify says the contract is. */
async function waitForJob(verificationId: string): Promise<void> {
  for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt++) {
    await sleep(JOB_POLL_INTERVAL_MS);
    const { body } = await ask(`${SOURCIFY_V2}/verify/${verificationId}`);
    if (body.isJobCompleted === true) return;
  }
  throw new SourcifyUnavailable(
    `job ${verificationId} was still running after ${(JOB_POLL_ATTEMPTS * JOB_POLL_INTERVAL_MS) / 1000} seconds`,
  );
}

/**
 * @param explorerNetwork the network's name on Hashscan and the mirror node, which is not the Hardhat one.
 * @returns whether the deployed contract is a full match of the source in this repository.
 */
async function verify(name: string, chainId: number, explorerNetwork: string): Promise<boolean> {
  const deployment = await hre.deployments.get(name);
  const metadata = JSON.parse(deployment.metadata ?? "{}");
  const [compilationTarget] = Object.entries(metadata.settings?.compilationTarget ?? {});
  if (deployment.solcInputHash === undefined || compilationTarget === undefined) {
    throw new Error(`${name} was not deployed with the compiler input Sourcify needs; deploy it again.`);
  }

  const submitted = await ask(`${SOURCIFY_V2}/verify/${chainId}/${deployment.address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stdJsonInput: standardJsonInput(deployment.solcInputHash),
      compilerVersion: metadata.compiler.version,
      contractIdentifier: `${compilationTarget[0]}:${compilationTarget[1]}`,
      creationTransactionHash: deployment.transactionHash,
    }),
  });
  // 409 is "already verified", which is a result, not a failure.
  if (typeof submitted.body.verificationId === "string") await waitForJob(submitted.body.verificationId);
  else if (submitted.status !== 409) {
    console.error(`${name}: Sourcify refused the submission with HTTP ${submitted.status}`, submitted.body);
  }

  const { body } = await ask(`${SOURCIFY_V2}/contract/${chainId}/${deployment.address}`);
  const match = body.match ?? "no match";
  console.log(`${name} ${deployment.address}: ${match} (creation ${body.creationMatch}, runtime ${body.runtimeMatch})`);
  console.log(`  ${hashscanContractUrl(explorerNetwork, deployment.address)}`);
  return match === FULL_MATCH;
}

async function main(): Promise<void> {
  const chainId = hre.network.config.chainId;
  const network = chainId === undefined ? undefined : hederaNetworkOf(chainId);
  if (network === undefined) {
    throw new Error(
      `Sourcify verifies deployed contracts, and ${hre.network.name} is not one of this project's Hedera networks. ` +
        "Use the `hardhat:verify:testnet` script.",
    );
  }

  const names = Object.keys(await hre.deployments.all());
  if (names.length === 0) throw new Error(`No deployment of ${hre.network.name} to verify: deploy first.`);

  const notFullyMatched: string[] = [];
  for (const name of names) if (!(await verify(name, chainId as number, network))) notFullyMatched.push(name);
  if (notFullyMatched.length > 0) {
    throw new Error(`Sourcify does not hold the source of ${notFullyMatched.join(", ")} as a full match.`);
  }
  console.log(`${names.length} contract(s) verified on Sourcify as a full match.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
