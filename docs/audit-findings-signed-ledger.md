# PPLNS Signed-Ledger + Port-Gate Audit — Ergebnisse

Ich habe die geforderte 3-Block-Handspur gebaut (A: Trim → B: Rückzahlung → C: Aufgabe + Sweep), Phase 5a/5a.5/5b end-to-end durchgespielt und die Port-Gate-Verdrahtung sowohl in SV1 als auch SV2 gelesen. Die Ledger-Mathematik ist größtenteils solide: Summenerhaltung hält, Phase-5b-Matching-Debits sind exakt, Pair-Sweep-Logik ist im Happy Path korrekt. Aber es gibt zwei ernste Bugs im Distributionsalgorithmus (beide auf einem realen Pool erreichbar, während er altert) und einen SV2-spezifischen Gate-Bypass.

---

## CRITICAL

### C1. Getrimmte Pending-only-Kredithalter lösen Fee-100-%-Fallback aus — Miner verlieren gesamten Block

`src/services/coinbase-distribution.ts:355-356`

```ts
let trimmedTotal = 0;
for (const c of trimmed) trimmedTotal += c.target;
```

`target = rawFair + balanceOld`. Für einen **Pending-only**-Miner (shares=0, balanceOld>0) ist target = balanceOld — ein Anspruch auf Sats, die der Pool *in einem früheren Block bereits ausgezahlt hat*. Der Algorithmus addiert das zu `trimmedTotal` und verteilt es als On-Chain-Bonus an keep-aktive Miner (mit passendem Debit). Diese physischen Sats existieren nicht — die tatsächlich neuen Sats des Blocks sind durch `rewardForMiners` begrenzt.

**Trigger-Szenario (erreichbar)**: Während der Pool altert, sammeln sich aufgegebene-aber-noch-nicht-gesweepte Kredithalter (Inaktivität < 90 Tage). Angenommen 300 solche Kredithalter mit je +600 + 1 aktiver Miner Alice. Weight Budget fasst 286 Outputs:
- kept = Alice + 285 Kredithalter; trimmed = 15 Kredithalter.
- trimmedTotal = 15 × 600 = 9.000 → Alice bekommt +9.000 On-Chain-Bonus und -9.000 Debit.
- preliminaryOnChain = Alice.rawFair + 9.000 + 285×600 = rewardForMiners + 180.000.
- overshoot = 180.000. creditClaimers-in-kept = 285 × 600 = 171.000 < 180.000.
- Phase 5a.5 fällt durch zum `CRITICAL ... Emitting fee-100 % fallback` (Zeile 447-458). **Gesamte Block-Reward geht an die Fee-Adresse. Alle Miner verdienen in diesem Block null.**

Der Docblock und die Tests behaupten, dieser Zweig sei „mathematisch unmöglich" (Zeile 444). Das stimmt für den engen Fall, den die Tests abdecken (alle Kreditgeber kept), ist aber falsch, sobald irgendein Kredithalter *getrimmt* wird. Der Property-Test bei `coinbase-distribution.spec.ts:547-589` limitiert n auf 17 Miner, nirgendwo nahe der ~286-Miner-Trim-Schwelle, also ist die Abdeckung blind dafür.

**Fix-Skizze** (einzeilige Änderung):
```ts
let trimmedTotal = 0;
for (const c of trimmed) {
    // Die balanceOld eines Pending-only-getrimmten Kreditgebers ist ein Anspruch
    // auf Sats aus vergangenen Blöcken. Nur Sats, die *in diesem Block* tatsächlich
    // verdient wurden, sind umverteilbar.
    trimmedTotal += c.shares > 0 ? c.target : 0;
}
```
Pending-only-Trimmed: balanceNew bleibt = target (Kredit wird unverändert weitergetragen). Aktiv-Trimmed verteilen weiterhin `rawFair + balanceOld` genau wie vorher (diese Ledger-Mechanik ist korrekt — verifiziert in meiner Block-B-Spur).

