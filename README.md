<p align="center"><img src="resources/icon.png" width="120" alt=""></p>

<h1 align="center">Boar</h1>

<p align="center">
  <b>A desktop video editor with a multitrack timeline and AI that runs on your PC.</b><br>
  Classic editing, vertical 9:16, word-by-word captions, text-based editing and Shorts in one click.
</p>

<p align="center">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-3fb950">
  <img alt="Windows, macOS, Linux" src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-0078d4">
  <img alt="GPU Intel, NVIDIA, AMD" src="https://img.shields.io/badge/GPU-Intel%20%7C%20NVIDIA%20%7C%20AMD-555">
  <img alt="Version 0.7.0 alpha" src="https://img.shields.io/badge/version-0.7.0%20alpha-f28c28">
</p>

<p align="center">
  <a href="README.md"><img src="docs/flags/gb.svg" height="14" alt=""> <b>English</b></a> · <a href="README.it.md"><img src="docs/flags/it.svg" height="14" alt=""> Italiano</a>
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Boar: vertical project with blurred background, hook title, karaoke captions and text-based editing">
</p>

> **Alpha.** It is already good for real editing, but it is young: save often and report what goes wrong.

## Why Boar

- **Everything runs locally.** Transcription, face tracking, background removal, object cutouts and noise reduction run on your PC. No account, no subscription, nothing uploaded.
- **No data collection.** No analytics, no usage logs, no telemetry, not even from the libraries inside it: Boar blocks every connection except the downloads you ask for (updates, speech models, yt-dlp). The update check can be turned off in *Options*.
- **Made for today's videos.** Vertical format, animated word-by-word captions, hook titles, zoom on cuts, from a long video to Shorts.
- **Real editing.** Multitrack timeline with events, fades and crossfades, time selection, ripple, keyframes, effects and transitions.
- **Fast on your hardware.** Export with your graphics card's hardware encoder (Intel, NVIDIA or AMD), effects on the GPU. Videos that are slow to seek (screen recordings with keyframes seconds apart, 4K) get a light **proxy** in the background, so scrubbing stays instant; renders always use the original.
- **Your AI agent can edit with you.** If you already use an AI assistant that supports MCP, it can cut, caption and make Shorts inside Boar with your own plan, with no API keys and no extra cost.

## Features

### Editing

- Multitrack timeline: drag media from Project Media or from the Explorer; a clip's video and audio stay grouped.
- Trim from the edges, **fades from the event's top corners** (Fast, Linear, Slow, Smooth and Sharp curves), automatic crossfades by overlapping two events.
- **Time selection**: drag on the ruler to work on a portion: split, delete, trim, play and render just that part.
- **Auto Ripple** (`Ctrl+L`): deleting, cutting or pasting closes the gaps by itself, on the affected tracks or on all of them.
- **Speed**: `Ctrl` + drag an edge to speed up or slow down (0.25x–4x, audio keeps its pitch).
- Split, groups, markers, snapping, frame quantization, context menus and 200 undo levels.
- **Full screen preview** (`F`): review the edit without distractions, with a seek bar and markers on the fly (`M`).
- **Command search** (`Ctrl+F`): type what you need ("export", "subtitles", "blur") to find and run any menu command, option, panel, effect or title.

### Vertical and social

- 16:9, **9:16** or 1:1 project in one click, with the apps' safe areas in the preview.
- **Auto Reframe**: finds the face and moves the framing to follow it, smoothly.
- **Layouts**: blurred background (no black bars when 16:9 footage goes vertical), top/bottom split screen, picture in picture.
- **Auto Zoom**: alternating zoom on every cut, a quick punch-in on the strongest moments of the voice, or a slow push-in.
- **From a long video to Shorts** (*Shorts* tab): Boar suggests the moments that work on their own, and *Make Short* builds the vertical video with cuts, framing, captions and a hook title. One click takes you back to the long video to make the next one.

### Captions and text

- **Automatic word-by-word captions** with Whisper, locally: karaoke, box on the spoken word, words popping in, one word at a time, classic subtitles.
- **Text-based editing** (*Transcript* tab): speech becomes text; select words, press `Delete` and the video is cut. One button selects ums, uhs and repeated words; another shortens long pauses.
- Highlighted keywords (`*word*` in the text, or automatic) and emoji on matching words.
- 21 text presets, including a hook title at the top and a progress bar; more than 30 bundled fonts; in and out animations.
- Handles right in the preview to move, scale and rotate text, images and video (drag just outside a corner to rotate, Shift for 15° steps).

### Audio

