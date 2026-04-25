# Blitzpool — PPLNS & Group-Solo Launch Posts

Drei Varianten: Schweiz (für Schweizer Kanäle), Deutsch neutral (für DACH-Kanäle allgemein), English (für alle anderen). Pro Variante eine Kurzversion (Twitter/Nostr ≤ 280 Zeichen) und eine Langversion (Telegram, Matrix, Mastodon, Blog).

## Der Kern-Claim

Blitzpool ist der erste Pool, der **non-custodial Payouts** für **alle drei Modi** (Solo, PPLNS, Group-Solo) anbietet — und das sowohl über **Stratum V1 als auch Stratum V2**.

- Non-custodial Solo gibt es bei Hobby-Solo-Pools (ckpool etc.) — meist nur SV1.
- Non-custodial PPLNS gibt es bisher nur bei Ocean (über DATUM, SV1).
- Non-custodial **Group-Solo** — Freundesgruppen, die gemeinsam solo minen und den Block direkt on-chain splitten — gab es **in keinem Pool weltweit**.
- Der kombinierte Stack (SV2 + alle drei Modi non-custodial) ist **einzigartig**.

Das ist der Aufhänger in allen Versionen. Der Rest ist Akzent.

---

## 🇨🇭 Schweiz / lokal

### Kurz

> Blitzpool — der Bitcoin Mining Pool aus der Schweiz — hat zwei neue Modi live: **PPLNS** für stärkere Maschinen mit regelmässigeren Auszahlungen und **Group-Solo** für Freundesgruppen, die gemeinsam minen. Block-Reward geht in allen drei Modi direkt on-chain an eure Adresse — **weltweit erster Pool der das non-custodial über Stratum V1 und V2 anbietet**. blitzpool.yourdevice.ch

### Lang

> Hallo Leute, wollte euch kurz mitteilen das wir beim Blitzpool nicht schlafen und komplett neue Wege gehen.

> **Blitzpool — Bitcoin-Mining aus der Schweiz. Jetzt mit drei Modi, alle non-custodial.**
>
> Wir sind als Solo-Mining-Pool gestartet, mit dem Versprechen: jeder gefundene Block geht zu 100 % an die Miner-Adresse, direkt in die Coinbase-TX, ohne Zwischenhalter. Das bleibt.
>
> Neu: zwei weitere Modi für Miner mit anderen Profilen — und beide komplett **non-custodial**, was in dieser Kombination so noch nicht existiert.
>
> **PPLNS** — der klassische Shared-Pool, aber ohne Pool-Wallet. Der Block-Reward wird direkt in der Coinbase-TX proportional auf die Miner-Adressen aufgeteilt. Keine Treuhand, kein Pool-Konto, kein Minimum-Payout.
> Sliding Window über 4× die Netzwerk-Difficulty. Geeignet für stärkere Maschinen, die kontinuierlich laufen und regelmässigere Auszahlungen wollen.
>
> **Group-Solo** — gemeinsam solo minen. Ihr bildet eine Gruppe, jeder gefundene Block wird proportional zu den Shares der Gruppenmitglieder aufgeteilt. Auszahlung direkt on-chain an jede einzelne Adresse. Kein Pool hält die Sats, kein Gruppen-Admin hat Zugriff.

> **Diese Funktion gibt es in dieser Form sonst nirgendwo** — auch nicht bei anderen non-custodial Pools.
>
> Zusammen mit unserer Stratum V2 Solo-Implementation sind wir der weltweit erste Pool, der alle drei Modi **non-custodial über SV1 und SV2** anbietet.

> Stratum V1 + V2 via Port 3333, TLS für SV1 auf Port 6666, PPLNS Port 3340, High-Difficulty-Port 3339 für Mining-Rentals.

>
> Made in Switzerland — von einem Bitcoiner, für echt Bitcoiner die verifzieren, anstatt zu vertrauen.

> blitzpool.yourdevice.ch

---

## 🇩🇪 / 🇦🇹 Deutsch neutral

### Kurz

> Blitzpool rollt aus: **PPLNS** für stärkere Maschinen, **Group-Solo** für Gruppen die zusammen minen. Block-Reward landet in allen drei Modi direkt on-chain bei euch — **weltweit erster Pool mit non-custodial Payouts für Solo, PPLNS und Group-Solo, über Stratum V1 und V2**. blitzpool.yourdevice.ch

### Lang

> Hallo Leute, wollte euch kurz mitteilen das wir beim Blitzpool nicht schlafen und komplett neue Wege gehen.