Füge einen Regressionstest mit 300 Pending-only-Kreditgebern + 1 aktivem Miner hinzu und prüfe:
1. Kein Fee-100-%-Fallback feuert (Log nicht emittiert).
2. sum(balances_after) = sum(balances_before) ± N.
3. Alice's On-Chain ≤ rewardForMiners.

---

### C2. Group-Solo erzeugt jetzt negative `pendingSats`, die kein Sweep erreichen kann

`src/services/group-solo.service.ts:212-236` + `src/ORM/pplns-group/pplns-group-balance.entity.ts:20-24`

Group-Solos `getPayoutDistribution` wurde durch den gemeinsamen `buildCoinbaseDistribution` umverkabelt. Die zurückgegebene `balanceAfter`-Map enthält vorzeichenbehaftete Werte (Phase-5a-Bonus-Empfänger bekommen *Debits*, Phase-5b-Residuum-Empfänger bekommen *Debits*). Diese werden wörtlich bei `group-solo.service.ts:404` geschrieben:
```ts
balance.pendingSats = newBalance;   // kann jetzt negativ sein
```

Aber:
- **Dust-Sweep** (`dust-sweep.service.ts:308`) fragt nur `pendingSats > 0 AND pendingSats < :dust` ab. Negative werden niemals gesweept.
- **removeMemberState** (`group-solo.service.ts:672-702`) verteilt Pending nur um, wenn `pendingToRedistribute > 0`; negative Zeilen werden bei Member-Kick still gelöscht und brechen die Summenerhaltung innerhalb der Gruppe.
- **onBlockFoundFromWindow-Fallback** (`group-solo.service.ts:515`) summiert `totalPending` unter der Annahme ≥ 0, unterschätzt es wenn Negative vorhanden sind → `effectiveMinerReward` wird aufgebläht → Coinbase kann rewardForMiners überschreiten → `bad-cb-amount`-Ablehnung, falls ein Restart den Fallback-Pfad erzwingt, nachdem sich Negative angesammelt haben.

**Trigger-Häufigkeit**: jeder Block mit Floor-Rounding-Residuum (≥ die meisten Blöcke). Mit 10 Mitgliedern und ungleichen Shares erzeugt Phase 5b Residuum 1–10 Sat-Debits pro Block, die sich *für immer* anhäufen.

**Fix-Skizze**: entweder (a) einen Signed-Ledger-Sweep-Pass für Gruppen hinzufügen (`sweepPplnsPairs` gegen `pplns_group_balance` scoped by groupId spiegeln), plus `removeMemberState` aktualisieren, um Negative zu handhaben (Schulden werden bei Kick abgeschrieben — Operator toleriert das, aber zumindest explizit), plus `onBlockFoundFromWindow` dazu bringen, `Math.max(0, pendingSats)` in seiner Summe zu verwenden; ODER (b) Gruppen komplett aus der Phase-5a/5b-Matching-Debit-Erzeugung ausschließen (ein Flag in `buildCoinbaseDistribution` übergeben, das die Residuum-Umverteilung für Gruppen unterdrückt und stattdessen Rest-Residuum zur Fee brennt). Option (a) ist konsistenter, aber mehr Code; Option (b) stellt das in den Docblocks behauptete „Group-Solo wird nie negativ"-Invariant wieder her.

---

## HIGH

### H1. SV2 umgeht das PPLNS-Min-Difficulty-Gate via `nominalHashRate` / `maxTarget`

`src/models/StratumV2Client.ts:573-587` (OpenStandardMiningChannel), `:739-753` (OpenExtendedMiningChannel), `:840-865` (UpdateChannel)

