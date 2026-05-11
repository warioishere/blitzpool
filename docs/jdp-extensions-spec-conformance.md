# JDP + Extensions Spec Conformance Review

Snapshot from a deep, line-by-line audit of our SV2 Job Declaration
Protocol and the three extensions (0x0001 / 0x0002 / 0x0003) against
the [sv2-spec](https://github.com/stratum-mining/sv2-spec).

Reviewed against:

- sv2-spec `main` at commit `eb7ecc6` (Merge pull request #139 from
  plebhash/2025-06-03-remove-prev-hash-from-declare-mining-job)
- ext 0x0003 spec on branch `add-extension-0x0003-coinbase-output-weights`,
  commit `336a238` ("0x0003: add §4.5 on coinbase space and output count")

Code reviewed:

- `src/models/JobDeclarationClient.ts`
- `src/services/job-declaration.service.ts`
- `src/models/sv2/sv2-jdp-messages.ts`
- `src/models/sv2/sv2-extensions-messages.ts`
- `src/models/sv2/sv2-constants.ts`
- `src/models/StratumV2Client.ts` (for ext 0x0001 / 0x0002 on mining)

---

## A. JDP Base Protocol (§6) — message-by-message

| Spec Ref | Message / Field | Type | Status | Note |
|---|---|---|---|---|
| §6.4.1 | `SetupConnection` flags `DECLARE_TX_DATA` (bit 0) | U32 | ✅ | Echoed back in `.Success.flags`, drives `fullTemplateMode` |
| §6.4.2 | `AllocateMiningJobToken.user_identifier` | STR0_255 | ✅ | |
| §6.4.2 | `.request_id` | U32 | ✅ | |
| §6.4.2 | rate-limit "rather slow" | — | ✅ | `TOKEN_ALLOC_MIN_INTERVAL_MS = 1000ms` |
| §6.4.3 | `.Success.{request_id, mining_job_token, coinbase_tx_outputs}` | U32 / B0_255 / B0_64K | ✅ | SRI Rust struct calls it `coinbase_outputs`; wire identical |
| §6.4.3 | "first output reserved for pool payout" | — | ✅ | Single-output base = miner=pool-payout (solo). Multi-output via 0x0003 = fee address first. |
| §6.4.3 | prose mentions `coinbase_output_max_additional_size` | — | ⚠️ **SPEC BUG** | Field referenced in prose + ext 0x0003 §4.5 but **not in §6.4.3 table** and not in SRI. Vestigial. |
| §6.4.4 | `DeclareMiningJob.{request_id, mining_job_token, version, coinbase_tx_prefix, coinbase_tx_suffix, wtxid_list, excess_data}` | various | ✅ | `wtxid_list` (renamed from `tx_ids_list` in spec commit `a6ef07d`) — already current. |
| §6.4.4 | "BIP141 fields MUST NOT be stripped" | — | ✅ | JDC-side rule; we reconstruct via `Transaction.fromBuffer(prefix‖extranonce‖suffix)` and bitcoinjs handles SegWit |
| §6.4.5 | `.Success.new_mining_job_token` | B0_255 | ✅ | |
| §6.4.6 | `.Error.{error_code, error_details}` + codes | STR0_255 / B0_64K | ✅ | We emit `invalid-mining-job-token`, `invalid-job-param-value-*` |
| §6.4.7 | `ProvideMissingTransactions.unknown_tx_position_list` | SEQ0_64K[U16] | ✅ | 0-indexed, excludes coinbase |
| §6.4.8 | `.Success.transaction_list` | SEQ0_64K[B0_16M] | ✅ | Order preserved per request |
| §6.4.9 | `PushSolution.{extranonce, prev_hash}` | B0_32 / U256 | ✅ | |
| §6.4.9 | `PushSolution.nonce` / `.ntime` order | U32 / U32 | ⚠️ **SPEC TABLE WRONG** | Spec: `nonce` → `ntime`. SRI Rust + our impl: **`ntime` → `nonce`**. Real wire matches SRI. Byte-pin test guards regression. |
| §6.4.9 | `.nbits` / `.version` | U32 / U32 | ✅ | |
| §6.4.9 | "JDS MUST attempt to reconstruct/propagate using most-recent DeclareMiningJob.Success" | — | ✅ | We match by `prev_hash` first, fall back to most-recent. Conformant + better. |
| §6.4.9 / §6.1 | "JDC also propagates via TP; both submit" | — | ✅ | Core's `submitblock` is idempotent → harmless |

## B. Framing & TLV Model (§3)

| Spec Ref | Rule | Status | Note |
|---|---|---|---|
| §3.1 | All multibyte integers LE | ✅ for values | TLV header diverges — see §3.4.3 row below |
| §3.2 | Frame header: ext_type(U16) + msg_type(U8) + msg_length(U24) | ✅ | |
| §3.2.1 | `channel_msg` bit at MSB (0x8000) | ✅ | Spec prose says "least significant bit … bit 15, 0-indexed" — self-contradicting; bit-15 of U16 = MSB. Real impls + ours use MSB. |
| §3.2.1 | "JDP messages always have `channel_msg` unset" | ✅ | We never set on JDP send |
| §8 (Message Types table) | PushSolution listed with `channel_msg_bit = 1` | ⚠️ **SPEC INCONSISTENCY** | Contradicts §3.2.1. SRI doesn't set the bit. Table likely wrong. |
| §3.4.1 | Base JDP messages → frame ext_type = 0x0000 | ✅ | `AllocateMiningJobToken.Success` + 0x0003 TLV keeps ext_type=0x0000 |
| §3.4.1 | Ext-defined messages → frame ext_type = ext's ID | ✅ | `RequestExtensions.{,Success,Error}` use ext_type=0x0001 |
| §3.4.2 | "Extensions MUST require negotiation before non-version-negotiation messages" | ✅ | TLVs only emitted when ext in `negotiatedExtensions` |
| §3.4.3 | TLV Type: 3 bytes (U16 ext_type + U8 field_type) | ✅ | |
| §3.4.3 | TLV Length: 2 bytes (U16) | ✅ | |
| §3.4.3 | **TLV header endianness** | ⚠️ **SPEC AMBIGUOUS** | §3.1 default = LE; §3.4.3 wire example only parses correctly as BE for Type + Length. We chose BE per the visual; values stay LE. |
| §3.4.3 | TLVs at end of payload | ✅ | We append after base struct |
| §3.4.3 | TLVs ordered by ext_type | ✅ trivially | We never emit >1 TLV per msg |
| §3.4.3 | Length=0 means Value omitted | ✅ | Encoder refuses; parser accepts |
| §3.4.3 | Unknown TLVs ignored | ✅ | Parser skips unknown TLVs by header length |

## C. Extension 0x0001 (Negotiation)

| Spec Ref | Rule | Status |
|---|---|---|
| §1.1 | `RequestExtensions` → `.Success` or `.Error` | ✅ JDP + SV2 mining both |
| §2 | `RequestExtensions.{request_id, requested_extensions}` (U16, SEQ0_64K[U16]) | ✅ |
| §2 | `.Success.{request_id, supported_extensions}` | ✅ |
| §2 | `.Error.{request_id, unsupported_extensions, required_extensions}` | ✅ (we send empty `required_extensions` — we require nothing) |
| §3 | Frame ext_type = 0x0001 for all three messages | ✅ |
| §4.1 | "Server MUST respond `.Error` if NONE supported" | ✅ Both JDP and SV2 mining |
| §4.1 | "If server requires extensions not requested → list in `required_extensions`" | ✅ trivially (we require none) |
| §4.2 | "Client MUST send immediately after SetupConnection.Success" | ✅ JDP: we reject pre-setup. SV2 mining: lenient (accepts any time post-setup). |

## D. Extension 0x0002 (Worker-ID TLV on `SubmitSharesExtended`)

| Spec Ref | Rule | Status |
|---|---|---|
| §1.1 | TLV Type 0x0002 + Field 0x01 | ✅ |
| §1.1 | Length U16 ≤ 32 | ✅ encoder + parser enforce |
| §1.1 | Value UTF-8, no padding | ✅ |
| §1.3 | Server MUST ignore TLV when not negotiated | ✅ `ext0x0002Negotiated` gate |
| §1.3 | Receiver MUST scan TLV fields for negotiated extensions | ✅ |
| **N/A** | **Security: cross-address attribution** | ✅ Ours: TLV address ≠ channel address → silent fallback to channel default. **Spec doesn't define this** — we add it for safety. |

## E. Extension 0x0003 (Coinbase Output Weights — we wrote the spec)

| Spec Ref | Rule | Status |
|---|---|---|
| §1.1 | TLV Type 0x0003 + Field 0x01 | ✅ |
| §1.1 | Value SEQ0_64K[U32] | ✅ |
| §1.1 | weights count == coinbase output count OR zero | ✅ contract enforced via `resolveCoinbasePayout` shape |
| §1.1 | Sum S > 0 unless empty | ✅ encoder throws |
| §1.1 | Empty == TLV absent | ✅ we never emit empty (omit instead) |
| §1.3 | Not-negotiated → TLV MUST NOT be included | ✅ |
| §1.3 | Negotiated empty/absent → implicit `[1,0,…,0]` | ✅ we omit TLV for single-output even when negotiated |
| §2 | Allocation formula `floor(T * weights[i] / S)` | — JDC-side, not JDS |
| §2 | Residual to argmax(weights), tie → lowest index | — JDC-side |
| §2 | 128-bit arithmetic | — JDC-side |
| §2.1 | **JDS MUST validate exact pool-output amounts** | ⚠️ **PARTIAL** | We validate **script presence** only, not amounts. Strict amount validation is non-trivial (requires parsing JDC's declared coinbase outputs, identifying J = JDC's own outputs by elimination, computing T-J, verifying each pool amount). See §G. |
| §3 | Frame ext_type = 0x0000 (base message) | ✅ |
| §4.5 | Coinbase space governed by JDS' `coinbase_output_max_additional_size` commitment | ⚠️ that field isn't actually emitted (see §A row) |

## F. Open Spec Ambiguities / Bugs to Report Upstream

1. **PushSolution field order**: §6.4.9 table has `nonce` before `ntime`. SRI Rust + every real impl has `ntime` before `nonce`. Spec table is wrong. → File PR against `sv2-spec/06-Job-Declaration-Protocol.md`.
2. **TLV header endianness**: §3.1 says U16 is LE; §3.4.3 wire example only parses as BE for Type + Length. Either §3.1 needs a "TLV header is BE" carve-out, or the wire example is wrong. → Issue in `sv2-spec`.
3. **PushSolution `channel_msg_bit`**: §8 Message Types marks it `1`. §3.2.1 says "JDP NEVER sets channel_msg". Self-contradiction. → Likely §8 table typo.
4. **`coinbase_output_max_additional_size` mismatch**: §6.4.3 prose + ext 0x0003 §4.5 reference this field but it's not in §6.4.3 table and not in SRI struct. Vestigial from earlier draft? → Either add to table or remove from prose.
5. **§3.2.1 "least significant bit ... bit 15"**: Internal contradiction; bit 15 of a U16 is MSB. Prose typo, fix needed.

## G. Known Gaps in our Implementation

1. **Ext 0x0003 §2.1 strict amount validation**: We check script presence; we don't verify `amount[i] == floor(T * weights[i] / S) + residual_if_argmax`. Real-world consequence: a malicious JDC could submit a custom job where all pool-output sats land on one miner's output and we'd accept it. **Mitigated** by: (a) JDC has to produce a winning block for this to matter, (b) JDC's own reward depends on pool acceptance of subsequent shares — economically self-defeating. **Follow-up**: add proper validation when an SRI JDC with 0x0003 support actually exists.
2. **SV2 mining `setupComplete` check for RequestExtensions**: JDP enforces "after SetupConnection.Success", SV2 mining doesn't. Tightening would be cleaner.
3. **Empty `coinbase_outputs` handling**: We emit empty `[0x00]` only on resolveCoinbasePayout error fall-through. Better would be an explicit AllocateMiningJobToken.Error path (which doesn't exist in spec) or just keep current soft-fail — that's an edge case that shouldn't happen.

## H. Design Choices (Where Spec is Silent)

| Topic | Our Choice | Rationale |
|---|---|---|
| TLV header endianness | BE (Type + Length) | Matches visual wire example in §3.4.3 |
| 0x0002 user_identity format | Accept `<addr>.<worker>` OR bare `<worker>` | Mirrors our channel-open convention; bare is the only thing that fits in 32 bytes for mainnet bech32 |
| 0x0002 cross-address TLV | Silent fallback to channel default | Hard security boundary against cross-account attribution |
| Group-Solo via JDP | `finderAddress = JDP miner` | The miner allocating the JDP token is the prospective block-finder; finder-bonus is fully expressible via the 0x0003 weights |
| PushSolution matching | Prefer `prev_hash` match, else most-recent | Stricter than spec MUST; ensures right job picked when JDC declares multiple jobs concurrently |

## I. Tests Pinning These Guarantees

- `src/models/sv2/sv2-jdp-messages.spec.ts`: byte-pin for PushSolution field order (SRI compat)
- `src/models/sv2/sv2-extensions-messages.spec.ts`: 29 tests — spec wire examples + cross-address security + malformed-TLV tolerance
- `src/models/JobDeclarationClient.spec.ts`: 7 end-to-end state-machine tests through real `handleFrame` dispatcher
- `src/services/job-declaration.service.spec.ts`: 28 tests — mode-aware payout resolution, ext-gated TLV emission

**Total**: 907 jest tests / 81 suites green; `tsc --noEmit` clean.

## J. Watch-Points for Spec Changes

- **`add-extension-0x0003-coinbase-output-weights` branch / sv2-spec#195**: when merged, push for the endianness clarification in PR discussion
- **PushSolution nonce/ntime fix**: separate PR against `06-Job-Declaration-Protocol.md` would lock in our SRI-matching interpretation
- **§6.4.3 `coinbase_output_max_additional_size` cleanup**: if the field gets reactivated, we'd need to add it to serializer + parser
- **JDC SRI 0x0003 support**: when that lands, multi-output JDP goes live → strict §2.1 amount validation becomes more pressing
