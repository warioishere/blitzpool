# Security & Code Review — Blitzpool Payout Group Feature

*Date: 2026-04-22*
*Scope: feature/group-chart-endpoint (pool backend) + feature/payout-group-ui (Angular UI)*
*Reviewer: independent audit (claims verified against source)*

## Executive Summary

Der email-basierte Invitation-Flow ist konzeptionell gut gedacht (Verified-Email als Trust-Anchor, Token nicht in create/banner-Response, HTML-Escaping korrekt, 256-bit Token-Entropie, SHA-256 + `timingSafeEqual` für Admin-Token). **Aber es gibt zwei Show-Stopper, die das "silent-add"-Versprechen ins Wanken bringen**, plus einen Money-Math-Bug in der Balance-Row-Verwaltung.

Gesamt-Risikobewertung: **nicht produktionsreif** in aktuellem Zustand. Drei `CRITICAL`-Findings verhindern Mainnet-Release. Einige davon sind Einzeiler zum Fixen, aber sie sind die Art "wenn wir übersehen hätten, würde es uns später richtig wehtun".

---

## 1. Critical Findings

### C1 — `selfLeave` ist vollständig unauthentifiziert → Kick-Bob-by-Address DoS

**File:** `src/controllers/pplns-group/pplns-group.controller.ts:400-408`

```ts
@Delete(':id/members/:address/self')
async selfLeave(@Param('id') id: string, @Param('address') address: string) {
    try {
        await this.groupService.selfLeave(id, address);
        return { removed: true };
    } catch (e) {
        throw this.toHttpError(e);
    }
}
```

Kein `@Headers('x-admin-token')`, keine Session, keine Signatur-Verifikation, **keine Prüfung dass der Caller die Adresse tatsächlich besitzt**. Jeder der Bob's BTC-Adresse kennt (= öffentlich bekannt sobald Bob irgendeine Zahlung erhalten hat), kann:

```
curl -X DELETE https://pool/api/pplns/groups/<gid>/members/bc1qbob.../self
```

Bob fliegt aus der Gruppe. `selfLeave` in `group.service.ts:258-267` blockt zwar das Löschen des Creators (`creator-cannot-self-leave`), aber **jedes normale Member** ist fair game. Bob muss das Problem bemerken, Admin kontaktieren, erneut eingeladen werden. Mallory kann das alle paar Minuten wiederholen.

**Impact:** Dauerhafter Denial-of-Payout auf einzelne Adressen; Kriegsführung zwischen konkurrierenden Gruppen.

**Reproducer:**
1. Bob ist Member in Gruppe G
2. Mallory liest Bob's Mining-Adresse aus der Public-Member-Liste (`GET /pplns/groups/:id`)
3. `DELETE /pplns/groups/<gid>/members/bc1qbob/self` — keine Auth-Header
4. Bob ist raus, Shares routen wieder Solo/PPLNS

**Fix direction:** Caller muss Ownership der Adresse beweisen. Optionen: (a) BIP-137-Signatur im Body (`signmessage` mit Adressen-Privkey), Backend verifiziert gegen Adresse; (b) Bob als Miner hat eh eine authentifizierte Stratum-Session — falls es einen Signed-Action-Mechanismus gibt, den nutzen; (c) vorerst einfach den Endpoint **entfernen** und Leaves nur über Admin-Kick zulassen, bis das Auth-Modell steht. Option (c) ist der pragmatischste Sofort-Fix.

---

### C2 — Admin sieht Invitation-Token im Klartext → silent-add ist umgangen

**File:** `src/controllers/pplns-group/pplns-group.controller.ts:346-365`

```ts
@Get(':id/invitations')
async listInvitations(@Param('id') id: string, @Headers('x-admin-token') token?: string) {
    await this.groupService.requireAdminToken(id, token);
    const rows = await this.invitationService.listPendingForGroup(id);
    return rows.map(r => ({
        token: r.token,             // ← plaintext token
        address: r.address,
        email: maskEmail(r.email),
        ...
    }));
}
```

Parallel dazu: `POST :id/invitations` (Zeile 280-292) gibt den Token **nicht** zurück — das ist korrekt, der Admin braucht ihn nicht. **Aber 50 Zeilen weiter unten gibt das Admin-Listing-Endpoint ihn doch aus.** Das vernichtet den gesamten "email ist Trust-Anchor"-Schutz:

