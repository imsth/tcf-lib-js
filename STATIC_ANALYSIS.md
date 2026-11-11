# Statische Codeanalyse tcf-lib-js

Stand: 2026-11-11, Commit `f2477e1` (Branch `master`)

## Vorgehen

- ESLint 8.57 mit erweitertem Regelsatz über `src/`, `examples/`, `test/`
  (u. a. `eqeqeq`, `no-shadow`, `no-use-before-define`, `no-throw-literal`, `consistent-return`, `no-loop-func`)
- `npm audit` über die Laufzeit-Abhängigkeiten aus `package.json`
- Manuelles Review aller Module in `src/`
- Einzelne Befunde mit kleinen Node-Snippets (Node 22) nachgestellt, markiert mit *(verifiziert)*

Die Mocha-Tests wurden nicht ausgeführt, da sie einen laufenden TCF-Agenten benötigen.

## Befunde

### Kritisch / hoch

| ID | Ort | Befund |
|----|-----|--------|
| B1 | `src/channel.js:532-549` | **Offene Requests hängen nach Verbindungsabbruch.** `channelClosed()` ruft `splice()` innerhalb von `forEach()` auf, dadurch wird jedes zweite Element übersprungen. Da `onClosed`/`onError` den State vorher auf `Disconnected` setzen, wird immer gespliced. Von 4 offenen Requests werden nur 2 rejected, die anderen Promises bleiben für immer offen. *(verifiziert)* |
| B2 | `src/utils.js:29`, `src/channel.js:148` | **`assert` loggt nur und bricht nicht ab.** Nachrichten > 1 MB (`OBUF_SIZE`) laufen über `obuf` hinaus; `Uint8Array` verwirft Schreibzugriffe außerhalb des Puffers ohne Fehler. Die Nachricht wird abgeschnitten und ohne EOM gesendet, der Protokollstrom ist danach korrupt. Betrifft alle `utils.assert`-Aufrufe im Parser. |
| B3 | `src/channel.js:165-172`, `264-273` | **Kein UTF-8.** `writeStringz` schreibt `charCodeAt()` direkt in ein `Uint8Array` (`€` wird zu `0xAC`), `readStringz` dekodiert byteweise per `fromCharCode` (Latin-1). Umlaute in Pfaden, Symbolnamen usw. werden in beide Richtungen verfälscht. *(verifiziert)* |
| B4 | `src/channel.js:360-394` | **`P`- und `N`-Nachrichten werden wie `R` behandelt.** Der Reply-Handler wird schon beim `P` (Progress) entfernt; das folgende `R` findet keinen Handler mehr, das führt zu `ERR_PROTOCOL` und der Kanal wird geschlossen. `N` (Not supported) resolved den Promise, statt ihn zu rejecten. |
| B5 | `src/channel.js:332,346-358`, `src/protocol.js:81,88` | **Unbekanntes Kommando vom Peer schließt den Kanal.** `this._svc[svc][cmd]` wirft einen `TypeError`. Auch ein rejectender Command-Handler schließt den Kanal, statt eine Fehlerantwort zu senden. Ohne gesetztes Protocol (`proto` ist `undefined`) ebenso. |
| B6 | `src/client.js:204` | **`queryAttrs = true` blockiert den Connect.** `Locator.getAgentID(cb)` wird mit einem Callback aufgerufen, die Proxy-Methoden (`src/services/proxy.js`) liefern aber nur einen Promise und ignorieren den Callback. `onconnect` wird nie aufgerufen. |
| B7 | `src/client.js:148-157` | **`connect()` verschluckt Fehler.** Bei ungültiger URL oder unbekanntem Transport kommt nur `-1` zurück, `onerror` wird nicht aufgerufen. Der Promise von `connectDefered()` bleibt dadurch für immer offen. |
| B8 | `src/client.js:88` | **`off()` ist fehlerhaft.** Mit `if (i)` wird Index 0 nie entfernt, und bei `-1` (Callback nicht gefunden) wird der **letzte** Listener entfernt. Richtig: `if (i >= 0)`. |
| B9 | `src/protocol.js:77` | `addEventHandler` schreibt in `_svc` statt `_ev`. Wenn der Service noch keine Kommandos hat, gibt es einen `TypeError`, sonst wird ein gleichnamiges Kommando überschrieben. |
| B10 | `src/channel.js:128-129,338`, `src/services/proxy.js:64,74` | **Binary-Behandlung falsch.** `btoa(Uint8Array)` kodiert den String `"1,2,3"` statt der Bytes. Eingehende Binary-Argumente von Kommandos werden mit `btoa` statt `atob` behandelt. `atob` liefert einen String, kein `Uint8Array`. |