Alle drei Stellen berechnen `channelDifficulty` aus der client-gelieferten `nominalHashRate` via `DifficultyUtils.hashRateToDifficulty(...)`, und klemmen dann **nur nach unten** via `clampDifficultyToMaxTarget`. Das `portMinDiff`-Floor, das beim Konstruieren angewendet wird (Zeile 238-241), ist nur die *Default*-Baseline — sobald der Client eine niedrige nominalHashRate oder ein einfaches maxTarget angibt, wird `channelDifficulty` unterhalb des Floors überschrieben. Das `this.sessionDifficulty = channelDifficulty`-Update bei `isFirstChannel` (Zeile 587) schlägt dann auch das Session-Level-Floor für nachfolgende VarDiff-Baselines.

**Angriff**: Verbinde dich zum PPLNS-Port über SV2, sende OpenStandardMiningChannel mit `nominalHashRate = 1e6` (1 MH/s CPU) → Pool berechnet `channelDifficulty ≈ 1`. Alle nachfolgenden Shares werden bei Diff 1 (statt Floor 500) validiert. Das Warmup-Gate fängt noch Shares 1..10 ab, aber Shares 11+ verschmutzen das PPLNS-Fenster mit Sub-Dust-Shares — genau der Angriff, den das Gate blockieren sollte.

SV1 ist nicht betroffen: Der `mining.suggest_difficulty`-Handler in Zeile 591-593 klemmt *nach oben* auf `minimumDifficulty`, und VarDiff in `StratumV1ClientStatistics.nearestDifficultyStep` floort ebenfalls bei `minDifficulty`.

**Fix-Skizze**: Nach jeder der drei Clamp-Down-Stellen einen Aufwärts-Clamp zum Port-Floor hinzufügen:
```ts
channelDifficulty = DifficultyUtils.clampDifficultyToMaxTarget(channelDifficulty, msg.maxTarget);
const portMin = this.portConfig.minimumDifficulty ?? 0;
if (portMin > 0 && channelDifficulty < portMin) {
    // Kann nicht sowohl Port-Floor UND Client-maxTarget erfüllen → Channel ablehnen.
    if (DifficultyUtils.clampDifficultyToMaxTarget(portMin, msg.maxTarget) < portMin) {
        // ablehnen mit max-target-out-of-range
        return;
    }
    channelDifficulty = portMin;
}
```
Regressionstests unter `StratumV2Client` hinzufügen, die prüfen, dass eine niedrige nominalHashRate auf PPLNS-Ports ein Min-Diff-Floor bekommt und bei inkompatiblem maxTarget abgelehnt wird.

### H2. dust-sweep Pair-Match: In-Memory-Mutationen lecken bei TX-Fehler

`src/services/dust-sweep.service.ts:229-285`

Innerhalb des TX-Callbacks mutiert der Code die In-Memory-Objekte *bevor* das DB-Delete/Update:
```ts
credit.balanceSats -= amount;
debit.balanceSats  += amount;
if (credit.balanceSats === 0) await balance.delete(...);
else                           await balance.update(...);
```
Falls `balance.delete` oder `balance.update` wirft, rollt die TX auf DB-Seite zurück — aber `credit`/`debit`-Objekte behalten die mutierten Werte. Der äußere Loop-Advance-Check (`if (credit.balanceSats === 0) i++`) liest dann veralteten Zustand und überspringt potenziell zum nächsten Kredit, obwohl der vorherige noch seinen vollen DB-Saldo hat. Nachfolgende Iterationen schreiben weitere DB-Mutationen gegen veraltete In-Memory-Werte.

**Impact**: partielles Sweep-Fehlschlagen korrumpiert still den Ledger. Ein Retry nächste Nacht macht ihn nicht sauber (die In-Memory-Fehler sind nur in diesem Sweep, aber die DB-seitige Partial-Credit-Zeile überlebt).

**Fix-Skizze**: entweder *nach* den DB-Ops mutieren, oder im catch abwickeln:
```ts
} catch (err) {
    credit.balanceSats += amount;
    debit.balanceSats  -= amount;
    console.warn(`[DustSweep] pair ${credit.address}/${debit.address} failed:`, ...);
}
```

