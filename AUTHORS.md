# Authors & Copyright

blitzpool is a Stratum Bitcoin mining pool, originally forked from
**public-pool** (https://github.com/benjamin-wilson/public-pool) by
Benjamin Wilson, and licensed under the GNU General Public License v3.0
(see `LICENSE.txt`).

## Upstream base

- **public-pool** — Copyright (c) Benjamin Wilson and contributors,
  GPL-3.0. blitzpool builds on this foundation; the solo-mining core and
  surrounding infrastructure originate here.

## Original work in blitzpool — Copyright (c) 2025-2026 warioishere

The following subsystems were designed and implemented for blitzpool and
are **not** part of upstream public-pool. They are licensed under
GPL-3.0-or-later; reuse is welcome under those terms — please retain this
attribution and the per-file copyright notices.

- **Stratum V2 stack** — binary codec, frame layer, Noise NX handshake
  (ChaCha20-Poly1305), SipHash-2-4 (verified against the official test
  vectors), standard + extended mining channels, Template Distribution
  Protocol (TDP) and Job Declaration Protocol (JDP).
  - `src/models/sv2/*`, `src/models/StratumV2Client.ts`,
    `src/models/JobDeclarationClient.ts`,
    `src/services/{stratum-v2,template-distribution,job-declaration}.service.ts`

- **PPLNS payout mode** — sliding-window accounting with a signed,
  non-custodial credit/debit ledger, and multi-output coinbase
  distribution (dust handling, coinbase weight-budget trim, residuum
  redistribution, solvency cap; the pool operator holds no funds between
  blocks).
  - `src/services/{pplns,coinbase-distribution,coinbase-snapshot,coinbase-capacity-monitor}.ts`,
    `src/ORM/pplns-balance/*`, `src/ORM/pplns-group/*`

- **Group-Solo payout mode** — address-driven PROP-style group payouts.
  - `src/services/group-solo.service.ts`, `src/services/group.service.ts`

- **Blockparty payout mode** — fixed-percentage loot-split for pooled
  hashpower rentals.
  - `src/services/blockparty*.ts`, `src/ORM/blockparty/*`

---

If you build on any of the above, the GPL-3.0 terms apply: keep it open
source, preserve these notices, and credit the origin. Collaboration and
upstreaming are welcome — reach out.