### Mittel

| ID | Ort | Befund |
|----|-----|--------|
| M1 | `src/channel.js:289-295` | ZeroCopy-Erkennung kann nie greifen: Die Schleife setzt nur `true`, wenn der Wert schon `true` ist; `i == peerServices` vergleicht eine Zahl mit einem Array. |
| M2 | `src/channel.js:431-457` | `updateMessageCount` zählt jedes Byte `0x01`/`0x02` als EOM/EOS, ohne das vorangehende ESC zu prüfen. Bei JSON meist unkritisch, bei Binärdaten fragil. |
| M3 | `src/channel.js:441,479`, `src/client.js:96,152` | Exceptions werden ohne Logging verschluckt. Parse-Fehler schließen den Kanal, ohne dass die Ursache sichtbar wird. |
| M4 | `src/channel.js:418`, `src/services/proxy.js:48` | Exceptions in Event-Listenern der Nutzer führen zu unhandled Promise rejections. |
| M5 | `src/channel.js:505-526` | Jeder eingehende Chunk kopiert den gesamten Restpuffer: O(n²) bei großen, fragmentierten Nachrichten. |
| M6 | `src/service.js` | Wird als `tcf.Service` exportiert, ist aber defekt: `this.broadcast` ist undefiniert (Z. 65), `this.proto.cmd` statt `this.proto[cmd]` (Z. 71), Tippfehler `argSchema` (Z. 80), `handler.call(args)` übergibt `args` als `this` und keine Argumente (Z. 93). |
| M7 | `src/services/caches/symbols_cache.js:94` | Syntaxfehler (fehlende `}`), nutzt das nicht existierende `utils.TcfContextIf` und den falschen Pfad `./utils.js`. Wird nirgends importiert, ist also toter Code. |
| M8 | `src/channel_tcp.js` | `new Buffer()` ist deprecated (Z. 51, 119). `onData(buffer.buffer)` ignoriert `byteOffset`/`byteLength` (unter Node 22 unauffällig, aber nicht garantiert). Der Parameter `options` wird ignoriert, es gibt also kein TLS über TCP. Bei `EADDRINUSE` endlose Rebind-Versuche, andere Server-Fehler werden verschluckt. Server-Sockets rufen bei Fehlern sowohl `onError` als auch `onClosed` auf. |
| M9 | `src/peer.js:36,101` | URL-Parsing per `split(':')`, daher keine IPv6-Adressen. `peerFromUrl` ist toter Code. |
| M10 | `src/channel_server_ws.js:84` | `wsSocket.upgradeReq` existiert nur in `ws` 1.x/2.x. Ein Update von `ws` (siehe D1) bricht diesen Code. Der Parameter `options` wird in Z. 70 überdeckt. |
| M11 | `src/channel_ws.js:73-75` | `onmessage` vor `onopen` würde auf `channel === null` zugreifen. |

### Abhängigkeiten (`npm audit`, nur Laufzeit)

| ID | Paket | Schwere | Befund |
|----|-------|---------|--------|
| D1 | `ws` ^1.1.1 | hoch | DoS durch Speichererschöpfung (GHSA-96hv-2xvq-fx4p). Fix ab 5.2.5, aktuell 8.x. Das ist ein Breaking Change (`upgradeReq`, `handleProtocols`, siehe M10). |
| D2 | `json-bigint` ^0.2.1 | hoch | DoS (GHSA-wgfq-7857-4jcc). Version 0.x hat außerdem eine bekannte Prototype Pollution (behoben in 1.0.0). Relevant, da ungeprüftes JSON vom Peer geparst wird. |
| D3 | `uuid` ^2.0.3 | moderat | Advisory betrifft v3/v5/v6, nicht das genutzte `v4()`. Stark veraltet. |
| D4 | devDependencies | – | `eslint` ^3, `mocha` `*`, `bower`, `chai` ^2, `browserify` ^14 sind veraltet. |

### ESLint-Übersicht (159 Meldungen)

| Regel | Anzahl | Bewertung |
|-------|-------:|-----------|
| `eqeqeq` | 50 | Stil/Robustheit |
| `no-unused-vars` | 38 | Aufräumen |
| `no-use-before-define` | 24 | bei Closures harmlos |
| `no-redeclare` | 17 | `/* global … */`-Kommentare, harmlos |
| `no-throw-literal` | 10 | Strings/Zahlen statt `Error`, dadurch kein Stacktrace |
| `no-shadow` | 9 | Lesbarkeit |
| `consistent-return` | 6 | Lesbarkeit |
| `no-empty` | 2 | siehe M3 |
| `no-loop-func` | 1 | harmlos |
| `no-undef` | 1 | `WebSocket` in `src/browser-ws.js`, nur Browser-Global |
| Parse-Fehler | 1 | siehe M7 |

