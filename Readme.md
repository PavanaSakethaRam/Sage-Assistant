# Sage Assistant

This branch contains the retired Windows voice assistant prototype. The desktop rewrite is in development. Its README describes the current local notes workflow, development setup, and platform limits. [Desktop rewrite README](https://github.com/PavanaSakethaRam/Sage-Assistant/blob/codex/sage-foundation/Readme.md) · [Draft pull request](https://github.com/PavanaSakethaRam/Sage-Assistant/pull/1)

## What the prototype does

- Listens for the `computer` wake word, then records a five-second clip for Whisper to transcribe.
- Uses keyword rules to open a few Windows apps, read a short excerpt from Notepad, or capture the screen and extract text with OCR.
- Includes an experimental Chrome messaging path with a fixed recipient search and message. Running it can attempt a real send from a signed-in browser. The voice path prints transcribed commands.

## Browse the source

```sh
git clone https://github.com/PavanaSakethaRam/Sage-Assistant.git
cd Sage-Assistant
```

The original entry point is [main.py](main.py). The prototype targeted Windows and Python 3.10. Its historical dependencies are listed in [requirements.txt](requirements.txt).