---

## MEDIUM

### M1. `applyDistributionWithoutSnapshot` kann Ledger von On-Chain-Coinbase desynchronisieren

`src/services/pplns.service.ts:524-552`

Wenn das Snapshot fehlt oder Reward-Mismatch vorliegt, baut der Fallback die Verteilung aus dem *aktuellen* Fenster + *aktuellen* Balances neu auf — was **nicht** das ist, was das Template des Miners verwendet hat, um die Coinbase zu bauen, die tatsächlich gelandet ist. Die Ledger-Writes gehen davon aus, dass die neuberechnete Verteilung der Realität entspricht; wenn nicht, widersprechen die Per-Miner-On-Chain-Totals in `totalPaidSats` dem Block-Explorer.

**Wahrscheinlichkeit**: gering (1h Redis-TTL + AOF; nur ausgelöst durch einen vollständigen Pool-Ausfall, der das Block-Finden überbrückt, oder durch einen Concurrent-Job-Reward-Mismatch), aber der Fehler ist still und permanent — der Idempotenz-Pre-Check in Zeile 469 wird die Neuverarbeitung verweigern.

**Fix-Skizze**: eine laute Operator-Warnung loggen, die sowohl die neuberechnete Verteilung als auch die Block-Found-Daten enthält, sodass manuelle Abstimmung zumindest möglich ist. Optional History-Zeilen mit einem `audit-note = 'recomputed from window'` markieren, sodass Miner, die ihre Historie abfragen, „diese Block-Aufteilung ist approximiert" sehen.

### M2. Multi-Block-Property-Test fehlt

`src/services/coinbase-distribution.spec.ts:591-649` testet Drift-Bound über 30 zufällige *Einzelblock*-Konfigurationen. Es gibt keinen Test, der 20+ Blöcke mit zufälligem Miner-Churn (manche aufgebend, manche neu, Sub-Dust erscheint) verkettet und Drift innerhalb des dokumentierten Bounds über die Sequenz prüft. Das ist genau die Abdeckung, die C1 (getrimmte Kredithalter) in der Entwicklung gefangen hätte.

**Fix-Skizze**: einen `property: 20-block simulation, drift bounded by (blocks × maxMinersPerBlock)`-Test hinzufügen, der 300+ Miner seedet, sie zufällig in jedem Block aktiv/inaktiv dreht und Summenerhaltung plus kein Fee-100-%-Fallback-Feuer prüft.

### M3. Group-Solo-Solvency-Cap-Pfad untestet

Mit C1 gefixt wird der gemeinsame `buildCoinbaseDistribution` weiterhin für Gruppen aufgerufen. Es gibt keinen gruppenspezifischen Test, der eine realistische 10-Mitglieder-Gruppe abdeckt, die einen dieser Pfade trifft:
- Phase 5a Trim (erfordert > maxMinerOutputs Mitglieder — nicht realistisch für Gruppen, aber der Code-Pfad ist live).
- Phase 5a.5 Solvency Cap (erfordert gespeicherte negative pendingSats, was C2 ermöglicht).
- Phase 5b Residuum (feuert jeden Block wegen Floor-Rounding).

`group-solo.service.spec.ts` deckt die PROP-Level-Logik ab, aber nicht die Interaktion der gemeinsamen Distributions-Library mit dem Gruppenzustand.

### M4. `PplnsBalanceService.addBalance` / `markPaid` sind toter und gefährlicher Code

`src/ORM/pplns-balance/pplns-balance.service.ts:41-54`, `:95-102`

`addBalance` und `markPaid` werden aus keinem Produktionspfad aufgerufen (grep bestätigt, nur Test-Fixtures verwenden sie). Sie mutieren Balances außerhalb der `onBlockFound`-Transaktion, sodass falls jemand sie jemals aus einem Hot Path aufruft, sie mit dem absolute-Write-Pattern kollidieren würden, das jetzt die einzige Quelle der Wahrheit ist. Löschen, oder klar als test-only markieren.

