/**
 * The Hedera response codes a swap through this library can meet, by the ordinals of `ResponseCodeEnum` in
 * hashgraph/hedera-protobufs `services/response_code.proto`.
 */
export const RESPONSE_CODES = {
  22: "SUCCESS",
  33: "CONTRACT_REVERT_EXECUTED",
  178: "INSUFFICIENT_TOKEN_BALANCE",
  184: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
  194: "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT",
  226: "INVALID_NFT_ID",
  262: "NO_REMAINING_AUTOMATIC_ASSOCIATIONS",
  282: "INVALID_ALIAS_KEY",
  292: "SPENDER_DOES_NOT_HAVE_ALLOWANCE",
  293: "AMOUNT_EXCEEDS_ALLOWANCE",
} as const;

export type ResponseCode = keyof typeof RESPONSE_CODES;
export type StatusName = (typeof RESPONSE_CODES)[ResponseCode];

export const SUCCESS_CODE = 22;
const GENERIC_REVERT_CODE = 33;

const CODE_BY_NAME = new Map<string, ResponseCode>(
  Object.entries(RESPONSE_CODES).map(([code, name]) => [name, Number(code) as ResponseCode]),
);

export function statusNameOf(code: number): StatusName | null {
  return code in RESPONSE_CODES ? RESPONSE_CODES[code as ResponseCode] : null;
}

/**
 * The first failure status named in a relay message such as
 * "execution reverted: CONTRACT_REVERT_EXECUTED, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT". The generic revert status is skipped.
 */
export function failureStatusIn(text: string): { code: ResponseCode; name: StatusName } | null {
  for (const word of text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []) {
    const code = CODE_BY_NAME.get(word);
    if (code !== undefined && code !== SUCCESS_CODE && code !== GENERIC_REVERT_CODE) {
      return { code, name: RESPONSE_CODES[code] };
    }
  }
  return null;
}