**Angriff:**
1. Mallory ist Admin von Gruppe M (sie hat sie selbst angelegt, hat `x-admin-token`)
2. Victim Alice hat eine verifizierte Email (normaler Flow)
3. Mallory: `POST /pplns/groups/M/invitations` mit `{ address: "bc1qalice..." }` → backend schickt Einladungsmail an Alice
4. Mallory: `GET /pplns/groups/M/invitations` mit ihrem Admin-Token → Response enthält `token: "abc..."` im Klartext
5. Mallory: `POST /pplns/invitations/abc.../accept` (public endpoint, keine Auth) → **Alice ist jetzt Mitglied, ohne die Mail je gesehen zu haben**
6. Alice's Block-Fund-Payouts routen nach Gruppe M

Der Email-Trust-Anchor funktioniert nur, wenn der Token NIEMALS außer im Email-Body auftaucht. Das Listing verrät ihn an genau die Partei, der wir nicht vertrauen dürfen — den eigenen Admin.

**Fix direction:** Token aus dem Response entfernen. Der Admin braucht für Cancel eh nur `{ address, createdAt, expiresAt }` — die Cancel-API müsste dann nicht per Token, sondern per `(groupId, address)` oder einer separaten internen `invitationId` arbeiten:

```ts
@Delete(':id/invitations/by-address/:address')   // state-identifying, not credential
async cancelInvitation(...)
```

Oder: Server hält einen zweiten, server-seitigen `shortId` für Admin-Referenzen, während der eigentliche `token` nie das Backend verlässt außer im Email-Body.

---

### C3 — `addPending` updated `groupId` nie → stale Balance-Zeile zieht Geld in frühere Gruppe

**File:** `src/services/group-solo.service.ts:440-450`

```ts
private async addPending(groupId: string, address: string, sats: number): Promise<void> {
    const existing = await this.balanceRepo.findOneBy({ address });   // no groupId filter
    if (existing) {
        existing.pendingSats += sats;          // ← groupId stays on whatever it was
        await this.balanceRepo.save(existing);
    } else {
        await this.balanceRepo.save(this.balanceRepo.create({
            address, groupId, pendingSats: sats, totalPaidSats: 0,
        }));
    }
}
```

Kombiniert mit `src/services/group.service.ts:347-356` (`dissolveInternal`) und `:269-305` (`internalRemove`): **Balance-Zeilen werden nie gelöscht**, weder bei Member-Leave, noch bei Dissolve. Die globale Unique-Constraint auf `pplns_group_member.address` (migration Z.30, entity Z.15) garantiert zwar dass eine Adresse zu jedem Zeitpunkt in höchstens einer Gruppe ist — aber sobald eine Adresse zwischen Gruppen wechselt, bleibt die alte Balance-Zeile mit dem alten `groupId` stehen.

**Szenario:**
1. Bob ist in Gruppe A, bekommt sub-dust Payout aus Block 1 → Zeile `{address=Bob, groupId=A, pendingSats=300}`
2. Bob verlässt A (selfLeave oder Admin-Kick), Member-Zeile weg, **Balance-Zeile bleibt mit groupId=A**
3. Bob wird in Gruppe B eingeladen und akzeptiert
4. Gruppe B findet Block 2, Bob bekommt 500 sats sub-dust → `addPending(groupId=B, address=Bob, sats=500)`
5. Der `existing`-Pfad feuert, `pendingSats` wird 800, **`groupId` bleibt `A`**
6. Gruppe A findet irgendwann Block 3 (andere Mitglieder zahlen ein). `getPayoutDistribution(A)` Zeile 177: `this.balanceRepo.find({ where: { groupId: 'A' } })` → findet Bob's Zeile mit 800 sats. Zeile 193-201: Bob landet als "pending-only entry" in A's Coinbase. **Gruppe A zahlt 800 sats aus ihrem Block an einen Nicht-Member, davon 500 sats ursprünglich Gruppe B's Work-Share.**

Spiegelbildlich in `onBlockFound` Zeile 289: `const existing = await this.balanceRepo.findOneBy({ address: d.address })` — wieder address-only. Wenn Gruppe B's Block Bob's Pending abrechnet, holt er sich die gesamte Zeile inkl. A's historischer Anteil und verbucht sie auf `totalPaidSats`. Money-Attribution bricht über Gruppenwechsel hinweg.

