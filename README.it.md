<p align="center"><img src="resources/icon.png" width="120" alt=""></p>

<h1 align="center">Boar</h1>

<p align="center">
  <b>Editor video desktop con timeline multitraccia e AI che gira sul tuo PC.</b><br>
  Montaggio classico, verticale 9:16, sottotitoli parola per parola, montaggio dal testo e Shorts in un clic.
</p>

<p align="center">
  <img alt="Licenza MIT" src="https://img.shields.io/badge/licenza-MIT-3fb950">
  <img alt="Windows, macOS, Linux" src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-0078d4">
  <img alt="GPU Intel, NVIDIA, AMD" src="https://img.shields.io/badge/GPU-Intel%20%7C%20NVIDIA%20%7C%20AMD-555">
  <img alt="Versione 0.8.3 alpha" src="https://img.shields.io/badge/versione-0.8.3%20alpha-f28c28">
</p>

<p align="center">
  <a href="README.md"><img src="docs/flags/gb.svg" height="14" alt=""> English</a> · <a href="README.it.md"><img src="docs/flags/it.svg" height="14" alt=""> <b>Italiano</b></a>
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Boar: progetto verticale con sfondo sfocato, titolo d'aggancio, sottotitoli karaoke e montaggio dal testo">
</p>

> **Alpha.** Si usa già per montare davvero, ma è giovane: salva spesso e segnala quello che non va (*Help › Report a Problem*).

## Perché Boar

- **Tutto in locale.** Trascrizione, riconoscimento del volto, rimozione dello sfondo, scontorno degli oggetti e riduzione del rumore girano sul tuo PC. Niente account, niente abbonamenti, niente caricato online.
- **Nessuna raccolta di dati.** Niente statistiche, log d'uso o telemetria, nemmeno dalle librerie che usa: Boar blocca ogni connessione tranne i download che chiedi tu (aggiornamenti, modelli vocali, yt-dlp). Il controllo degli aggiornamenti si spegne in *Options*.
- **Pensato per i video di oggi.** Formato verticale, sottotitoli animati parola per parola, titoli d'aggancio, zoom sui tagli, dal video lungo agli Shorts.
- **Montaggio vero.** Timeline multitraccia con eventi, fade e dissolvenze, selezione temporale, ripple, keyframe, effetti e transizioni.
- **Veloce sul tuo hardware.** Export con l'encoder hardware della scheda video (Intel, NVIDIA o AMD), effetti sulla GPU. I video lenti da scorrere (registrazioni dello schermo con keyframe distanti secondi, 4K) ricevono in background un **proxy** leggero, così l'anteprima resta istantanea; il render usa sempre l'originale.
- **Il tuo agente AI può montare con te.** Se usi già un assistente AI compatibile con MCP, può tagliare, sottotitolare e fare Shorts dentro Boar con il tuo piano, senza chiavi o costi in più.

## Funzioni

### Montaggio

