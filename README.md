# Xorp's Silence Remover

Automatic silence detection and ripple-removal for Adobe Premiere Pro (Windows).

A CEP panel that analyzes a sequence's audio, finds silent gaps by **loudness (dBFS) threshold**, previews every cut on a color-coded waveform, then **razors and ripple-deletes** them across all audio tracks, mirroring the cuts on video so picture stays in sync. It's the tedious dead-air pass of any talking-head, podcast, or course edit, done in seconds instead of an afternoon.

## ⚠️ Important: the Undo button does not work

The panel's **Undo button is not functional yet**. It only shows a message telling you to press **Ctrl+Z**. This is a **destructive edit**, so before you run it:

- Make sure Premiere's own **Ctrl+Z** can undo the cut, or
- **Duplicate your sequence first** so you always have the original.

Don't rely on the in-panel Undo button to save your project.

## Features

- **Loudness-based detection.** Finds silence by dBFS, not just clip boundaries, so it works on raw dialogue tracks.
- **Tunable.** Silence threshold (dB), minimum silence length (ms), and padding (ms) so it never clips breaths or wanted pauses.
- **Preview before you cut.** Color-coded waveform (aquamarine = kept speech, coral = cut) before touching your timeline.
- **Ripple across all tracks.** Razor and ripple-delete across every audio track, mirrored on video to keep sync.
- **Batch mode.** Run the same settings across every sequence in the project.
- **Cut log.** Export in/out timecodes for every cut.
- **100% local.** No audio or project data ever leaves your machine.

## Install

1. Download `XorpsSilenceRemover_Setup.exe` from the [latest release](../../releases/latest).
2. Run it (no admin rights required; installs to your user profile).
3. Open or restart Premiere Pro, then go to **Window → Extensions → Xorp's Silence Remover**.

See [`docs/INSTALL.md`](docs/INSTALL.md) for details and troubleshooting.

## Requirements

- Windows and Adobe Premiere Pro (2024–2026)
- Dialogue reasonably separated onto its own audio track(s) for best results

## Notes

This is a side-loaded (unsigned) CEP extension; the installer sets Adobe's `PlayerDebugMode` flag automatically. See [`docs/README.md`](docs/README.md) for the full rundown and known limitations.