**Impact:** Money-Math-Bug mit stillem Geldtransfer zwischen Gruppen. Nicht durch Angreifer direkt auslösbar, aber bei jedem Gruppenwechsel einer Adresse, die vorher mal sub-dust/trimmed war, **wird echtes Geld fehlallokiert**.

**Reproducer:** siehe Szenario oben — reine PROP-Logik, keine Angreifer-Interaktion nötig.

**Fix direction:** (a) Lookup immer mit `{ address, groupId }`; (b) Composite-PK `(address, groupId)` auf der Balance-Entity (Schema-Fix + Migration); (c) beim Member-Leave die Balance-Zeile entweder auszahlen oder löschen oder im History-Log abschließen, NICHT stehenlassen.

Minimal-Invasiv:
```ts
// group-solo.service.ts:441
const existing = await this.balanceRepo.findOneBy({ address, groupId });
// und :289
const existing = await this.balanceRepo.findOneBy({ address: d.address, groupId });
```
Dann sind getrennte Zeilen pro `(address, groupId)` möglich, aber die Entity-PK verbietet das aktuell. Daher muss Schema mit.

---

### C4 — Email-Subject-Injection via Gruppenname

**File:** `src/services/email.service.ts:88` und `src/services/email.service.ts:238`

```ts
const subject = `Invitation to join ${ctx.groupName} — Blitz Pool`;
// ...
return shellHtml(`Invitation to join ${ctx.groupName}`, body);
```

Und die Gruppennamen-Validierung in `src/services/group.service.ts:121-124` prüft **ausschließlich Länge** (3–64 Zeichen), nicht ob Newlines/CR/NUL enthalten sind:

```ts
const trimmedName = name?.trim();
if (!trimmedName || trimmedName.length < 3 || trimmedName.length > 64) {
    throw new GroupServiceError('invalid-name', 'Group name must be 3–64 characters');
}
```

`trim()` entfernt nur führende/trailing Whitespace, keine inneren `\r\n`. Nodemailer escaped zwar einiges beim Setzen von Headern, aber in der Praxis ist jedes Feld mit direkter Interpolation in `subject` ein Kandidat für Header-Splitting je nach Nodemailer-Version. Selbst wenn Nodemailer strippt: der HTML- und Text-Body (Z. 206-239, Z. 242-252) nutzt `escapeHtml(ctx.groupName)` im HTML — **aber der Text-Body `src/services/email.service.ts:243` tut das nicht**:

```ts
`You've been invited to join the payout group "${ctx.groupName}" on Blitz Pool.`,
```

Ein Gruppenname `Test"\n\nClick here evil.com for a free Bitcoin\n` landet unescaped im Text-Teil der Mail. Das ist kein HTML-XSS, aber ein Phishing-Vektor — und jeder Multipart-Client der Text rendert sieht den eingeschmuggelten Inhalt.

**Fix direction:** In `createGroup` (Z. 120-146 in group.service.ts) ein Whitelist-Regex oder Ablehnen von Kontrollzeichen:
```ts
if (/[\r\n\0\t]/.test(trimmedName)) {
    throw new GroupServiceError('invalid-name', 'Group name must not contain control characters');
}
```
Plus: Subject-Konstruktion härten — `groupName.replace(/[\r\n]/g, ' ')` als Defence-in-Depth direkt am Sendepunkt.

---

## 2. High-Priority Issues

### H1 — `accept()` prüft `group.dissolvedAt` nicht → Ghost-Member in aufgelöster Gruppe

**File:** `src/services/pplns-group-invitation.service.ts:150-194`

`getByToken` (Z. 140-142) prüft `group.dissolvedAt` und gibt `null` zurück wenn dissolved. `accept` (Z. 150-194) macht **nichts davon**: liest nur die Invitation, prüft Status/Expiry/Member-Collision, ruft dann `addMemberWithoutAdmin(invitation.groupId, invitation.address)`. `addMemberWithoutAdmin` (group.service.ts:170-192) prüft ebenfalls nicht ob die Gruppe noch existiert/dissolved ist.