- Timeline multitraccia: trascina i media da Project Media o da Esplora file; video e audio di una clip restano raggruppati. Trascinando vicino al bordo sinistro o destro la timeline scorre; trascinando una clip sotto l'ultima traccia se ne crea una nuova per lei. Le immagini trascinate da una pagina web restano nel progetto; le GIF animate (e le WebP/PNG animate) si muovono sulla timeline, in loop. La rotella fa zoom attorno al cursore; `Ctrl+Shift++` / `Ctrl+Shift+-` rendono tutte le tracce più alte o più basse.
- Trim dai bordi, **fade dagli angoli** dell'evento (curve Fast, Linear, Slow, Smooth, Sharp), crossfade automatico sovrapponendo due eventi.
- **Selezione temporale**: trascina sul righello per lavorare su una porzione: split, elimina, trim, play e render solo di quella parte.
- **Auto Ripple** (`Ctrl+L`): eliminando, tagliando o incollando i buchi si chiudono da soli, sulle tracce interessate o su tutte; spostando un evento o trascinandone un bordo si sposta anche quello che viene dopo.
- **Velocità**: `Ctrl` + trascina un bordo per accelerare o rallentare (0.25x–4x, l'audio mantiene l'intonazione).
- **Reverse** (clic destro su una clip, o *Tools › Reverse*): la clip va al contrario, video e audio, nello stesso punto. La prima volta Boar ne crea una copia invertita sul tuo PC e la tiene con i tuoi media, così dopo è immediato; un secondo Reverse la riporta in avanti.
- **Paste Event Attributes** (`Ctrl+Shift+V`): copi un evento e dai il suo aspetto a quelli selezionati: Video e Audio FX, Pan/Crop, maschera, livello o volume e stile del testo. *Selectively Paste Event Attributes* ti fa scegliere cosa.
- **Strumento di selezione** (toolbar o `Ctrl+D`): trascina un rettangolo tratteggiato ovunque, anche sopra gli eventi, per selezionarne tanti insieme senza spostarli (`Shift` aggiunge, `Ctrl` alterna).
- Split, gruppi, marker, snapping, quantizzazione ai frame, menu contestuali e 200 livelli di annulla.
- **Salvataggio automatico**: finché ci sono modifiche non salvate Boar tiene una copia del progetto sul tuo PC. Se si chiude senza salvare (un crash, la corrente che salta), al successivo avvio ti propone di recuperarle.
- **Anteprima a schermo intero** (`F`): rivedi il montaggio senza distrazioni, con barra di avanzamento e marker al volo (`M`).
- **Ricerca comandi** (`Ctrl+F`): scrivi quello che ti serve ("export", "subtitles", "blur") per trovare e lanciare qualsiasi comando dei menu, opzione, pannello, effetto o titolo.
- Quando finisce un lavoro lungo (render, sottotitoli, download, Reverse...) il cinghiale della barra taglia il traguardo e lancia i coriandoli. *Options › Celebrate Finished Tasks* lo spegne.

### Verticale e social

- Progetto 16:9, **9:16** o 1:1 con un clic, safe area delle app nell'anteprima.
- **Auto Reframe**: trova il volto e muove l'inquadratura per seguirlo, con un movimento morbido.
- **Layout**: sfondo sfocato (niente bande nere con il 16:9 in verticale), schermo diviso sopra/sotto, riquadro nell'angolo.
- **Auto Zoom**: zoom alternato a ogni taglio, zoom rapido sui momenti più forti della voce o lento avvicinamento.
- **Da video lungo a Shorts** (tab *Shorts*): Boar propone i momenti che funzionano da soli e *Make Short* crea il video verticale con taglio, inquadratura, sottotitoli e titolo d'aggancio. Un clic e torni al video lungo per fare il prossimo.

### Sottotitoli e testo

- **Sottotitoli automatici parola per parola** con Whisper, in locale: karaoke, box sulla parola, parole che compaiono, una parola alla volta, sottotitoli classici. Per tutta la timeline (anche una clip tagliata in tanti pezzi), per le clip selezionate o per la selezione temporale. I sottotitoli seguono il montaggio: se poi tagli, accorci, sposti o elimini le clip, si spostano, si accorciano o spariscono con le loro parole (*Options › Captions Follow Clip Edits*).
- **Montaggio dal testo** (tab *Transcript*): il parlato diventa testo; selezioni le parole, premi `Canc` e il video si taglia. Un pulsante seleziona ehm, uhm e parole ripetute; un altro accorcia le pause lunghe.
- Parole chiave evidenziate (`*parola*` nel testo, o in automatico) ed emoji sulle parole a tema.
- 21 preset di testo, tra cui titolo d'aggancio in alto e progress bar; oltre 30 font inclusi; animazioni di entrata e uscita.
- **Forme per indicare le cose** (scheda *Generators* o menu *Insert*): rettangolo, ellisse e freccia, rosse di partenza, con contorno, riempimento, angoli arrotondati, ombra e un'animazione che le disegna sullo schermo. Si ridimensionano liberamente da ogni lato o angolo; la freccia si punta trascinandone le estremità. *Solid Color* riempie il fotogramma di un solo colore.
- Maniglie direttamente nell'anteprima per spostare, scalare, stirare e ruotare testi, immagini e video (le maniglie sui lati di un'immagine la stirano in una direzione, `Ctrl`+trascina un angolo la stira liberamente; per ruotare trascina appena fuori da un angolo, Shift per scatti di 15°).

