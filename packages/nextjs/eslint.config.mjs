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
// hooks, not a value set on an object built earlier and passed by name.
const TRANSACTION_CALL =
  "/^(writeContract|writeContractAsync|writeContractSync|simulateContract|useSimulateContract|sendTransaction|sendTransactionAsync|sendTransactionSync|estimateContractGas|estimateGas|useEstimateGas|deployContract|deployContractAsync|prepareTransactionRequest|usePrepareTransactionRequest|call|useCall)$/";
// Batched calls (EIP-5792) carry one value per call, inside their `calls` array.
const BATCH_CALL = "/^(sendCalls|sendCallsAsync|sendCallsSync|simulateCalls)$/";
const VALUE_PROPERTY = ":matches(Property[key.name='value'], Property[key.value='value'])";
const VALUE_MESSAGE =
  "A Hedera transaction value is weibar (tinybar x 10^10): spread payable(amount) from lib/hedera instead of writing value.";
const ETHER_HELPERS_MESSAGE =
  "HBAR amounts are tinybar (8 decimals) and transaction values weibar: use the lib/hedera units helpers.";

// A bare call (writeContract(…)) and a method call (client.writeContract(…)).
const valueSelectors = ["callee.name", "callee.property.name"].flatMap(callee => [
  `CallExpression[${callee}=${TRANSACTION_CALL}] > ObjectExpression > ${VALUE_PROPERTY}`,
  `CallExpression[${callee}=${BATCH_CALL}] > ObjectExpression > Property[key.name='calls'] > ArrayExpression > ObjectExpression > ${VALUE_PROPERTY}`,
]);

const transactionValueGuard = {
  files: ["**/*.{js,jsx,mjs,ts,tsx}"],
  ignores: ["lib/hedera/**"],
  rules: {
    "no-restricted-syntax": ["error", ...valueSelectors.map(selector => ({ selector, message: VALUE_MESSAGE }))],
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