### M5. UI-`maxMinerOutputs`-Formel widerspricht Backend

`blitzpool-ui/.../pplns-info-page.component.html:479-484` subtrahiert immer einen Fee-Output-Anteil Gewicht und verwendet `number:'1.0-0'` (Runden) statt `floor`. Backend (`coinbase-distribution.ts:311-318`) subtrahiert Fee-Gewicht bedingt auf `feeEmitted` und verwendet `Math.floor`. Mit Default-Budget zeigt die UI `287`, Backend verwendet `286`. Ohne Fee-Adresse ist die UI um eins mehr daneben.

**Fix-Skizze**: `maxMinerOutputs` zur `/api/pplns/fees`-Antwort hinzufügen (im Backend via `pplnsService.getMaxCoinbaseOutputs()` berechnen, das bereits in `pplns.service.ts:220-229` existiert) und das direkt anzeigen, statt es im Template neu abzuleiten.

### M6. UI-Kredit-Progress-Bar-Ziel-Semantik

`blitzpool-ui/.../pplns-info-page.component.ts:207-215`

`formatCreditProgress(balanceSats, dustLimitSats)` verwendet `dustLimitSats` (546) als Progress-Ziel. Das ist nur korrekt für einen Pending-only-Miner (shares=0) — für einen *aktiven* PPLNS-Miner clearet der Kredit, sobald `balance + rawFair ≥ 546`, was im Wesentlichen der nächste akzeptierte Block ist. Also sieht ein aktiv minender Miner mit einem winzigen +10-Sat-Kredit einen Balken bei „1,8 % bis Dust", wenn tatsächlich sein Kredit sofort clearet.