### Audio

- **Volume uniforme**: l'export è normalizzato a −14 LUFS (o −16, −23), con limiter sui picchi.
- **Riduzione del rumore con AI** in locale, noise gate, equalizzatore a 10 bande, compressore, riverbero, eco, pitch e altri effetti.
- **Rimozione silenzi** (jump cut): le pause da tagliare compaiono in rosso sulla timeline mentre regoli. **Auto Ducking**: la musica si abbassa quando qualcuno parla.
- Mixer con volume, pan, mute e solo per traccia, meter master.

### Effetti, transizioni, export

- 25 effetti video sulla GPU: look colore pronti, luminosità e contrasto, correzione colore, chroma key, sfocatura, glow, vignettatura, grana, VHS, glitch e altri. **Rimozione dello sfondo** con AI, senza green screen.
- **Chroma key con contagocce**: clicchi nell'anteprima il colore da togliere, un green o blue screen o uno sfondo bianco o nero. *Background only* lo toglie solo attorno al soggetto, così un logo bianco su un prodotto fotografato sul bianco resta.
- Transizioni: zoom, whip pan, spin, glitch, flash, dissolvenza al nero, blur, pixel. Trascinale sull'inizio o sulla fine di una clip, o dove due clip si sovrappongono: tutta la sovrapposizione diventa la transizione e il suo nome compare sulla timeline. Clic sul nome per cambiarne tipo o durata.
- Maschere: ellisse, rettangolo o forma custom disegnata a punti e animata con i keyframe, tutto in una finestra sopra l'immagine: un'ellisse o un rettangolo si sistemano trascinando le maniglie, oppure scrivendo posizione e dimensioni in pixel. La forma fa parte dell'immagine: spostandola con Pan/Crop la parte mascherata si sposta con lei. **Smart Select** scontorna un oggetto con un clic (altri clic aggiungono o tolgono parti) e *Track Motion* lo segue per tutta la clip.
- Event Pan/Crop con keyframe: sulla barra dei keyframe clic, `Ctrl`+clic o `Shift`+clic per selezionarli, trascina per spostarli, `Canc` per eliminarli, `Ctrl+C` / `Ctrl+V` per copiarli al cursore o in un altro evento. Le frecce spostano il riquadro (o, nell'anteprima, l'immagine cliccata) di un pixel, dieci con `Shift`; `Shift`+trascina lo sposta lentamente.
- **Render As** in MP4 (H.264, HEVC, AV1, VP9): scegli chi codifica, la scheda video (NVENC, Quick Sync, AMF, VideoToolbox) o il processore, e l'audio (AAC o Opus). L'anteprima e l'export usano lo stesso motore: quello che vedi è quello che esporti.
- Render **solo audio** in MP3, WAV, FLAC, M4A (AAC) o OGG (Opus): tutto il mix o una sola traccia audio, con gli stessi livelli di loudness dei video.
- Render in **GIF animata**: dimensione, frame rate e colori a scelta, in loop; con una selezione temporale diventa un breve loop di qualsiasi momento.

## Installazione

### Windows

