import { FlatCompat } from "@eslint/eslintrc";
import prettierPlugin from "eslint-plugin-prettier";
import { defineConfig } from "eslint/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// A Hedera transaction value is weibar (tinybar x 10^10) while every amount inside a call is tinybar. Only
// lib/hedera may write a `value:` or use the 18-decimal ether helpers; everything else spreads payable(amount).
// The guard reads syntax: it sees a `value:` written in the object passed to one of these viem actions or wagmi
// hooks, and a `value:` in a request object built before the call, recognised by the other keys a call carries.
const TRANSACTION_CALL =
  "/^(writeContract|writeContractAsync|writeContractSync|simulateContract|useSimulateContract|sendTransaction|sendTransactionAsync|sendTransactionSync|estimateContractGas|estimateGas|useEstimateGas|deployContract|deployContractAsync|prepareTransactionRequest|usePrepareTransactionRequest|call|useCall)$/";
// Batched calls (EIP-5792) carry one value per call, inside their `calls` array.
const BATCH_CALL = "/^(sendCalls|sendCallsAsync|sendCallsSync|simulateCalls)$/";
// What makes an object literal a transaction request when the call is somewhere else: something the call is aimed
// at, and a second field only a transaction carries. One key alone is not enough, because `to`, `data` and
// `functionName` are ordinary property names - a chart row, a form field, a mail payload - and a scaffold that
// fails the lint on those is worse than one that misses a request built from two keys.
const TARGET_KEYS = "/^(to|address|abi|bytecode)$/";
const TRANSACTION_KEYS = "/^(account|chain|chainId|data|functionName|args|gas|nonce|abi|bytecode)$/";
const VALUE_PROPERTY = ":matches(Property[key.name='value'], Property[key.value='value'])";
const VALUE_MESSAGE =
  "A Hedera transaction value is weibar (tinybar x 10^10): spread payable(amount) from lib/hedera instead of writing value.";
const ETHER_HELPERS_MESSAGE =
  "HBAR amounts are tinybar (8 decimals) and transaction values weibar: use the lib/hedera units helpers.";
const DECIMALS_MESSAGE =
  "HBAR has 8 decimals, not 18: parseUnits(amount, 18) is the ether-scaled amount that fails with a misleading error. Use the lib/hedera units helpers, or name the decimals of the token you mean.";

// A bare call (writeContract(…)) and a method call (client.writeContract(…)).
const valueSelectors = ["callee.name", "callee.property.name"].flatMap(callee => [
  `CallExpression[${callee}=${TRANSACTION_CALL}] > ObjectExpression > ${VALUE_PROPERTY}`,
  `CallExpression[${callee}=${BATCH_CALL}] > ObjectExpression > Property[key.name='calls'] > ArrayExpression > ObjectExpression > ${VALUE_PROPERTY}`,
]);

// The same value written into a request object that is built first and passed by name afterwards, `as const` or
// not. The two exclusions are the shapes the selectors above already report, so that nothing is reported twice.
const requestObject =
  `ObjectExpression:has(> Property[key.name=${TARGET_KEYS}]):has(> Property[key.name=${TRANSACTION_KEYS}])` +
  `:not(CallExpression > ObjectExpression):not(Property[key.name='calls'] > ArrayExpression > ObjectExpression)`;
const indirectValueSelectors = [`${requestObject} > ${VALUE_PROPERTY}`];

// An amount scaled to 18 decimals, the mistake the relay reports as a token balance problem.
const etherDecimalsSelectors = ["callee.name", "callee.property.name"].map(
  callee => `CallExpression[${callee}='parseUnits'][arguments.1.value=18]`,
);

const transactionValueGuard = {
  files: ["**/*.{js,jsx,mjs,ts,tsx}"],
  ignores: ["lib/hedera/**"],
  rules: {
    "no-restricted-syntax": [
      "error",
      ...[...valueSelectors, ...indirectValueSelectors].map(selector => ({ selector, message: VALUE_MESSAGE })),
      ...etherDecimalsSelectors.map(selector => ({ selector, message: DECIMALS_MESSAGE })),
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: ["viem", "viem/utils"].map(name => ({
          name,
          importNames: ["parseEther", "formatEther"],
          message: ETHER_HELPERS_MESSAGE,
        })),
      },
    ],
  },
};

export default defineConfig([
  {
    plugins: {
      prettier: prettierPlugin,
    },
    extends: compat.extends("next/core-web-vitals", "next/typescript", "prettier"),

    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",

      "prettier/prettier": [
        "warn",
        {
          endOfLine: "auto",
        },
      ],
    },
  },
  transactionValueGuard,
]);
