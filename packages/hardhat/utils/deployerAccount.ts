/** Written to packages/hardhat/.env by the account scripts; holds the deployer key as password-encrypted JSON. */
export const ENCRYPTED_KEY_ENV = "DEPLOYER_PRIVATE_KEY_ENCRYPTED";

/** The only variable hardhat.config.ts signs live-network transactions with. */
export const RUNTIME_KEY_ENV = "__RUNTIME_DEPLOYER_PRIVATE_KEY";

/** Networks that sign with Hardhat's own accounts, never with the deployer key. */
export const LOCAL_NETWORKS: ReadonlySet<string> = new Set(["localhost", "hardhat"]);

export const NO_ENCRYPTED_ACCOUNT = [
  `No deployer account: ${ENCRYPTED_KEY_ENV} is not set in packages/hardhat/.env.`,
  "Run the `hardhat:account:generate` or `hardhat:account:import` script first.",
].join("\n");

export const NO_DEPLOYER_KEY = [
  "No deployer key for a live network, nothing was deployed.",
  `Run the \`hardhat:account:generate\` or \`hardhat:account:import\` script: it stores ${ENCRYPTED_KEY_ENV}`,
  "in packages/hardhat/.env, and the deploy script asks for its password.",
  `For a non-interactive deploy, set ${RUNTIME_KEY_ENV} in the shell for that one command.`,
  "No other variable is read and there is no fallback key.",
].join("\n");
