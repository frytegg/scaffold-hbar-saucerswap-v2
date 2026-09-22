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
const TRANSACTION_CALL =
  "/^(writeContract|writeContractAsync|simulateContract|useSimulateContract|sendTransaction|sendTransactionAsync|estimateContractGas|estimateGas|useEstimateGas)$/";
const VALUE_PROPERTY = ":matches(Property[key.name='value'], Property[key.value='value'])";
const VALUE_MESSAGE =
  "A Hedera transaction value is weibar (tinybar x 10^10): spread payable(amount) from lib/hedera instead of writing value.";
const ETHER_HELPERS_MESSAGE =
  "HBAR amounts are tinybar (8 decimals) and transaction values weibar: use the lib/hedera units helpers.";

const transactionValueGuard = {
  files: ["**/*.{js,jsx,mjs,ts,tsx}"],
  ignores: ["lib/hedera/**"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: `CallExpression[callee.name=${TRANSACTION_CALL}] > ObjectExpression > ${VALUE_PROPERTY}`,
        message: VALUE_MESSAGE,
      },
      {
        selector: `CallExpression[callee.property.name=${TRANSACTION_CALL}] > ObjectExpression > ${VALUE_PROPERTY}`,
        message: VALUE_MESSAGE,
      },
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
