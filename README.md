# JVoice

Hold a shortcut, talk, let go. JVoice turns your speech into text and types it wherever your cursor is, in any Windows app.

- Speech to text with ElevenLabs Scribe v2, through your OpenRouter key.
- Optional AI cleanup through any OpenRouter chat model (default DeepSeek V4.1 Flash): removes um and uh, applies "no wait" corrections, adds punctuation. Or pick Rewrite, and the AI rewrites what you said into clear, polished text.
- One key for everything: you only need an OpenRouter key.

## Use it

1. Start JVoice and paste your OpenRouter key (`sk-or-...`). Get one at https://openrouter.ai/settings/keys.
2. Click into any text field, hold **Ctrl + Win**, speak, and let go.
3. The text is pasted where your cursor is. Press **Esc** while recording to cancel.

JVoice runs in the tray. Closing the window keeps it running; quit from the tray icon.

### Settings

- **Shortcut**: any combo of two or more keys, or a single F13 to F24 key. Hold to talk, or press to start and stop.
- **Microphone**: pick an input device and test the level.
- **Speech to text**: Scribe v2 or Scribe v2 Medical, auto language or a fixed one.
- **AI cleanup**: on or off, Light cleanup or Rewrite, optional extra instructions, and the model (any OpenRouter chat model).
- **Output**: type into the active app, or copy only. Keep my clipboard puts back what you had copied, including files and images.
- **Dictionary**: words JVoice should always spell your way, and what the speech engine writes instead.
- **History**: every dictation, the raw transcript, and Retry for recordings that failed to transcribe.

### Speed test

Open **Speed test**, pick a length (30 seconds up to 1 hour, a custom length up to 3 hours, or no limit), press **Start test** and talk. JVoice shows your words per minute and characters per minute while you talk, and the final result when the time is up or you press Stop.

- The speech model (Scribe) writes down what you say. JVoice then counts the words and characters itself. No chat AI is used.
- Characters are letters and numbers. Spaces and punctuation are not counted, since you do not say them.
- The rates use the whole test time, pauses included.
- Results are saved on this computer, with your best marked.

### Safety

- If you switch windows while JVoice is working, or still hold keys when it is ready, the text is copied instead of pasted, so it never lands in the wrong place.
- The key is encrypted with your Windows account (DPAPI). Settings, history, the dictionary and speed test results live in a SQLite file in `%APPDATA%\JVoice`.
- Audio is only kept for dictations that failed, so you can retry them. Deleting the history entry deletes the audio.

## Develop

```
npm install
npm start          # run the app
npm test           # unit tests
npm run smoke      # hidden self-check: database, keyboard hook, Win32, pages
npm run dist       # build the Windows installer into dist/
```

Test modes (no window is shown):

- `electron . --transcribe file.wav` runs the full pipeline on a 16 kHz mono WAV with the saved key and prints the result.
- `electron . --speed-test file.wav <length> <stopAfterMs> <dir>` runs the Speed test page offscreen with the WAV as the microphone and the saved key, prints the result, screenshots each stage into `<dir>`, then deletes the saved result. Length is 30, 60, ... 3600, 0 for no limit, or `custom2` for 2 minutes. A stopAfterMs above 0 presses Stop after that long.
- `electron . --shots <dir>` renders every page and overlay state offscreen to PNGs.
- `JVOICE_USER_DATA=<dir>` uses a separate data folder.

Built with Electron, `uiohook-napi` for the global shortcut, `koffi` for Win32 calls, and `node:sqlite`.
