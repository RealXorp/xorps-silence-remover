# Installation Guide

## For end users

1. Download `XorpsSilenceRemover_Setup.exe`.
2. Double-click to run it. No admin password is required (it installs into
   your Windows user profile, not Program Files' protected areas).
3. Click through the installer (Next > Next > Install).
4. When it finishes, a confirmation dialog explains the next step:
   open Premiere Pro and go to **Window > Extensions > Xorp's Silence Remover**.
5. If Premiere Pro was already open, restart it once so it picks up the
   new extension and the registry change that lets it load.

The panel then behaves like any other Premiere panel: you can dock it,
float it, or close and reopen it from the Extensions menu.

## Where files get installed

| What | Where |
|---|---|
| CEP extension (panel UI + scripts) | `%APPDATA%\Adobe\CEP\extensions\XorpsSilenceRemover` |
| Documentation | `%LOCALAPPDATA%\Programs\Xorp's Silence Remover\docs` (or chosen install dir) |
| Debug-mode flag | `HKCU\Software\Adobe\CSXS.9` … `CSXS.12` → `PlayerDebugMode = 1` |

Nothing is written to `C:\Program Files\Adobe\...`. Premiere Pro itself is
never modified, only its per-user extensions folder is added to.

## Updating

Run the newer `XorpsSilenceRemover_Setup.exe`. Inno Setup detects the existing
install, overwrites the extension files, and leaves your Premiere projects
untouched. Restart Premiere Pro afterward.

## Uninstalling

Windows **Settings > Apps > Installed apps > Xorp's Silence Remover > Uninstall**,
or the Start Menu shortcut "Uninstall Xorp's Silence Remover". This removes the
extension folder and the debug-mode registry keys it added.

## Troubleshooting

- **Panel doesn't show up in the Extensions menu**: fully quit Premiere
  Pro (check Task Manager, since it sometimes lingers) and reopen it.
- **Panel shows up but looks blank/blocked**: your Premiere Pro version
  may be older than what the manifest declares. Check `CSXS/manifest.xml`
  → `<Host Name="PPRO" Version="[...]"/>` covers your version; widen the
  range if needed and re-run the extension copy step.
- **"Not running inside Premiere Pro" error**: the panel was opened in a
  regular browser rather than the Premiere Extensions panel. This
  extension only works loaded inside Premiere Pro.