## Plan

### Phase 1: Stabilität im Normalbetrieb (klein, lokal, hohe Wirkung)

1. **B1:** In `channelClosed()` alle Handler rejecten und danach in einem Schritt leeren (`replyHandlers.length = 0`) bzw. bewusst behalten. Kein `splice` in `forEach`.
2. **B2:** Ausgabepuffer dynamisch vergrößern (z. B. Kapazität verdoppeln und kopieren), wenn `owrite` sich `obuf.length` nähert. `utils.assert` soll werfen statt nur zu loggen; vorher prüfen, ob irgendein Aufrufer auf das Nicht-Werfen angewiesen ist.
3. **B3:** `writeStringz`/`readStringz` auf `TextEncoder`/`TextDecoder` (UTF-8) umstellen. In Node und Browser ohne zusätzliche Abhängigkeit verfügbar.
4. **B8:** `if (i >= 0)` in `Client.off()`.

Für jeden Punkt einen Regressionstest, der ohne C-Agent läuft: Client und Server über die TCP-/WS-Transports dieser Bibliothek, wie in `test/client.js`.

**Status Phase 1 (2026-11-11): erledigt.** B1, B2, B3 und B8 sind behoben, Regressionstests in `test/channel.js` (5 Tests; alle schlagen gegen den alten Code fehl). Abweichung vom Plan: `utils.assert` wirft weiterhin nicht. Ein Werfen würde das Verhalten von `channel.addEventHandler` und `interfaces.addService` bei doppelter Registrierung ändern (bisher nur Log); B2 ist stattdessen durch den wachsenden Ausgabepuffer behoben. Die Entscheidung über `assert` gehört zu Phase 3 (M3).

Hinweis: `test/client.js` läuft unter Node 22 / OpenSSL 3 nicht mehr (`ca md too weak`); die Testzertifikate in `test/certs/` müssen mit SHA-256 neu erzeugt werden. Das ist unabhängig von Phase 1.

### Phase 2: Protokollkonformität

5. **B4:** `P` aktualisiert nur den Progress und behält den Handler; `R` resolved und entfernt ihn; `N` rejected.
6. **B5:** Für unbekannte Services/Kommandos und für Handler-Fehler eine `R`- bzw. `N`-Antwort mit Error-Report senden, statt den Kanal zu schließen. `Protocol.execCommandHandler`/`getCommandArgsParsers` sollen fehlende Einträge sauber behandeln.
7. **B9:** `Protocol.addEventHandler` auf `_ev` korrigieren.
8. **B10, M1:** Binary-Pfad vereinheitlichen: Base64 aus bzw. in `Uint8Array` in einer Hilfsfunktion, konsistent in Channel und Proxy. ZeroCopy-Erkennung korrigieren oder bis zur Implementierung explizit deaktivieren.
9. **M2:** Nachrichtengrenzen nur dann erkennen, wenn ESC davorsteht, auch über Chunk-Grenzen hinweg.

**Status Phase 2 (2026-11-11): erledigt.** B4, B5, B9, B10, M1 und M2 sind behoben, 6 weitere Regressionstests in `test/channel.js` (jetzt 11; alle schlagen gegen den Code vor Phase 1 fehl bzw. hängen). Umsetzung und Abweichungen vom Plan:

- `P` lässt den Reply-Handler bestehen (ruft `rh.progress` auf, falls gesetzt); `N` rejected mit `ERR_INV_COMMAND` (`STD_ERR_BASE + 25`, wie `errors.h` des C-Agenten). `TcfError` wird jetzt aus `channel.js` exportiert.
- Unbekannte Services/Kommandos werden mit `N` beantwortet, der Kanal bleibt offen. **Abweichung:** Wirft oder rejected ein Command-Handler, wird der Kanal weiterhin geschlossen. Das ist der dokumentierte Vertrag von `CmdHandler` (`src/protocol.js`), und eine generische Fehlerantwort passt nicht zur Ergebnis-Signatur beliebiger Kommandos. Eine Änderung wäre ein Breaking Change und gehört in eine eigene Entscheidung.
- `Protocol.addEventHandler` registriert jetzt korrekt, und die Handler werden auch tatsächlich aufgerufen (vorher gab es keinen Dispatch, die Funktion war wirkungslos). Handler, die direkt am Channel registriert sind (Proxies), haben Vorrang.
- Binary-Argumente akzeptieren jetzt Binary-Strings, `Uint8Array`, `Buffer` und `ArrayBuffer` (`utils.toBase64`). **Abweichung:** Binary-Ergebnisse bleiben Binary-Strings (ein Zeichen pro Byte), um bestehende Aufrufer nicht zu brechen. Eine Umstellung auf `Uint8Array` wäre ein Breaking Change.
- ZeroCopy wird genutzt, wenn es lokal aktiviert ist und der Peer es anbietet. Da `writeBinaryDataz` nirgends aufgerufen wird und der Empfang von ZeroCopy nicht implementiert ist, hat das derzeit keine Wirkung.

