---
name: tts
description: "Text-to-speech using macOS built-in `say` command. Generate spoken audio from text with voice selection, speed control, and file output."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔊",
        "requires": null,
        "install": null,
      },
  }
---

# Text-to-Speech (macOS)

Convert text to speech using the built-in `say` command. No dependencies required.

## Quick Start

```bash
say "Hello world"                          # Speak text
say -v Samantha "Hello world"              # Use specific voice
say -o ~/output.aiff "Hello world"         # Save to file
```

## Commands

### Speak Text

```bash
say "Text to speak"
say -v Yuna "안녕하세요"                    # Korean voice
say -v Samantha "Hello"                     # English voice (female)
say -v Daniel "Hello"                       # English voice (male)
say -r 200 "Fast speech"                    # Speed (words per minute, default: ~175)
say -r 100 "Slow speech"
```

### Save to File

```bash
say -o ~/output.aiff "Hello world"                           # AIFF format
say -o ~/output.aiff --data-format=LEF32@22050 "Hello"       # WAV-like format
```

### Convert to MP3/WAV (with ffmpeg)

```bash
say -o /tmp/speech.aiff "Hello world"
ffmpeg -i /tmp/speech.aiff ~/speech.mp3    # Requires: brew install ffmpeg
ffmpeg -i /tmp/speech.aiff ~/speech.wav
```

### List Available Voices

```bash
say -v '?'                                 # List all voices
say -v '?' | grep en_                      # English voices only
say -v '?' | grep ko_                      # Korean voices only
```

### Read from File

```bash
say -f ~/document.txt                      # Read file contents
cat ~/document.txt | say                   # Pipe to say
```

## Common Voice Selections

| Language     | Voice    | Example                     |
| ------------ | -------- | --------------------------- |
| English (US) | Samantha | `say -v Samantha "Hello"`   |
| English (US) | Alex     | `say -v Alex "Hello"`       |
| English (UK) | Daniel   | `say -v Daniel "Hello"`     |
| Korean       | Yuna     | `say -v Yuna "안녕하세요"`  |
| Japanese     | Kyoko    | `say -v Kyoko "こんにちは"` |

## Advanced: External TTS (Optional)

For higher quality or more voices, install sherpa-onnx:

```bash
brew install sherpa-onnx
sherpa-onnx-offline-tts \
  --vits-model=model.onnx \
  --vits-tokens=tokens.txt \
  --output-filename=output.wav \
  "Text to speak"
```

## Notes

- `say` is macOS-only (pre-installed, no setup needed).
- Default voice depends on system language settings.
- Audio plays through system speakers by default.
- Use `-o` flag to save without playing.
- For Telegram delivery, convert to OGG: `ffmpeg -i speech.aiff -c:a libopus speech.ogg`