> **Neu bei Blitzpool: zwei zusätzliche Mining-Modi, beide komplett non-custodial.**
>
> Bisher: reines Solo-Mining, jeder Block zu 100 % an die Adresse die ihn gefunden hat. Ab jetzt zwei weitere Optionen — je nach Mining-Profil.
>
> **PPLNS** (Pay Per Last N Shares)
>
> - Sliding Window über 4× die Netzwerk-Difficulty
> - Regelmässige kleine Auszahlungen statt seltener grosser
> - Passt zu stärkeren Maschinen, die kontinuierlich laufen
>
> **Group-Solo**
>
> - Eine Gruppe teilt einen Solo-Pool
> - Jeder gefundene Block wird proportional zu den Shares der Mitglieder verteilt
> - Splits gehen direkt in die Coinbase-TX an die einzelnen Mitglieder-Adressen
>
> **Das Besondere: alle drei Modi sind non-custodial.**
>
> PPLNS non-custodial kennt man evt von OCEAN (über DATUM). Group-Solo gibt es in dieser Form — eine Gruppe, ein geteilter Coinbase-Output, alles on-chain und ohne Treuhänder — in **keinem anderen Pool**. Und der gesamte Stack läuft sowohl über **Stratum V1 als auch V2**, was uns zum ersten Pool weltweit macht, der alle drei Modi non-custodial über SV1+SV2 anbietet.
>
> Keine Pool-Wallet, kein Konto, kein Passwort, kein KYC. Die Bitcoin-Adresse ist euer Account.
>
> Stratum V1 + V2 via Port 3333, TLS für SV1 auf Port 6666, PPLNS Port 3340, High-Difficulty-Port 3339 für Mining-Rentals.
>
> blitzpool.yourdevice.ch

---

## 🇬🇧 English

### Short

> Blitzpool now offers **PPLNS** for stronger rigs and **Group-Solo** for friends mining together. Block reward lands in the coinbase tx directly at your address in every mode — **world's first pool with non-custodial payouts for solo, PPLNS and group-solo, on Stratum V1 and V2**. blitzpool.yourdevice.ch

### Long

> Hey guys, wanted to show that we do some crazy cool stuff on blitzpool

> **Two new mining modes at Blitzpool — both completely non-custodial.**
>
> Solo was our starting point, and still our default: every found block, 100 % to the address that mined it, no fees, straight in the coinbase transaction, as you all know it. That doesn't change.
>
> What's new: two additional modes for miners whose profile doesn't fit pure solo what is now special about this? — **both keeping the non-custodial property**.
>
> **PPLNS** — classic shared pool, reinvented without the pool wallet.
>
> - 4× network difficulty sliding share window
> - Block reward split proportionally across active miners' addresses, directly in the coinbase
> - No pool balance, no withdrawal threshold, no account
> - Fits continuous miners`with bigger machines who want smoother income
>
> **Group-Solo** — a solo pool for groups of friends, communities, collectives.
>
> - A group shares one solo round
> - Every found block is split proportionally to each member's contributed share
> - Splits land directly in the coinbase to each member's own address, no custodial payout system that might, fail, hang or needs attention. Everything done by the network
> - No pool, no group admin holds anyone's sats
>
> Non-custodial PPLNS exists in the wild (Ocean, via DATUM) but **Group-Solo at protocol level doesn't exist anywhere else.** And supporting all three modes non-custodial across **both Stratum V1 and V2** makes us the first pool to ship this complete stack.
>
> No pool wallet, no account, no password, no KYC. Your Bitcoin address is your login.
>
> Stratum V1 + V2 via Port 3333, SV1 TLS on Port 6666, PPLNS Port on 3340, high-difficulty port 3339 for mining rentals (which you can btw directly rent within our dashboard and pay via Lightning).
>
> come and check by, we want to kick big pools asses and decentralize even further. If everything goes well on testing, we release the new modes within 2 weeks. We already tested via regtests and all multiple coinbase output transactions are accepted by core in almost very manner we tested.

---

## Nostr / Twitter-Snippets (für Reposts, Cross-Posts)

Kurze standalone Zitate zum Re-Sharen:

> Blitzpool: der erste Pool weltweit, der non-custodial Payouts für Solo, PPLNS **und** Group-Solo anbietet — auf Stratum V1 und V2. Coinbase-TX splittet direkt on-chain, kein Pool-Wallet hält je eure Sats.

> Non-custodial Group-Solo Mining gibt's jetzt live bei Blitzpool. Freunde bilden eine Gruppe, gefundener Block wird direkt in der Coinbase-TX proportional auf die Mitglieder-Adressen aufgeteilt. In dieser Form noch nirgendwo sonst verfügbar.

> Blitzpool now runs non-custodial PPLNS and Group-Solo alongside Solo — the first pool to ship all three modes on both Stratum V1 and V2. Block splits land on-chain, straight to your address. No pool wallet, no account, no KYC.

> Group-Solo Mining — friends pool their hashrate, block reward splits directly on-chain to each member's address. Non-custodial, no intermediary, no group admin holds anyone's sats. First time this exists in any pool.

---

## Notizen für mich

- Kern-Claim: **erster Pool mit non-custodial Payouts für alle drei Modi auf SV1+SV2**
- Group-Solo ist das stärkste Alleinstellungsmerkmal weil es das nirgends sonst gibt
- PPLNS non-custodial hat Ocean (SV1/DATUM) — darf ehrlich erwähnt werden, schwächt den Claim nicht
- Keine CTAs wie "sign up now" — wir haben keinen Account-Flow
- Kein Preis-Anker / ROI-Behauptungen
- Wenig Emojis, keine Raketen oder Geldstapel
- Schweiz-Bezug nur in der 🇨🇭-Variante
- Port-Angaben (6666 TLS, 3339 high-diff) in Langversionen, in Kurzversionen weglassen
- "Non-custodial" + "no account / no KYC" + "Stratum V2" sind die drei Anker-Begriffe
