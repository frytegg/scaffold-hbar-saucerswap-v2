import { type EvidenceRecord, parseEvidence } from "../evidence";
import { type MirrorClient, createMirrorClient, directMirrorTransport } from "../mirror";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, type PublicClient, createPublicClient, http } from "viem";
import { hederaTestnet } from "viem/chains";
import { jsonRpcUrl, mirrorNodeUrl } from "~~/services/hedera/upstreams";

// What the live tiers share: Hedera testnet's JSON-RPC relay and mirror node (the same upstreams as the app's route
// handlers), and the evidence directory at the root of the repository.

export const mirrorBaseUrl = mirrorNodeUrl("testnet");

export const testnetClient: PublicClient = createPublicClient({
  chain: hederaTestnet,
  transport: http(jsonRpcUrl("testnet")),
});

export const testnetMirror: MirrorClient = createMirrorClient({ transport: directMirrorTransport(mirrorBaseUrl) });

export const EVIDENCE_DIR = fileURLToPath(new URL("../../../../../docs/evidence/", import.meta.url));

export function readEvidence(): { file: string; record: EvidenceRecord }[] {
  return readdirSync(EVIDENCE_DIR)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => {
      const file = `docs/evidence/${name}`;
      return { file, record: parseEvidence(JSON.parse(readFileSync(path.join(EVIDENCE_DIR, name), "utf8")), file) };
    });
}

/**
 * The mirror node's own simulator, POST /api/v1/contracts/call. It answers HTTP 200 when the call would succeed and
 * HTTP 400 when it reverts.
 */
export async function mirrorCallAccepts({
  from,
  to,
  data,
}: {
  from: Address;
  to: Address;
  data: Hex;
}): Promise<boolean> {
  const response = await fetch(`${mirrorBaseUrl}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block: "latest", estimate: false, from, to, data, value: 0 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 200) return true;
  if (response.status === 400) return false;
  throw new Error(`The mirror node's contracts/call answered HTTP ${response.status}.`);
}
