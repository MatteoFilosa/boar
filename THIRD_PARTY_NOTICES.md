# Third-party notices

Boar bundles or downloads the following components. Each keeps its own license.

## Bundled in the app

| Component | License | Use |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) (with Chromium and Node.js) | MIT (Chromium: BSD-style and others, see `LICENSES.chromium.html` next to the app) | Desktop runtime |
| [React](https://react.dev/), React DOM | MIT | User interface |
| [Zustand](https://github.com/pmndrs/zustand) | MIT | State |
| [Immer](https://github.com/immerjs/immer) | MIT | Undo history |
| [Lucide](https://lucide.dev/) (lucide-react) | ISC | Icons |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) | MPL-2.0 (unmodified; source at the link) | Media decoding, encoding and MP4 muxing |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and its models (BlazeFace short range, Selfie Segmenter, MagicTouch) | Apache-2.0 | Face detection (Auto Reframe, Auto Zoom), background removal, Smart Select masks |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with [ggml](https://github.com/ggml-org/ggml) | MIT | Speech recognition (captions, Transcript) |
| [Silero VAD](https://github.com/snakers4/silero-vad) (whisper.cpp format, from [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad)) | MIT | Finds the parts with speech before transcribing |
| [web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor) | MIT; includes RNNoise (BSD-3-Clause), SpeexDSP (BSD-3-Clause) and [GTCRN](https://github.com/Xiaobin-Rong/gtcrn) (MIT) | Noise reduction |
| Fonts via [Fontsource](https://fontsource.org/): Caveat, Dancing Script, Fredoka, Inter, League Spartan, Montserrat, Nunito, Oswald, Outfit, Playfair Display, Rubik, Sora, Space Grotesk, TikTok Sans, Tilt Neon, Unbounded, Abril Fatface, Anton, Archivo Black, Bangers, Barlow Condensed, Bebas Neue, Bungee, Courier Prime, DM Serif Display, Instrument Serif, Lilita One, Lobster, Monoton, Pacifico, Poppins, Press Start 2P, Righteous, Shrikhand | SIL Open Font License 1.1 | Text and captions |
| Fonts via Fontsource: Luckiest Guy, Permanent Marker, Special Elite, Yellowtail | Apache-2.0 | Text and captions |

## Downloaded on request, not bundled

| Component | License | When |
| --- | --- | --- |
| Whisper models in whisper.cpp format (`ggml-*.bin`, from Hugging Face) | MIT | When the user downloads a speech model (captions, Transcript tab) |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | When the user installs it for Download from Link |

## Development only

[FFmpeg](https://ffmpeg.org/) generates the test media of `npm run samples`; the app does not use it.