### Phase 3: Client-API und Fehlertransparenz

10. **B6:** `queryAttrs` auf die Promise-API umstellen (`getAgentID().then(...)`), oder Proxy-Methoden zusätzlich mit optionalem Callback ausstatten.
11. **B7:** In `connect()` bei Fehlern `onerror` aufrufen (asynchron), damit `connectDefered()` rejected.
12. **M3, M4:** Verschluckte Exceptions mindestens loggen bzw. als `error`-Event weitergeben; Listener-Aufrufe in `try/catch` kapseln. `throw "..."` durch `throw new Error(...)` ersetzen.
13. **M5:** Eingangspuffer mit Kapazitätsreserve statt Neuanlage pro Chunk.

**Status Phase 3 (2026-11-11): erledigt.** B6, B7, M3, M4 und M5 sind behoben, 7 weitere Regressionstests in `test/channel.js` (jetzt 18; alle neuen schlagen gegen den Stand nach Phase 2 fehl bzw. hängen). Umsetzung:

- **`assert`-Entscheidung:** Konsistenzprüfungen des Parsers (Daten vom Peer) werfen jetzt einen `Error` mit `code = ERR_PROTOCOL`. `utils.assert` bleibt für API-Fehlbenutzung bei „nur loggen“ (z. B. doppelte Registrierung in `addEventHandler`/`addService`).
- Protokollfehler und werfende Command-Handler werden per `console.error` geloggt, als `onerror` an die Channel-Listener gemeldet (beim Client also `onerror`-Callback und `'error'`-Event), danach wird der Kanal geschlossen. `throw` mit Strings/Zahlen ist in `channel.js`, `protocol.js` und `channel_server_ws.js` durch `Error`-Objekte ersetzt. Abgelehnte Commands liefern weiterhin die numerischen Fehlercodes (API-kompatibel).
- Ein Schreibfehler des Transports schließt den Kanal über `onError`, statt still verworfen zu werden.
- `sendCommand` auf einem geschlossenen Kanal rejected sofort mit `ERR_CHANNEL_CLOSED` (vorher: Promise blieb offen). Nicht serialisierbare Argumente hinterlassen keine halbe Nachricht mehr im Ausgabepuffer (vorher wurde der nächste Command dadurch korrupt). Beide Fehler waren in der Analyse nicht aufgeführt und sind beim Umbau aufgefallen.
- Exceptions in Listenern (Channel-Events, Client-Events, Proxy-Event-Listener, Event-Handler) werden einzeln abgefangen und geloggt; die übrigen Listener laufen weiter, es entstehen keine unhandled rejections mehr.
- `queryAttrs` nutzt die Promise-API der Proxies; schlägt die Abfrage fehl, wird geloggt und trotzdem verbunden. Ohne Locator-Service wird die Abfrage übersprungen.
- `connect()` ruft bei ungültiger URL oder unbekanntem Transport `onerror` asynchron auf und gibt weiterhin `-1` zurück; `connectDefered()` rejected dadurch.
- Eingangspuffer mit Kapazitätsreserve (Start 64 KB, verdoppelt bei Bedarf, schrumpft wieder, wenn alles gelesen ist). Eine 4-MB-Nachricht in 1-KB-Chunks: vorher 3,2 s, jetzt 0,47 s, davon etwa 0,27 s für `JSONbig.parse`.

### Phase 4: Abhängigkeiten und Transports

14. **D1 + M10:** `ws` auf 8.x aktualisieren; `channel_server_ws.js` auf `connection(ws, req)` und die neue `handleProtocols`-Signatur umbauen. Browser-Pfad (`browser-ws.js`) prüfen.
15. **D2:** `json-bigint` auf 1.x aktualisieren, mit `protoAction`/`constructorAction: 'ignore'`; Verhalten von `storeAsString` gegenprüfen.
16. **D3:** `uuid` durch `crypto.randomUUID()` ersetzen.
17. **M8, M9, M11:** `Buffer.from(...)` mit `byteOffset`/`byteLength`; Fehlerbehandlung des TCP-Servers; IPv6-fähiges URL-Parsing; `onmessage` vor `onopen` absichern.