**Ergebnis:** Admin A erstellt Invitation an Alice → dissolved sofort Gruppe M → Alice klickt Link → `member`-Zeile wird in aufgelöster Gruppe angelegt. `rebuildCache` (Z. 53-68) filtert sie beim Cache-Rebuild zwar wieder raus (`if (active === undefined) continue`), aber die DB-Zeile bleibt. Blocke Shares, Balance-Math, UI — alles inkonsistent.

Nicht direkt Money-Loss, aber Zombie-State der irgendwann jemanden Zeit kostet.

**Fix:** In `accept` vor `addMemberWithoutAdmin`:
```ts
const group = await this.groupService.getGroup(invitation.groupId);
if (!group || group.dissolvedAt) {
    throw new InvitationServiceError('group-dissolved', 'Group no longer exists');
}
```

---

### H2 — Keine Redis-Cleanup bei `dissolveGroup` → Share-State lebt ewig

**File:** `src/services/group.service.ts:347-356` (`dissolveInternal`)

```ts
private async dissolveInternal(groupId: string): Promise<void> {
    await this.memberRepo.delete({ groupId });
    const group = await this.groupRepo.findOneBy({ id: groupId });
    if (group) {
        group.active = false;
        group.dissolvedAt = new Date();
        await this.groupRepo.save(group);
    }
    await this.rebuildCache();
}
```

Weder `groupsolo:{groupId}:shares` noch `:counter`/`:total`/`:rejected-shares` werden gelöscht. Unter `volatile-lru` haben diese Keys keine TTL (korrekt im Normalbetrieb) — aber nach Dissolve werden sie nie mehr angesprochen, nie evictet, belegen Redis-Memory bis Pool-Restart. Bei vielen Lifecycle-Churn (Gruppen kommen+gehen) akkumuliert das.

Schlimmer im Interaktionseffekt mit C3: Falls Gruppe A dissolved, Bob zu Gruppe B wechselt, und zufällig eine neue Gruppe C später mit **derselben** UUID angelegt wird — das kann nicht passieren (UUID-Kollision = unrealistisch), also ist's nur Memory-Leak. Trotzdem sauber wegräumen.

**Fix:** `resetRound(groupId)` in `dissolveInternal` aufrufen; dafür muss `GroupService` entweder `GroupSoloService` injizieren (Zirkel!) oder `dissolveInternal` Redis direkt triggern via Event/Callback.

---

### H3 — Snapshot-Verlust bei Pool-Restart → Coinbase/Payout-Drift

**File:** `src/services/group-solo.service.ts:62-66, 275-282`

```ts
private snapshots = new Map<string, {
    distribution: GroupSoloPayoutEntry[];
    blockRewardSats: number;
    consideredAddresses: Set<string>;
}>();
```

Snapshot ist **in-Memory**. Wenn der Pool zwischen `getPayoutDistribution(groupId, ...)` (das die Coinbase-Bytes erzeugt, die an den Miner gehen) und `onBlockFound` (das die Payouts bucht) restarted, geht der Snapshot verloren. Fallback in Z. 276-279:

```ts
if (!snapshot || snapshot.distribution.length === 0) {
    console.warn(`[GroupSolo] No snapshot for group ${groupId} — using window recalculation fallback`);
    await this.onBlockFoundFromWindow(groupId, blockHeight, blockRewardSats);
    return;
}
```

`onBlockFoundFromWindow` berechnet die Verteilung aus dem **aktuellen** Redis-Fenster — nicht aus dem Fenster-Zustand, den der Miner in seiner Coinbase manifestiert hat. Wenn zwischen Job-Send und Block-Found Shares dazukamen, weicht die DB-Buchung von dem ab, was on-chain ausgezahlt wurde. Die Coinbase-Bytes sind bereits festgelegt und bergmäßig bestätigt, aber `pplns_group_block_history` und `pplns_group_balance` reflektieren eine andere Welt.

Nicht alltagskritisch (Pool-Restart zwischen Job und Block ist selten + Redis überlebt via AOF), aber bei BFT des Pools ein echter Audit-Gap.

**Fix direction:** Snapshot in Redis persistieren (z.B. `groupsolo:{groupId}:snapshot:{blockHeight}` als JSON mit TTL von 1h — hier ist TTL ausnahmsweise sinnvoll, weil der Key keine Geld-State-Summe trägt sondern eine Kopie einer abschließbaren Auction). Oder: Payout-Distribution im Miner-Job embedden und bei Block-Found zurücklesen.