- **Even loudness**: exports are normalized to −14 LUFS (or −16, −23), with a peak limiter.
- **AI noise reduction**, locally; noise gate, 10-band equalizer, compressor, reverb, echo, pitch and more.
- **Remove Silences** (jump cuts): the pauses to cut show in red on the timeline while you adjust. **Auto Ducking**: the music goes down when someone speaks.
- Mixer with volume, pan, mute and solo per track, master meters.

### Effects, transitions, export

- 24 GPU video effects: ready-made color looks, color correction, chroma key, blur, glow, vignette, grain, VHS, glitch and more. AI **background removal**, no green screen needed.
- Transitions: zoom, whip pan, spin, glitch, flash, dip to black, blur, pixelate.
- Masks: ellipse, rectangle or a custom shape drawn with points and animated with keyframes. **Smart Select** cuts out an object with a click (more clicks add or leave out parts) and *Track Motion* follows it through the clip.
- Event Pan/Crop with keyframes.
- **Render As** MP4 (H.264, HEVC, AV1, VP9): you choose who encodes, the graphics card (NVENC, Quick Sync, AMF, VideoToolbox) or the processor, and the audio (AAC or Opus). Preview and export use the same engine: what you see is what you export.

## Installation

### Windows

1. Download `Boar-Setup-x.y.z.exe` from the [Releases](https://github.com/MatteoFilosa/boar/releases) page and run it.
2. The installer is not signed yet: if Windows SmartScreen shows "Windows protected your PC", click *More info › Run anyway*.

### macOS (experimental)

1. Download `Boar-x.y.z-arm64.dmg` (Apple Silicon) or `Boar-x.y.z-x64.dmg` (Intel) from the [Releases](https://github.com/MatteoFilosa/boar/releases) page, open it and drag Boar into Applications.
2. Boar is not signed with an Apple Developer ID, so macOS blocks the first launch: open *System Settings › Privacy & Security* and click *Open Anyway*. Or, in Terminal: `xattr -dr com.apple.quarantine /Applications/Boar.app`.

### Linux (experimental)

- **Debian, Ubuntu and derivatives**: download `Boar-x.y.z-amd64.deb` and install it with `sudo apt install ./Boar-x.y.z-amd64.deb`.
- **Any distribution**: download `Boar-x.y.z-x86_64.AppImage`, make it executable (`chmod +x`) and run it. On Ubuntu 24.04 and later a system restriction can stop AppImages of this kind from starting: use the .deb there.

### Updates

Boar looks for a new release when it starts and offers to install it: on Windows and with the AppImage it updates itself and starts again; on macOS and with the .deb it downloads the new file for you to install. *Help › Check for Updates* checks at any time, *Options › Check for Updates at Startup* turns the startup check off.

### Captions and Transcript

Speech recognition ([whisper.cpp](https://github.com/ggml-org/whisper.cpp)) is built into Boar: nothing else to install. The first time, the app downloads the Whisper model you pick (148 MB for the lightest one).

### From source

You need [Node.js](https://nodejs.org/) 22 or later.

```bash
git clone https://github.com/MatteoFilosa/boar.git
cd boar
npm install
npm run whisper
npm run dev
```

`npm run whisper` puts the speech engine for your system into `resources/whisper`, taken from the latest CI build (it needs the [GitHub CLI](https://cli.github.com/), logged in). Without it, `bash scripts/build-whisper.sh` builds the engine (CMake, a C++ compiler and, on Windows and Linux, the Vulkan SDK). `npm run dist` builds the installer in `dist/`.

## Graphics cards

Boar works with **Intel, NVIDIA and AMD** GPUs: no code is tied to one vendor.

| What | How |
| --- | --- |
| Export | WebCodecs: the graphics card's encoder (NVENC on NVIDIA, Quick Sync on Intel, AMF on AMD, VideoToolbox on Mac) or the software one on the processor, as you choose in *Render As*, which marks for each format what your machine can do. HEVC and AV1 on the card depend on its generation; on Linux export often runs on the processor, slower. |
| Preview and effects | WebGL2, the same on every recent GPU. |
| Face, background and Smart Select (AI) | MediaPipe on the GPU, falling back to the CPU. |
| Transcription | whisper.cpp built into Boar: on the GPU through Vulkan (Windows, Linux) or Metal (macOS), otherwise on the CPU. |
| Noise reduction | On the CPU, identical everywhere. |

Up-to-date graphics drivers make everything work better, especially the hardware encoder.

## AI agents (MCP)

AI assistants and agents that support MCP (desktop apps, coding agents, AI editors) can use Boar with your subscription: Boar asks for no API key and costs nothing extra.

1. In Boar, turn on *Options › AI Agents (MCP)*. The server only listens on this PC and is protected by a token.
2. Copy the configuration that fits your agent: URL with header, command (JSON) or TOML.
3. Ask, for example, "remove the filler words and add captions", or use the ready-made prompts *make_shorts*, *clean_up_talking_head* and *youtube_chapters*.

The agent reads the timeline and the transcripts, looks at frames and makes the edits: each one can be undone with `Ctrl+Z`, and the window shows everything it did. Video and audio stay on your PC.

## Themes

*Options › Themes* switches between **Dark**, **Light**, **Galaxy** and **Ember**, and loads themes made by anyone. A theme is a small JSON file: every key in `colors` is one color of the interface (any CSS color, `rgba()` included), and the ones you leave out come from `base`. A see-through color lets the `backdrop` gradient show behind the panels.

```json
{
  "boarTheme": 1,
  "name": "Sunset",
  "author": "Your name",
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

The quickest way to make one: pick the theme closest to what you want, press *Export Theme* (the file lists every color with its name), change what you like and load it with *Load Theme File* or by dropping it on the window. Theme files are plain data: they cannot load images, fonts or anything from the internet. An AI agent connected through MCP can also make one for you with the `set_theme` tool.

## Optional features

**Download from Link (yt-dlp).** Off by default: turn it on in *Options*. It downloads video or audio from the sites supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp), which is not included in Boar and is downloaded on first use. The window stays open beside the timeline: *Download and Add to Timeline* puts the file at the cursor, or drag it from the window. Video and sound come as separate streams from most sites and Boar joins them itself, so FFmpeg is not needed. Only download content you have the right to use: the terms of many sites forbid downloading.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` / `Enter` | play and pause (*Options* can make Space return to the start) |
| `F` / `F11` | full screen preview (`Esc` to leave) |
| `S` | split at the cursor or at the edges of the time selection |
| `Delete` / `Shift+Delete` | delete / delete and close the gap |
| `Ctrl+T` | keep only the time selection |
| `Ctrl+L` | Auto Ripple |
| `Ctrl` + drag an edge | change speed |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copy / cut / paste (images from the clipboard too) |
| `Ctrl+S` / `Ctrl+O` | save / open project (`.boar`; double-clicking a project file or dropping it on Boar opens it too) |
| `Ctrl+M` | Render As |
| `Ctrl+F` | search commands, options and effects |
| `Ctrl+R` / `Ctrl+Shift+R` | rotate the selected video, image or text 90° clockwise / counterclockwise |
| `M`, `G` / `U`, `F8`, `Q` | marker, group / ungroup, snapping, loop |
| `←` `→` / `↑` `↓` | previous and next frame / zoom |
| `Esc` | clear the time selection |
| `F1` | all the shortcuts |

On a Mac, use ⌘ instead of Ctrl and ⌥ instead of Alt. `F1` (or the keyboard button in the toolbar) opens the full list on a keyboard map: hold Ctrl, Shift or Alt to see what they do with each key, and press any shortcut to see its name while it works. The window can stay open while you edit.

## For developers

| Command | What it does |
| --- | --- |
| `npm run dev` | app with hot reload |
| `npm run dev:web` | interface only, in the browser (http://localhost:5180) |
| `npm run samples` | generates test media in `dev-samples/` (needs FFmpeg) |
| `npm run whisper` | downloads the speech engine for your system from the latest CI build |
| `npm run typecheck` | TypeScript check |
| `npm run smoke` | build and hidden run: errors, hardware encoders, media protocol |
| `npm run icons` | regenerates the icons from `resources/icon.svg` |
| `npm run dist` | installer for your system in `dist/` (GitHub Actions builds all three for each release) |

Stack: Electron, React, TypeScript, zustand and immer, [Mediabunny](https://github.com/Vanilagy/mediabunny) for decoding, encoding and MP4 with WebCodecs.

- `src/main`: main process (window, files, `boar-media://` protocol, transcription, MCP server)
- `src/renderer/src/core`: project model, undoable actions, text, Pan/Crop, transcripts
- `src/renderer/src/engine`: compositor shared by preview and export, effects, audio, analysis
- `src/renderer/src/ui`: interface and canvas timeline
- `src/renderer/src/agent`: tools and prompts for AI agents

Time is an integer number of *flicks* (1/705,600,000 of a second): every common frame rate, NTSC included, lands on exact values.

## License

[MIT](LICENSE) © Matteo Filosa. The Boar name and logo are not covered by the license. Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