1. Scarica `Boar-Setup-x.y.z.exe` dalla pagina [Releases](https://github.com/MatteoFilosa/boar/releases) e avvialo.
2. L'installer non è ancora firmato: se Windows SmartScreen mostra "PC protetto", clicca *Ulteriori informazioni › Esegui comunque*.

### macOS (sperimentale)

1. Scarica `Boar-x.y.z-arm64.dmg` (Apple Silicon) o `Boar-x.y.z-x64.dmg` (Intel) dalla pagina [Releases](https://github.com/MatteoFilosa/boar/releases), aprilo e trascina Boar in Applicazioni.
2. Boar non è firmato con un Apple Developer ID, quindi macOS blocca il primo avvio: apri *Impostazioni di Sistema › Privacy e sicurezza* e clicca *Apri comunque*. Oppure, nel Terminale: `xattr -dr com.apple.quarantine /Applications/Boar.app`.

### Linux (sperimentale)

- **Debian, Ubuntu e derivate**: scarica `Boar-x.y.z-amd64.deb` e installalo con `sudo apt install ./Boar-x.y.z-amd64.deb`.
- **Qualsiasi distribuzione**: scarica `Boar-x.y.z-x86_64.AppImage`, rendilo eseguibile (`chmod +x`) e avvialo. Su Ubuntu 24.04 e successivi una restrizione di sistema può impedire l'avvio di AppImage di questo tipo: lì usa il .deb.

### Aggiornamenti

All'avvio Boar controlla se c'è una nuova versione e propone di installarla: su Windows e con l'AppImage si aggiorna da solo e riparte; su macOS e con il .deb scarica il nuovo file da installare. *Help › Check for Updates* controlla quando vuoi, *Options › Check for Updates at Startup* disattiva il controllo all'avvio.

### Problemi e idee

*Help › Report a Problem* mostra i dettagli che servono a una segnalazione (versione di Boar, sistema, scheda video e i suoi encoder) da copiare, e apre la pagina delle segnalazioni di Boar su GitHub. Boar non invia niente da solo.

### Sottotitoli e Transcript

Il riconoscimento vocale ([whisper.cpp](https://github.com/ggml-org/whisper.cpp)) è integrato in Boar: non serve installare nient'altro. La prima volta l'app scarica il modello Whisper che scegli (148 MB per il più leggero).

### Dai sorgenti

Serve [Node.js](https://nodejs.org/) 22 o più recente.

```bash
git clone https://github.com/MatteoFilosa/boar.git
cd boar
npm install
npm run whisper
npm run dev
```

`npm run whisper` mette in `resources/whisper` il motore vocale per il tuo sistema, preso dall'ultima build della CI (serve la [GitHub CLI](https://cli.github.com/) con login). In alternativa `bash scripts/build-whisper.sh` lo compila (CMake, un compilatore C++ e, su Windows e Linux, il Vulkan SDK). `npm run dist` crea l'installer in `dist/`.

## Schede video

Boar funziona con GPU **Intel, NVIDIA e AMD**: non c'è codice legato a un produttore.

| Cosa | Come |
| --- | --- |
| Export | WebCodecs: l'encoder della scheda video (NVENC su NVIDIA, Quick Sync su Intel, AMF su AMD, VideoToolbox su Mac) o quello software sul processore, come scegli in *Render As*, che indica per ogni formato cosa sa fare la tua macchina. HEVC e AV1 sulla scheda dipendono dalla sua generazione; su Linux spesso l'export usa il processore, più lento. |
| Anteprima ed effetti | WebGL2, uguale su tutte le GPU recenti. |
| Volto, sfondo e Smart Select (AI) | MediaPipe sulla GPU, con ripiego sul processore. |
| Trascrizione | whisper.cpp integrato in Boar: sulla GPU con Vulkan (Windows, Linux) o Metal (macOS), altrimenti sul processore. |
| Riduzione del rumore | Sul processore, identica ovunque. |

Con driver video aggiornati va tutto meglio, soprattutto per l'encoder hardware.

## Agenti AI (MCP)

Gli assistenti e gli agenti AI compatibili con MCP (app desktop, agenti di coding, editor AI) possono usare Boar con il tuo abbonamento: Boar non chiede chiavi API e non costa nulla in più.

1. In Boar attiva *Options › AI Agents (MCP)*. Il server ascolta solo su questo PC ed è protetto da un token.
2. App desktop di assistenti che installano i bundle MCP (anche con i piani gratuiti): premi *Install Boar.mcpb* e conferma nell'assistente. Altri agenti: copia la configurazione adatta, URL con header, comando (JSON) o TOML.
3. Chiedi, per esempio: "togli gli intercalari e aggiungi i sottotitoli", oppure usa i prompt pronti *edit_in_boar*, *make_shorts*, *clean_up_talking_head*, *voiceover_with_broll* e *youtube_chapters*.

Serve l'app dell'assistente: gli strumenti sul tuo PC non funzionano da una pagina web. Se una chat nuova risponde che non conosce Boar, ha cercato gli strumenti prima che fossero caricati: rimanda il messaggio, oppure parti dal prompt *edit_in_boar*. Gli agenti avviati prima di Boar vedono comunque i suoi strumenti, e se Boar è chiuso il primo strumento usato lo apre (copie installate).

L'agente legge la timeline e le trascrizioni, guarda i frame e fa le modifiche: taglia e riordina il parlato, aggiunge sottotitoli, effetti e titoli, muove e zooma dentro l'inquadratura con i keyframe di Pan/Crop, manda le clip al contrario, e mette sulla timeline immagini, video ed effetti sonori della tua libreria (sopra chi parla con un effetto pop, o a tutto schermo). Per un voiceover sopra registrazioni lunghe può sfogliare file non ancora importati (fotogrammi sparsi lungo il file, durate), trasformare ore di registrazione dello schermo in pochi secondi di timelapse, fermare un fotogramma per spiegarlo, mettere in risalto un dettaglio o cerchiarlo con un riquadro o una freccia, e tenere la webcam in un angolo sopra le immagini. Ogni modifica si annulla con `Ctrl+Z` e la finestra mostra tutto quello che ha fatto. Può anche fare il render del risultato (video, GIF o solo audio): Boar ti chiede dove salvarlo. Video e audio restano sul tuo PC.

## Temi

*Options › Themes* passa tra **Dark**, **Light**, **Galaxy** ed **Ember** e carica temi fatti da chiunque. Un tema è un piccolo file JSON: ogni chiave di `colors` è un colore dell'interfaccia (qualsiasi colore CSS, anche `rgba()`), e quelli che ometti vengono da `base`. Un colore trasparente lascia vedere il gradiente di `backdrop` dietro i pannelli.

```json
{
  "boarTheme": 1,
  "name": "Sunset",
  "author": "Il tuo nome",
  "base": "dark",
  "colors": {
    "accent": "#ff6a3d",
    "bg": "#1a1418",
    "panel": "#241c21",
    "timeline-bg": "#1c1619",
    "track-a": "#2a2026",
    "track-b": "#251c21"
  },
  "backdrop": { "gradient": "linear-gradient(160deg, #1a1418, #3a1f2b)", "stars": false }
}
```

Il modo più veloce per crearne uno: scegli il tema più vicino a quello che vuoi, premi *Export Theme* (il file elenca tutti i colori con il loro nome), cambia quello che ti piace e caricalo con *Load Theme File* o trascinandolo sulla finestra. I file dei temi sono solo dati: non possono caricare immagini, font o altro da internet. Anche un agente AI collegato via MCP può crearne uno per te con il tool `set_theme`.

## Cosa Boar non è

Boar resta piccolo per restare veloce, stabile e gratuito da portare avanti. Queste cose non sono in programma:

- Strumenti di finitura da cinema: color grading con scope e pipeline colore, compositing a nodi, 3D.
- Montaggio multicamera, sequenze annidate, più timeline nello stesso progetto.
- Account, sincronizzazione cloud, render online, AI con chiavi API a pagamento (gli agenti AI usano il tuo piano, via MCP).
- Plugin fatti per altri programmi.

Le idee che rendono più veloce il montaggio di tutti i giorni di video parlati, Shorts e sottotitoli sono le benvenute: apri una *Idea* nella pagina delle segnalazioni.

## Funzioni opzionali

**Download da link (yt-dlp).** Spento di default: si attiva da *Options*. Scarica video o audio dai siti supportati da [yt-dlp](https://github.com/yt-dlp/yt-dlp), che non è incluso in Boar e viene scaricato al primo uso. La finestra resta aperta accanto alla timeline: *Download and Add to Timeline* mette il file al cursore, oppure lo trascini dalla finestra. Dalla maggior parte dei siti video e audio arrivano separati e Boar li unisce da solo, quindi FFmpeg non serve. Scarica solo contenuti che hai il diritto di usare: i termini di molti siti vietano il download.

## Scorciatoie

| Tasto | Azione |
| --- | --- |
| `Spazio` / `Invio` | play e pausa (in *Options* Spazio può tornare al punto di partenza) |
| `F` / `F11` | anteprima a schermo intero (`Esc` per uscire) |
| `S` | split al cursore o ai bordi della selezione temporale |
| `Canc` / `Shift+Canc` | elimina / elimina e chiudi il buco |
| `Ctrl+T` | tieni solo la selezione temporale |
| `Ctrl+L` | Auto Ripple |
| `Ctrl` + trascina un bordo | cambia velocità |
| `Ctrl+Z` / `Ctrl+Y` | annulla / ripeti |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copia / taglia / incolla (anche immagini dagli appunti) |
| `Ctrl+Shift+V` | incolla gli attributi dell'evento copiato (FX, Pan/Crop, maschera, livello, stile del testo) sugli eventi selezionati |
| `Ctrl+D` | passa dallo strumento normale a quello di selezione e viceversa |
| `Ctrl+S` / `Ctrl+O` | salva / apri progetto (`.boar`; si apre anche con un doppio clic sul file o trascinandolo su Boar; *File › Open Recent* elenca gli ultimi dieci) |
| `Ctrl+M` | Render As |
| `Ctrl+F` | cerca comandi, opzioni ed effetti |
| `Ctrl+R` / `Ctrl+Shift+R` | ruota video, immagine o testo selezionato di 90° in senso orario / antiorario |
| `M`, `G` / `U`, `F8`, `Q` | marker, raggruppa / separa, snapping, loop |
| `←` `→` / `↑` `↓` | frame precedente e successivo (5 secondi indietro o avanti durante la riproduzione) / zoom |
| `Shift+←` `Shift+→` | un secondo indietro / avanti |
| `Ctrl+Shift++` / `Ctrl+Shift+-` | tracce più alte / più basse |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | interfaccia più grande / più piccola / normale (anche nel menu *View*) |
| `Esc` | togli la selezione temporale |
| `F1` | tutte le scorciatoie |

Su Mac usa ⌘ al posto di Ctrl e ⌥ al posto di Alt. `F1` (o il pulsante con la tastiera nella toolbar) apre l'elenco completo su una mappa della tastiera: tieni premuto Ctrl, Shift o Alt per vedere cosa fanno con ogni tasto, e premi una scorciatoia qualsiasi per vederne il nome mentre funziona. La finestra può restare aperta mentre monti.

## Per sviluppatori

| Comando | Cosa fa |
| --- | --- |
| `npm run dev` | app con hot reload |
| `npm run dev:web` | solo interfaccia nel browser (http://localhost:5180) |
| `npm run samples` | genera media di prova in `dev-samples/` (serve FFmpeg) |
| `npm run whisper` | scarica il motore vocale per il tuo sistema dall'ultima build della CI |
| `npm run typecheck` | controllo TypeScript |
| `npm test` | test della logica di montaggio (`test/`) |
| `npm run smoke` | build e avvio nascosto: errori, encoder hardware, protocollo media e un controllo del render (un progetto generato, renderizzato e confrontato con come deve apparire e suonare) |
| `npm run icons` | rigenera le icone da `resources/icon.svg` |
| `npm run dist` | installer per il tuo sistema in `dist/` (GitHub Actions crea i tre installer a ogni release) |

Stack: Electron, React, TypeScript, zustand e immer, [Mediabunny](https://github.com/Vanilagy/mediabunny) per decodifica, codifica e MP4 con WebCodecs.

- `src/main`: processo principale (finestra, file, protocollo `boar-media://`, trascrizione, server MCP)
- `src/renderer/src/core`: modello del progetto, azioni con annulla, testo, Pan/Crop, trascrizioni
- `src/renderer/src/engine`: compositor condiviso da anteprima ed export, effetti, audio, analisi
- `src/renderer/src/ui`: interfaccia e timeline su canvas
- `src/renderer/src/agent`: strumenti e prompt per gli agenti AI

Il tempo è un intero in *flicks* (1/705.600.000 di secondo): tutti i frame rate comuni, NTSC compresi, cadono su valori esatti.

## Licenza

[MIT](LICENSE) © Matteo Filosa. Il nome Boar e il logo non sono coperti dalla licenza. Componenti di terze parti: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