---

### H4 — Keine Foreign-Key-Constraints → Orphaning nicht DB-verhindert

**File:** `src/migrations/1776000000000-AddPplnsGroup.ts` (alles)

Keine `createForeignKey`-Calls. Weder `pplns_group_member.groupId → pplns_group.id`, noch `pplns_group_balance.groupId`, noch `pplns_group_block_history.groupId`. Dissolve verlässt sich auf App-Code (`memberRepo.delete({ groupId })` in `group.service.ts:348`). Balance- und History-Zeilen werden gar nicht gelöscht (siehe C3/H2).

Bei Transaktions-Rollbacks, App-Crashes mitten im Dissolve, oder zukünftigen Bugs wo der Delete übersehen wird → inkonsistente DB. Bitcoin-Pools laufen gern Jahre ohne Rebuild; Schema-Hardening zahlt sich aus.

**Fix:** Neue Migration mit `FOREIGN KEY ... ON DELETE CASCADE` auf `groupId` der drei Child-Tabellen (und `pplns_group_invitation.groupId`).

---

### H5 — Invitation expiry wird nie gesweept (Code existiert, aber wird nicht gefeuert)

**File:** `src/services/pplns-group-invitation.service.ts:283-289` + `src/services/address-email.service.ts`

`expireOld()` existiert als Methode, wird aber nirgendwo per `@Cron` / `@Interval` / im App-Bootstrap aufgerufen. Status `expired` wird nur dann gesetzt, wenn die Invite beim `accept`-Call läuft (Z. 166-170) oder lazy beim nächsten create für dieselbe address/group (Z. 93-97).

Konsequenzen: (a) Admin-Listing `/invitations` filtert zwar clientseitig auf nicht-expired (Z. 268: `r.expiresAt.getTime() >= now`), also UI zeigt's korrekt; (b) aber die `pplns_group_invitation`-Tabelle wächst endlos, mit Token-Werten im Klartext, deren Löschung irgendwann jemand manuell machen müsste; (c) `expiresAt` hat **kein** DB-Index (aus Migration `1776200000000` + Entity-File), also wird ein zukünftiger Bulk-Cleanup full-scan.

**Fix:** Scheduled job via NestJS `@Interval('1h')` auf `PplnsGroupInvitationService.expireOld()` plus `AddressEmailService.purgeExpiredTokens()`. Plus Index auf `expiresAt` (beide Tabellen).

---

## 3. Medium-Priority Issues

### M1 — Balance-Entity PK ist `address`, nicht `(address, groupId)`

**File:** `src/ORM/pplns-group/pplns-group-balance.entity.ts:6-11`

```ts
@PrimaryColumn({ type: 'varchar', length: 62 })
address: string;

@Index()
@Column({ type: 'uuid' })
groupId: string;
```

Dies erzwingt: eine Adresse kann zu jedem Zeitpunkt höchstens **eine** Balance-Zeile haben, unabhängig davon wieviele (vergangene/aktuelle) Group-Memberships sie hat. Das ist die strukturelle Grundlage für C3. Fix ist Teil von C3 (Composite-PK oder explizite Cleanup-Logik beim Member-Wechsel).

### M2 — Decline-DoS ist möglich, aber durch Design akzeptiert

**File:** `src/services/pplns-group-invitation.service.ts:197-214`

Jeder mit dem Token kann declinen (kein `respondedAt`-Check sperrt Re-Accept nach Decline). Kommentar begründet das. Real-world: wenn der Token leakt (Email-Breach des Empfängers, Subpoena-Spear-Phishing), kann Angreifer Invite killen → Re-Invite nötig. Nicht fatal, aber Zubehör. Dokumentieren reicht, solange es eine klare Re-Invite-Procedure gibt.

### M3 — Keine Rate-Limits auf `/invitations` und `/email/register`

Admin mit gültigem Token kann Batch-Invite an beliebige Adressen feuern → SMTP-Provider-Quota-Pain + potenzieller Missbrauch-Vektor wenn Spam-Analyst "Blitz Pool" auf die Blocklist setzt. Fix: NestJS `@Throttle()` auf die POST-Endpoints.