**Fix-Skizze**: entweder den Balken nur rendern, wenn `miningMode === 'pplns'` UND der User keine Shares im aktuellen Fenster hat, oder das Ziel durch eine bedeutungsvolle Größe ersetzen (z. B. „clearet nächsten Block, wenn du weiter minest").

---

## LOW

### L1. Tote `oldBalance`-Variable in `applyDistribution`
`src/services/pplns.service.ts:664-666` — beide Zweige des Ternary geben 0 zurück; `oldBalance` wird nie verwendet. Entfernen.

### L2. `applyDistribution` kann doppelte `'pending'`-Audit-Zeilen einfügen
`src/services/pplns.service.ts:662-680` fügt eine Pending-Audit-Zeile für jede Adresse in `balanceAfter` ein, die nicht im Coinbase-Snapshot ist. Zeile 687-698 fügt dann *noch eine* Pending-Audit-Zeile für Late-Arriver im aktuellen Fenster ein, die nicht berücksichtigt wurden. Falls ein Late-Arriver *auch* einen non-zero `balanceAfter`-Eintrag hat (unwahrscheinlich, aber möglich, wenn `applyDistributionWithoutSnapshot` alles neugebaut hat), bekommt er zwei Pending-Zeilen für dasselbe `(blockHeight, address)` — was den Unique-Index auslöst und den 23505-Catch trifft, der eine Warnung loggt. Den zweiten Loop mit `if (balanceAfter.has(addr)) continue` schützen.

### L3. `balanceLabel`-Färbung invertiert Intuition für Debits
`blitzpool-ui/.../pplns-info-page.component.html:68-77` — ein Debit (Miner hat bereits *mehr* On-Chain erhalten als verdient) wird in Rot mit einem „Up Arrow" gezeigt, was suggeriert, dass etwas falsch ist. Aus Miner-Perspektive bedeutet ein Debit, dass er voraus ist, nicht hinterher. Erwäge Neutralisierung (Gelb/Info) mit Tooltip-Text wie „Du wurdest letzten Block extra bezahlt — nächster Block-Anteil wird kleiner, um auszugleichen." Reine UX-Entscheidung, kein Bug.

### L4. PPLNS-Pair-Sweep `blockHeight = -Math.floor(Date.now() / 1000)` Kollision
`src/services/dust-sweep.service.ts:165-167` — alle Paare in einem Sweep-Lauf teilen denselben negativen Timestamp (weil `sweepBlockHeight()` einmal pro `sweepPplnsPairs`-Aufruf in Zeile 219 aufgerufen wird). Mit dem Unique-Index auf `(blockHeight, address)` würden zwei verschiedene Sweep-Läufe innerhalb derselben Sekunde, die beide dieselbe Adresse berühren, kollidieren (unmöglich im @Cron-Tagesplan, aber ein manueller `service.sweep()`-Aufruf könnte das in Tests auslösen).

### L5. Phase 5a „no kept active miners"-Edge nie ausgeführt
`coinbase-distribution.ts:380-391` warnt und underschießt die Coinbase. Kein Test erreicht diesen Zweig. Auf einem realen Pool praktisch unerreichbar (erfordert, dass alle kept Miner pending-only sind + alle aktiven Miner sub-dust), aber es lässt still Sats ohne Ledger-Eintrag fallen — wert, einen einzelnen Regressionstest mit dem konstruierten Input zu haben.

### L6. `docs/pplns-payouts.md:86` sagt „drifts by at most `N` sats per block"
Präziser: Drift-Magnitude pro Block ist begrenzt durch `max(keptActive, N_miners)`. Kein benutzerbezogenes Problem, nur eine Docstring-Ungenauigkeit, die dem `toBeLessThanOrEqual(n)` des Tests entspricht (das die Gesamtanzahl der Miner verwendet, nicht kept-active).

---

## Was den Test besteht

- **Phase-5b-Residuum-Matching**: Per-Miner-Bonus und Matching-Debit sind immer gleich (verifiziert in `coinbase-distribution.ts:487-491` und die Floor-Tail-Konzentration auf den größten Miner bei `:494-501`). Keine unmatched Sat-Erzeugung.
- **Phase-5a.5-Fairness für aktive Miner**: nur Miner mit `balanceOld > 0` werden gekürzt; aktive Miner mit Shares aber Zero/Negativer Balance behalten ihr volles rawFair. `cut ≤ balanceOld_i`-Bound wird durch das `totalCredit ≥ overshoot`-Invariant bewahrt (das im Happy Path *hält* — bricht nur unter dem C1-Szenario).
- **Idempotenz**: Der Pre-Check auf `pplns_payout_history.blockHeight` plus der 23505-Catch kurzschließen Replay korrekt, abgedeckt durch `onblockfound-idempotency.spec.ts`.
- **Pair-Sweep-Summenerhaltung** (modulo H2): Wenn TX erfolgreich, ist `sum(balances)` strikt bewahrt — verifiziert durch `dust-sweep.service.spec.ts:237-259`.
- **SV1-Port-Gate**: vollständig korrekt. Suggest-Difficulty geklemmt, Initial geklemmt, VarDiff gefloort. Warmup-Counter pro Session, Reconnect erlaubt (by design).
- **Snapshot-TTL**: 1h Redis-TTL + AOF, Idempotenz-Pre-Check macht Replay-nach-Restart sicher.
- **Routing-Priorität** (PPLNS-Port trumpft Gruppenmitgliedschaft): konsistent angewendet über SV1 + SV2 an allen drei Entscheidungsstellen (Coinbase-Build, Share-Record, Block-Found).

Die zwei CRITICAL-Findings sind diejenigen, die vor dem v2.1.0-Tag-Ship gefixt werden müssen. H1 ist ähnlich dringend, falls dir ASIC-only-Enforcement über SV2 wichtig ist. Alles andere kann ins Backlog.
