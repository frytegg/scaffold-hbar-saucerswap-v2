# Hedera-specific behaviour

## A behaviour that carries all six parts

**Symptom** — what the developer sees, verbatim.

![MetaMask asking for a signature on the swap that would fail](images/wallet-doomed-swap-confirmation.png)

*What the wallet shows before the signature: a fee, two buttons, and no warning. MetaMask 13.48.0 on Chrome 152, Hedera testnet (chain 296), 23 September 2026.*

**Real cause** — what the node really does.

**Proof** — one transaction: [`0xdf368443…2352`](https://hashscan.io/testnet/tx/0xdf368443228e69c4ed1a2a7192d0978b15a51f219981cdd2d5f63250d1582352).

**What it costs** — 0.13498778 HBAR, and nothing arrived.

**How the template protects** — the pre-flight refuses the send.

**The test that keeps it fixed** — "a test that exists" runs on every invocation.