### M4 — Address-Case-Inkonsistenz (Minor in Praxis)

Bech32 (`bc1...`) ist protokoll-spezifiziert lowercase, Miner senden praktisch immer lowercase. Legacy P2PKH/P2SH (`1...`, `3...`) ist case-sensitive Base58. In `group.service.ts:120-137` und Invitation-create (`pplns-group-invitation.service.ts:58-89`) wird die Address ohne Normalisierung übernommen. Wenn ein Admin bewusst `BC1QALICE...` einlädt, würde Mining mit `bc1qalice...` den Cache-Lookup miss'en. Praxis-Risiko gering, aber ein Angreifer könnte im Invitation-Flow eine Adresse mit abweichender Casing hinterlegen und Shares später würden nicht matchen → Payout in unerwünschte Bucket. Ein simples `address = address.toLowerCase()` wenn das Prefix bech32 ist wäre sauber; zumindest bei bech32 Case-insensitive vergleichen.

### M5 — `addMembersBatch` ist noch aktiv und bypassed den Email-Trust-Anchor

**File:** `src/services/group.service.ts:201-251`

Die Memory-Claim war "der alte direct-add wurde entfernt und durch invitations ersetzt". Aber `addMembersBatch` lebt noch in `group.service.ts`. Der Batch-Endpoint ist `/invitations/batch`, nicht `/members/batch` — also der Controller ruft es nicht mehr auf. Trotzdem: die Methode ist **public** auf dem Service. Wenn sie für keinen Use-Case gebraucht wird, **sollte sie weg**. Solange sie da ist, ist jeder zukünftige Code der sie aufruft ein silent-add-Regression.

### M6 — Coinbase-Weight-Budget-Berechnung: `(feeOutputCount + 1)`

**File:** `src/services/group-solo.service.ts:207-211`

```ts
const feeOutputCount = this.feeAddress ? 1 : 0;
const maxMinerOutputs = Math.floor(
    (this.coinbaseWeightBudget - COINBASE_BASE_WEIGHT - (feeOutputCount + 1) * COINBASE_OUTPUT_WEIGHT)
    / COINBASE_OUTPUT_WEIGHT,
);
```

`(feeOutputCount + 1)` reserviert Gewicht für Fee-Output plus vermutlich den Witness-Commitment-Output (OP_RETURN mit commitment hash). Wenn `feeAddress === ''` dann ist `feeOutputCount = 0` und es wird trotzdem `1` Output Gewicht reserviert — korrekt für den Commitment. Wenn aber die tatsächliche Coinbase-Konstruktion zusätzlich noch Outputs hat die hier nicht mitgezählt werden, ist die Reservierung zu klein. Verifikation erfordert cross-check gegen den Coinbase-Builder.

### M7 — Fee-Output wird nicht gegen Dust geprüft

**File:** `src/services/group-solo.service.ts:223-226, 390, 427-435`

Bei kleinen Block-Rewards oder bei sehr kleinem `PPLNS_FEE_PERCENT` auf einem Regtest-Block könnte `feePercent * blockRewardSats / 100 < 546`. Der Fee-Output geht trotzdem in die Coinbase → Block ungültig wegen Dust. Bei Mainnet-Subsidy (3.125 BTC + fees) und 2% Fee nicht akut.

### M8 — `maskEmail` ist dupliziert

**File:** `src/services/pplns-group-invitation.service.ts:310-316` und `src/controllers/pplns-group/pplns-group.controller.ts:489-495`

Identische Implementierung. Klassisches "fix-once, drift-forever"-Muster. In `src/utils/email.utils.ts` ziehen.

---

## 4. Nits