**Status Phase 4 (2026-11-11): erledigt.** D1, D2, D3, M8 (teilweise), M9, M10 und M11 sind behoben. `npm audit --omit=dev` meldet 0 Schwachstellen. 5 weitere Tests in `test/channel.js` (jetzt 23); `test/client.js` und `test/proxy.js` laufen wieder (insgesamt 35 Tests ohne C-Agent). Umsetzung:

- **`ws` 1.x → 8.22:** `channel_server_ws.js` nutzt `connection(ws, req)` und die neue `handleProtocols(Set)`-Signatur und empfängt Daten als `ArrayBuffer`. Die `path`-Option wird nur noch gesetzt, wenn die Server-URL einen eigenen Pfad hat. ws 8 weist sonst alle anderen Pfade ab, und Clients verbinden sich bisher mit beliebigen Pfaden plus Query (`WS::20001/test?arg1=…`, siehe `connectionParams`). WSS bekommt jetzt ebenfalls `handleProtocols`. **Verhaltensänderungen:** Ein Client, der ein anderes Sub-Protokoll als `tcf` verlangt, wird nicht mehr im Handshake mit 401 abgewiesen; ws 8 nimmt die Verbindung ohne Sub-Protokoll an, und der Client bricht sie daraufhin selbst ab. Ein leerer `Sec-WebSocket-Protocol`-Header wird von ws 8 mit 400 abgelehnt (bisher akzeptiert).
- **`json-bigint` 0.2 → 1.0** mit `protoAction`/`constructorAction: 'ignore'`: `__proto__`- und `constructor`-Schlüssel in empfangenem JSON werden verworfen. Große Zahlen kommen weiterhin als Strings (`bigNumAsString`). json-bigint 1.0 erzeugt Objekte ohne Prototyp; ein Reviver in `channel.js` wandelt sie in normale Objekte um, damit `hasOwnProperty`, chai `should` usw. weiter funktionieren.
- **`uuid` entfernt:** `utils.randomUUID()` nutzt `crypto.randomUUID()` (Node) bzw. `crypto.getRandomValues()` im Browser (funktioniert auch außerhalb von Secure Contexts). `"crypto": false` im `browser`-Feld hält `crypto-browserify` aus dem Bundle. Der Browser-Build mit browserify wurde geprüft (261 KB, Smoke-Test mit Fake-`WebSocket` erfolgreich).
- **TCP-Transport:** `Buffer.from(buffer, byteOffset, byteLength)` statt `new Buffer()`; empfangene `Buffer` werden als View übergeben (`Channel.onData` akzeptiert jetzt `ArrayBuffer` und Views). Der Client meldet das Verbindungsende über `'close'` statt `'end'`, damit `onclose` auch nach einem Fehler kommt (wie beim WS-Transport: erst `onerror`, dann `onclose`). `EADDRINUSE` wird weiterhin wiederholt, aber einmal geloggt; andere Server-Fehler kommen als `'error'`-Event am `Server` (ohne Listener: `console.error`, kein Prozessabbruch). Gleiches gilt für den WS-Server. **Nicht umgesetzt:** TLS über TCP (`options` bleibt ungenutzt).
- **IPv6:** Peer-URLs akzeptieren `TCP:[::1]:1534` bzw. `WS:[fe80::1]:8080`; alle bisherigen URL-Formen werden unverändert geparst (per Vergleich alt/neu geprüft). Beim Bau von WS-URLs werden IPv6-Adressen in Klammern gesetzt.
- **Testzertifikate** in `test/certs/` neu erzeugt (SHA-256, 20 Jahre gültig, SAN `localhost`/`127.0.0.1`/`::1`). Die alten waren SHA-1-signiert und abgelaufen, was OpenSSL 3 ablehnt. Der alte CA-Schlüssel war passwortgeschützt (Passwort nicht im Repo), daher gibt es einen neuen CA-Schlüssel ohne Passwort; Server- und Client-Schlüssel sind unverändert.

### Phase 5: Aufräumen und Tooling

18. **M6:** `service.js` reparieren oder, falls ungenutzt, aus der öffentlichen API entfernen (Breaking Change, Versionssprung).
19. **M7:** `symbols_cache.js` löschen oder fertigstellen.
20. ESLint auf eine aktuelle Version mit Flat Config heben, Regeln aus dieser Analyse übernehmen, `/* global */`-Kommentare entfernen, in `npm test` bzw. CI einhängen.
21. devDependencies aktualisieren (`mocha` fest pinnen, `bower`-Postinstall entfernen, falls nicht mehr benötigt).
