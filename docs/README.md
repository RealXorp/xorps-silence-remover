# Xorp's Silence Remover

Automatic silence detection and ripple-removal for Adobe Premiere Pro (Windows).

## Quick start (end user)

1. Download `XorpsSilenceRemover_Setup.exe`.
2. Run it (no admin rights required; it installs to your user profile).
3. Open (or restart) Premiere Pro.
4. Go to **Window > Extensions > Xorp's Silence Remover**. The panel opens inside Premiere.
5. Open a sequence, adjust the threshold/duration/padding sliders, click
   **Analyze Silence**, review the preview, then **Apply Cuts**.

That's it. No command line, no scripting, no separate audio tools.

## What it does

- Detects silent gaps in your sequence's audio using loudness (dBFS) analysis,
  not just "is there a clip here", so it works on raw dialogue tracks.
- Lets you tune:
  - **Silence threshold** (dB): how quiet counts as "silence"
  - **Minimum silence length** (ms): ignore short natural pauses
  - **Padding** (ms): keep a little breathing room around each cut so
    words aren't clipped
- Shows a waveform and color-coded preview (aquamarine = kept speech,
  coral = cut) before touching your timeline.
- Applies cuts as razor and ripple-delete across every audio track (and
  mirrors the same cuts on video tracks to keep picture in sync).
- **Undo:** the panel's own **Undo button does not work yet** (it only tells
  you to press Ctrl+Z). To reverse cuts, use Premiere's native undo with
  **Ctrl+Z**. Because this is a destructive edit, duplicate your sequence
  first if you want a guaranteed safety net.
- Batch mode: run the same settings across every sequence in the project.
- Export a plain-text cut log (in/out timecodes for every cut).
- Runs 100% locally. No audio or project data ever leaves your machine.

## Known limitations (please read)

- **Windows and Premiere Pro only** (this build). Adobe's CEP framework
  differs enough on macOS/other apps that this isn't a drop-in port.
- **Unsigned extension**: Adobe requires CEP panels to either be signed
  with a paid Adobe developer certificate, or run with a "debug mode"
  registry flag. The installer sets that flag automatically, so you won't
  see any dialogs about it, but it does mean this is a "developer/side-
  loaded" install rather than one distributed through Adobe's Exchange
  marketplace.
- Analysis quality depends on your dialogue being reasonably separated
  from music/effects on its own track(s), like any silence-based tool
  (this mirrors how Descript/Auto-Cut style tools work too).

## Support / updating

- To update, just run the new `Setup.exe`. It overwrites the extension
  files in place; your settings/preferences are kept per-project (stored
  in the Premiere project itself, not in the extension).
- To uninstall, use **Add or Remove Programs > Xorp's Silence Remover**, or the
  Start Menu shortcut.