- `pplns_group.adminTokenHash` ist `varchar(255)` (migration Z.14) obwohl SHA-256 immer 64 Hex-Zeichen ist. Cosmetic.
- `InvitationServiceError` Status-Map (`pplns-group.controller.ts:466-478`) — Code `'inconsistent'` aus `pplns-group-invitation.service.ts:161` ist nicht gemapped → fällt auf Default `BAD_REQUEST`, besser wäre `INTERNAL_SERVER_ERROR` mit logging.
- `pplns-group-invitation.service.ts:80-82`: Existing pending + not expired → `'invitation-pending'` throw. Aber Z. 93-97 (expired pending cleanup) läuft nur, falls `pending && expired` — **nie erreichbar**, weil Z. 80 bei `expired=false` throwt und bei `expired=true` kein throw, dann fall-through zu Z. 94. Logik korrekt aber um den Kopf zu verdrehen.
- `group-solo.service.ts:82-85`: `|| DEFAULT_COINBASE_WEIGHT_BUDGET` nach `parseInt` — `parseInt('0')` = 0 → fallback zu default. Intentional?
- UI: `dashboard.component.ts` hashrateWorker-Kill in payout-group-page via Type-Assertion (`this as unknown as { hashrateWorker: Worker | null }`) — funktioniert, aber bricht bei Basis-Klassen-Rename silent. Basis-Klasse mit `protected skipAutoHashrateWorker = false` aufrüsten wäre robuster.

---

## 5. Positive Beobachtungen

- **HTML-Escaping im HTML-Template ist korrekt** — `escapeHtml` (Z. 255-261) und `escapeAttr` (Z. 263-265) werden an allen user-controlled Interpolations eingesetzt: `groupName`, `address`, `inviterAddress`, `verifyUrl`, `inviteUrl`. XSS im HTML-Body ist robust abgesichert.
- **Token-Entropie ist stark** — 32 random bytes (256 bit) via `crypto.randomBytes`, base64url-encoded. Keine Brute-Force-Sorge.
- **Admin-Token-Hashing ist sauber** — SHA-256 (`group.service.ts:76-78`) + `crypto.timingSafeEqual` (Z. 80-84) mit Length-Check davor. Musterhaft.
- **`POST :id/invitations` gibt Token nicht zurück** — korrekt. Der Admin braucht ihn nicht; nur die Mail.
- **Banner leakt Token nicht** — `listPendingForAddress` (Z. 228-256) returned bewusst nur `maskedEmail`, und der Kommentar Z. 219-226 erklärt warum.
- **Live-Lookup der Gruppe pro Share** — `recordShare` (Z. 119-130) und `recordReject` (Z. 138-146) rufen `getGroupForAddress` bei jedem Call, statt auf einen cached groupId zu setzen.
- **Sub-dust vs. Late-Arriver Distinction** — `onBlockFound` (Z. 312-358) macht den richtigen Split zwischen "war zur Snapshot-Zeit da, aber sub-dust" (→ pending) und "kam nach Snapshot" (→ nur Audit). Die 14 Unit-Tests locken das ein.
- **Round-Reset räumt alle 4 Redis-Keys** — `resetRound` (Z. 452-458) inkl. `rejectedShares`.
- **Redis-Share-Keys ohne TTL** — unter `volatile-lru` nicht evictierbar, Geld-State sicher.
- **AOF `everysec`** — Max ~1s Verlust auf Hard-Crash.
- **Dashboard-Banner ohne Click-Through** — nach dem Token-Leak-Fix im commit `2c25a7b` macht die UI genau das richtige: Informations-Banner, kein Link.
- **Invitation-Email-Link geht auf Review-Page, nicht auf direct accept/decline** — Schutz vor unbeabsichtigtem Accept durch Mail-Preview.

---

## Priorisierungs-Empfehlung

1. **Vor Mainnet:** C1 (selfLeave-Auth), C2 (Token aus Admin-Listing), C3 (Balance-Row-Scoping), C4 (Gruppenname-Validierung).
2. **Kurz danach:** H1 (accept-dissolve-Check), H2 (Redis-Cleanup on dissolve), H5 (Expiry-Cron + Index), H4 (FK-Migration).
3. **Im ruhigen Sprint:** H3 (Snapshot-Persistenz), M1-M8.
4. **Docs / Refactor:** Nits.

C1 und C2 sind Einzeiler / wenige Zeilen. C3 ist Schema + 2 Lookups. C4 ist Regex + eine Stripping-Zeile. Alle vier zusammen wären ein Tages-Commit.

Der Rest des Systems ist — und das ist nicht selbstverständlich — sauberer als die vier Critical-Findings vermuten lassen. Die Krypto-Primitive sind richtig gewählt, der Flow denkt mit, die Tests locken das gewünschte Verhalten ein. Die Lücken sind spezifische Stellen, nicht systemische Schwächen.
