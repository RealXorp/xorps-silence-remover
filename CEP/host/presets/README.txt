Place "wav_export.epr" in this folder before building the installer.

How to create it (one-time, ~2 minutes):
1. Open Premiere Pro, File > Export > Media on any sequence.
2. Format: Waveform Audio.
3. Under Audio settings: 48000 Hz, 16-bit, Stereo (or Mono).
4. Click "Save Preset" (disk icon) and name it "Xorp Silence WAV".
5. Premiere stores presets at:
   C:\Users\<you>\AppData\Roaming\Adobe\Premiere Pro\<version>\Profile-<user>\Export Presets\
   Find "Xorp Silence WAV.epr" there and copy it into this folder as wav_export.epr.

This preset only needs to be created once by the developer building the
installer -- end users never see or touch this step.
