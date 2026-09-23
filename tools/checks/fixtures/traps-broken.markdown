# Hedera-specific behaviour

## A behaviour that lost its fifth part

**Symptom** — what the developer sees, verbatim.

**Real cause** — what the node really does.

**Proof** — one transaction: [`0xdf368443…2352`](https://hashscan.io/testnet/tx/0xdf368443228e69c4ed1a2a7192d0978b15a51f219981cdd2d5f63250d1582352).

**What it costs** — 0.13498778 HBAR.

**The test that keeps it fixed** — "a test that exists" runs on every invocation.

## A behaviour whose proof links nothing and whose caption lost its fields

**Symptom** — what the developer sees, verbatim.

![MetaMask's activity list](images/wallet-failed-interaction-history.png)

*And afterwards. The wallet lists the failed interaction and says nothing more about it.*

**Real cause** — what the node really does.

**Proof** — the transaction is on chain; take our word for it.

**What it costs** — nothing at all.

**How the template protects** — it does not.

**The test that keeps it fixed** — "a test nobody ever wrote" would run on every invocation.

## A behaviour whose parts are out of order

**Symptom** — one.

**Proof** — [`0xdf368443…2352`](https://hashscan.io/testnet/tx/0xdf368443228e69c4ed1a2a7192d0978b15a51f219981cdd2d5f63250d1582352).

**Real cause** — two.

**What it costs** — three.

**How the template protects** — four.

**The test that keeps it fixed** — "a test that exists" runs on every invocation.
