/*
 * Xorp's Silence Remover — ExtendScript host layer.
 *
 * Runs inside Premiere Pro's ExtendScript engine. All functions take a
 * single JSON-encoded string argument and RETURN a JSON-encoded string
 * (CEP's evalScript bridge only passes strings), so every function here
 * follows that convention.
 *
 * NOTE ON THE QE DOM:
 * Frame-accurate razor + ripple-delete is not exposed in Premiere's public
 * "app.project" DOM. Every shipping silence-remover panel (this one
 * included) uses Adobe's "QE DOM" (Quality Engineering DOM) — an
 * undocumented but stable API Adobe itself has shipped inside Premiere
 * for years, enabled via app.enableQE(). It exposes track.razor(time) and
 * clip.remove(ripple, mediaShift). This is the same mechanism used by
 * Adobe's own testing team and by most third-party edit-automation tools.
 */

// Ticks are Premiere's internal time unit: 254,016,000,000 ticks per second.
var TICKS_PER_SECOND = 254016000000;

function msToTicksString(ms) {
  var ticks = Math.round((ms / 1000) * TICKS_PER_SECOND);
  return ticks.toString();
}

function safeReturn(obj) {
  return JSON.stringify(obj);
}
function safeError(e) {
  return JSON.stringify({ error: (e && e.message) ? e.message : String(e) });
}

function getActiveSequence() {
  var seq = app.project.activeSequence;
  if (!seq) throw new Error("No active sequence open in Premiere Pro.");
  return seq;
}

// ---------------------------------------------------------------------
// xsr_getSequenceInfo — basic info for the panel header
// ---------------------------------------------------------------------
function xsr_getSequenceInfo(argJson) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return safeReturn({ name: null });
    return safeReturn({ name: seq.name });
  } catch (e) {
    return safeError(e);
  }
}

// ---------------------------------------------------------------------
// xsr_listSequences — for batch processing
// ---------------------------------------------------------------------
function xsr_listSequences(argJson) {
  try {
    var list = [];
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      var s = seqs[i];
      list.push({ id: s.sequenceID, name: s.name });
    }
    return safeReturn({ sequences: list });
  } catch (e) {
    return safeError(e);
  }
}

// ---------------------------------------------------------------------
// xsr_exportSequenceAudio — bounce the sequence's audio to a temp WAV so
// the panel's JS side can analyze real sample data (loudness in dB).
// Requires a bundled export preset: host/presets/wav_export.epr
// (48kHz/16-bit PCM WAV, audio only). See docs/BUILD.md for how to
// generate this preset once from Media Encoder's export UI.
// ---------------------------------------------------------------------
// exportAsMediaDirect() is known to silently do nothing on Windows when
// given forward-slash paths instead of native backslash paths -- no
// exception, no file, it just never renders. Build a native-separator
// copy of any path right before handing it to that call.
function toNativePath(p) {
  if ($.os && $.os.indexOf("Windows") !== -1) {
    return String(p).replace(/\//g, "\\");
  }
  return p;
}

function debugLog(msg) {
  try {
    var logFile = new File(Folder.temp.fsName + "/xsr_debug.log");
    logFile.open("a");
    var d = new Date();
    var stamp = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    logFile.writeln("[" + stamp + "] " + msg);
    logFile.close();
  } catch (e) { /* logging must never break the real flow */ }
}

function pad2(n) {
  n = String(n);
  return n.length < 2 ? "0" + n : n;
}

function xsr_exportSequenceAudio(argJson) {
  try {
    var args = JSON.parse(argJson);
    var seq = args.sequenceId
      ? findSequenceById(args.sequenceId)
      : getActiveSequence();

    var tempFolder = Folder.temp.fsName.replace(/\\/g, "/");
    var outPath = tempFolder + "/xsr_" + seq.sequenceID + "_" + Date.now() + ".wav";

    // args.extensionRoot (from csInterface.getSystemPath("extension")) is the
    // authoritative source, but if it's ever missing/empty (older panel
    // build, a call site that forgot to send it, etc.) fall back to
    // deriving the path from this script's own location instead of
    // crashing on undefined.
    var rootRaw = args.extensionRoot || getExtensionRoot();
    var extensionRoot = normalizeExtensionRoot(rootRaw);
    var presetPath = extensionRoot + "/host/presets/wav_export.epr";
    var presetFile = new File(presetPath);
    if (!presetFile.exists) {
      throw new Error(
        "Missing export preset. Looked for it at: " + presetPath + ". " +
        "See docs/BUILD.md 'Creating the WAV export preset'."
      );
    }

    // ---- Analysis SCOPE ---------------------------------------------------
    // workAreaType per Premiere's API: 0 = entire sequence, 1 = between the
    // sequence in/out points, 2 = work area. We only use 0 and 1.
    // Whatever range we export, the WAV's sample 0 corresponds to some tick
    // position in the sequence — `offsetTicks`. Every detected silence time
    // is relative to the WAV, so applyOneCut must add offsetTicks to land
    // the razor at the right place on the real timeline.
    var scope = args.scope || "entire"; // "entire" | "inout" | "selected"
    var WORK_AREA_ENTIRE = 0, WORK_AREA_IN_OUT = 1;
    var workAreaType = WORK_AREA_ENTIRE;
    var offsetTicks = Number(seq.zeroPoint) || 0;
    var rangeStartSec, rangeEndSec; // for durationMs of the exported range

    // Remember original in/out so we can restore them if we override them.
    var savedInSec = null, savedOutSec = null, overrodeInOut = false;

    if (scope === "inout") {
      workAreaType = WORK_AREA_IN_OUT;
      rangeStartSec = Number(seq.getInPoint());
      rangeEndSec = Number(seq.getOutPoint());
      if (!(rangeEndSec > rangeStartSec)) {
        throw new Error("No in/out range is set on the sequence. Set In and Out points (I / O) first, or pick a different scope.");
      }
      offsetTicks = Math.round(rangeStartSec * TICKS_PER_SECOND);
    } else if (scope === "selected") {
      var sel = seq.getSelection();
      // getSelection() returns a plain Array (.length) on current Premiere,
      // but a TrackItemCollection (.numItems) on older builds — support both.
      var selCount = 0;
      if (sel) {
        selCount = (sel.numItems !== undefined && sel.numItems !== null)
          ? sel.numItems
          : (sel.length || 0);
      }
      if (!selCount) {
        throw new Error("No clips are selected. Select one or more clips on the timeline, or pick a different scope.");
      }
      var minStartTicks = null, maxEndTicks = null, minStartSec = null, maxEndSec = null;
      for (var si = 0; si < selCount; si++) {
        var it = sel[si];
        var sT = Number(it.start.ticks), eT = Number(it.end.ticks);
        var sS = Number(it.start.seconds), eS = Number(it.end.seconds);
        if (minStartTicks === null || sT < minStartTicks) { minStartTicks = sT; minStartSec = sS; }
        if (maxEndTicks === null || eT > maxEndTicks) { maxEndTicks = eT; maxEndSec = eS; }
      }
      // Drive the export via in/out points set to the selection's span.
      savedInSec = Number(seq.getInPoint());
      savedOutSec = Number(seq.getOutPoint());
      seq.setInPoint(minStartSec);
      seq.setOutPoint(maxEndSec);
      overrodeInOut = true;
      workAreaType = WORK_AREA_IN_OUT;
      offsetTicks = minStartTicks;
      rangeStartSec = minStartSec;
      rangeEndSec = maxEndSec;
    }

    // ---- Track ISOLATION --------------------------------------------------
    // If the panel asked to analyze only specific audio tracks, mute every
    // OTHER audio track for the duration of the export (the mixdown then
    // contains only the requested tracks), then restore mute states.
    var analyzeTracks = args.analyzeTracks; // array of audio-track indices, or null/empty = all
    var savedMutes = null;
    var numAudio = seq.audioTracks ? seq.audioTracks.numTracks : 0;
    if (analyzeTracks && analyzeTracks.length && analyzeTracks.length < numAudio) {
      savedMutes = [];
      for (var ai = 0; ai < numAudio; ai++) {
        var tr = seq.audioTracks[ai];
        savedMutes.push(tr.isMuted());
        var keep = false;
        for (var qi = 0; qi < analyzeTracks.length; qi++) {
          if (Number(analyzeTracks[qi]) === ai) { keep = true; break; }
        }
        tr.setMute(keep ? 0 : 1);
      }
    }

    var nativeOutPath = toNativePath(outPath);
    var nativePresetPath = toNativePath(presetPath);
    debugLog("os=" + $.os + " scope=" + scope + " workAreaType=" + workAreaType +
      " offsetTicks=" + offsetTicks + " outPath=" + nativeOutPath + " presetPath=" + nativePresetPath);

    try {
      seq.exportAsMediaDirect(nativeOutPath, nativePresetPath, workAreaType);
      debugLog("exportAsMediaDirect() call returned, beginning poll");

      // exportAsMediaDirect() returns immediately — it does NOT block until
      // the file is finished writing. Poll until the file exists and its
      // size has stopped growing for a couple of checks in a row, rather
      // than trying to read it right away (which causes an ENOENT race).
      var EXPORT_TIMEOUT_MS = 5 * 60 * 1000; // generous, for long podcasts/timelines
      var exportOk = waitForExportedFile(outPath, EXPORT_TIMEOUT_MS);
      debugLog("poll finished, exportOk=" + exportOk);
      if (!exportOk) {
        throw new Error(
          "Timed out waiting for the exported WAV file to appear at " + outPath +
          ". This can happen on very long sequences, or if the bundled preset " +
          "isn't a valid uncompressed WAV (Waveform Audio) preset — see " +
          "docs/BUILD.md 'Creating the WAV export preset'."
        );
      }
    } catch (eExport) {
      // ExtendScript's parser rejects a bare try/finally with no catch, so we
      // catch-and-rethrow: the outer handler turns it into a JSON error, and
      // the finally below still restores the sequence either way.
      throw eExport;
    } finally {
      // Always restore track mute states and any in/out points we changed,
      // even if the export threw, so we never leave the user's sequence in a
      // modified state.
      if (savedMutes) {
        for (var ri = 0; ri < numAudio; ri++) {
          try { seq.audioTracks[ri].setMute(savedMutes[ri] ? 1 : 0); } catch (eM) {}
        }
      }
      if (overrodeInOut) {
        try { seq.setInPoint(savedInSec); seq.setOutPoint(savedOutSec); } catch (eIO) {}
      }
    }

    // Duration of the EXPORTED range (drives the preview timeline mapping).
    var durationMs;
    if (scope === "entire") {
      durationMs = ((seq.end - offsetTicks) / TICKS_PER_SECOND) * 1000;
    } else {
      durationMs = (rangeEndSec - rangeStartSec) * 1000;
    }

    return safeReturn({
      wavPath: outPath,
      sequenceFps: seq.getSettings().videoFrameRate ? seq.getSettings().videoFrameRate.seconds : 30,
      sequenceName: seq.name,
      durationMs: durationMs,
      offsetTicks: offsetTicks
    });
  } catch (e) {
    return safeError(e);
  }
}

// Poll for the exported file to (a) exist and (b) stop growing in size,
// since exportAsMediaDirect() hands off encoding asynchronously and
// returns before the file is fully written to disk.
function waitForExportedFile(path, timeoutMs) {
  var f = new File(path);
  var start = new Date().getTime();
  var lastSize = -1;
  var stableChecks = 0;
  var REQUIRED_STABLE_CHECKS = 2;
  var POLL_INTERVAL_MS = 250;

  while ((new Date().getTime() - start) < timeoutMs) {
    if (f.exists) {
      var size = 0;
      try {
        f.open("r");
        size = f.length;
        f.close();
      } catch (e) {
        size = -1; // file may be locked mid-write; treat as "not stable yet"
      }
      if (size > 0 && size === lastSize) {
        stableChecks++;
        if (stableChecks >= REQUIRED_STABLE_CHECKS) return true;
      } else {
        stableChecks = 0;
      }
      lastSize = size;
    }
    $.sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function findSequenceById(id) {
  var seqs = app.project.sequences;
  for (var i = 0; i < seqs.numSequences; i++) {
    if (seqs[i].sequenceID === id) return seqs[i];
  }
  throw new Error("Sequence not found: " + id);
}

function getExtensionRoot() {
  // host.jsx lives in <extension>/host/host.jsx
  var f = new File($.fileName);
  return f.parent.parent.fsName.replace(/\\/g, "/");
}

// csInterface.getSystemPath("extension") returns a "file:///C:/..." style
// URI, not a plain Windows path. Convert it (and gracefully handle a plain
// path too, in case getExtensionRoot()'s fallback value is passed in).
function normalizeExtensionRoot(raw) {
  var p = String(raw);
  if (p.indexOf("file:///") === 0) {
    p = p.substring(8); // strip "file:///"
  } else if (p.indexOf("file://") === 0) {
    p = p.substring(7); // strip "file://"
  }
  try { p = decodeURIComponent(p); } catch (e) { /* already decoded */ }
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------
// xsr_applyCuts — razor at each silence boundary and ripple-delete the
// silent gap, across all (or the selected) audio tracks, and mirror the
// same cuts on video tracks so picture stays in sync.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// xsr_prepareCuts — sort segments and compute the shared tolerance/zero
// point once, so the panel can drive one evalScript call PER SEGMENT.
//
// IMPORTANT: we intentionally do NOT loop over all segments inside a
// single host script call. ExtendScript runs synchronously and blocks
// Premiere's own engine while it executes — calling qeTrack.razor()
// repeatedly in a tight loop within one script invocation does not give
// Premiere a chance to actually commit each structural edit before the
// next one fires. $.sleep() does NOT fix this (verified: even long
// in-script sleeps didn't help — only the very first edit in an entire
// script call ever reliably landed). The edit only reliably commits
// between SEPARATE calls into the host script, so the panel must call
// xsr_applyOneCut once per segment, awaiting each round-trip.
// ---------------------------------------------------------------------
function xsr_prepareCuts(argJson) {
  try {
    var args = JSON.parse(argJson);
    var seq = args.sequenceId ? findSequenceById(args.sequenceId) : getActiveSequence();

    // offsetTicks is the sequence-tick position of WAV sample 0 for whatever
    // scope was analyzed. The panel passes it back from the export step; fall
    // back to the sequence zero point (whole-sequence analysis) if absent.
    var offsetTicks = (args.offsetTicks !== undefined && args.offsetTicks !== null)
      ? Number(args.offsetTicks)
      : (Number(seq.zeroPoint) || 0);

    // NOTE: seq.getSettings().videoFrameRate is a Time object representing
    // the duration of ONE FRAME — its .ticks property already gives us
    // exactly the tick-length of a single frame. Do NOT compute this via
    // TICKS_PER_SECOND / videoFrameRate.seconds — .seconds on this object
    // is the frame's duration in seconds, not the frame rate itself.
    var frameRateObj = seq.getSettings && seq.getSettings().videoFrameRate;
    var oneFrameTicks = frameRateObj ? Number(frameRateObj.ticks) : 0;
    var frameTicks = oneFrameTicks * 5;

    var segments = (args.silenceSegments || []).slice();
    // Apply from the END of the timeline backwards so earlier timecodes
    // don't shift while we're still cutting later ones.
    segments.sort(function (a, b) { return b.startMs - a.startMs; });

    return safeReturn({
      offsetTicks: offsetTicks,
      frameTicks: frameTicks,
      segments: segments
    });
  } catch (e) {
    return safeError(e);
  }
}

// ---------------------------------------------------------------------
// xsr_listAudioTracks — enumerate the sequence's audio tracks so the panel
// can offer per-track "analyze these tracks" checkboxes.
// ---------------------------------------------------------------------
function xsr_listAudioTracks(argJson) {
  try {
    var args = argJson ? JSON.parse(argJson) : {};
    var seq = args.sequenceId ? findSequenceById(args.sequenceId) : getActiveSequence();
    var list = [];
    var n = seq.audioTracks ? seq.audioTracks.numTracks : 0;
    for (var i = 0; i < n; i++) {
      var tr = seq.audioTracks[i];
      var clipCount = (tr.clips && tr.clips.numItems !== undefined) ? tr.clips.numItems : 0;
      list.push({
        index: i,
        name: (tr.name || ("Audio " + (i + 1))),
        muted: tr.isMuted(),
        clipCount: clipCount
      });
    }
    return safeReturn({ tracks: list });
  } catch (e) {
    return safeError(e);
  }
}

// ---------------------------------------------------------------------
// xsr_applyOneCut — razor + ripple-delete exactly ONE silence segment,
// across all (or the selected) audio tracks, mirrored onto video tracks.
// Called once per segment by the panel (see xsr_prepareCuts above for why).
// ---------------------------------------------------------------------
function xsr_applyOneCut(argJson) {
  try {
    app.enableQE();
    var args = JSON.parse(argJson);
    // args: { sequenceId, offsetTicks, frameTicks, seg: {startMs, endMs}, segmentIndex }
    var startTicks = addTicks(msToTicksString(args.seg.startMs), args.offsetTicks);
    var endTicks = addTicks(msToTicksString(args.seg.endMs), args.offsetTicks);
    var frameTicks = args.frameTicks;
    var errors = [];
    var removedSomething = false;

    // Public-DOM sequence — needed for setPlayerPosition() (the only reliable
    // way to move the CTI/playhead on modern Premiere).
    var seq = args.sequenceId ? findSequenceById(args.sequenceId) : getActiveSequence();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) throw new Error("QE DOM could not access the active sequence.");

    // STEP 1 — create the two edit points across ALL tracks at once, using
    // the documented sequence-level razor (razor at the current playhead),
    // NOT the per-track qeTrack.razor(ticks) form which silently no-ops on
    // Premiere 2024+. We move the playhead with the public-DOM
    // setPlayerPosition(ticks) and then razor at CTI.timecode.
    var razoredStart = razorSequenceAt(seq, qeSeq, startTicks, args.segmentIndex);
    var razoredEnd = razorSequenceAt(seq, qeSeq, endTicks, args.segmentIndex);
    if (!razoredStart || !razoredEnd) {
      // Nothing was actually split — report it up so the panel can warn the
      // user instead of silently claiming success.
      errors.push(
        "segment " + args.segmentIndex + ": sequence.razor() created no edit " +
        "(razoredStart=" + razoredStart + " razoredEnd=" + razoredEnd + ")."
      );
    }

    // STEP 2 — ripple-delete the middle (silence) piece on each track.
    // Always across ALL audio tracks: the sequence-level razor already split
    // every track, and deleting on all of them (plus video below) is what
    // keeps audio and picture in sync. (Which tracks were *analyzed* is a
    // separate choice, handled at export time.)
    var trackCount = qeSeq.numAudioTracks;

    for (var t = 0; t < trackCount; t++) {
      try {
        var audioTrack = qeSeq.getAudioTrackAt(t);
        if (!audioTrack) continue;
        if (removeMiddleItem(audioTrack, startTicks, endTicks, frameTicks)) removedSomething = true;
      } catch (eTrack) {
        var tMsg = (eTrack && eTrack.message) ? eTrack.message : String(eTrack);
        debugLog("segment " + args.segmentIndex + " audio track " + t + " FAILED: " + tMsg);
        errors.push("segment " + args.segmentIndex + " audio track " + t + ": " + tMsg);
      }
    }

    for (var v = 0; v < qeSeq.numVideoTracks; v++) {
      try {
        var videoTrack = qeSeq.getVideoTrackAt(v);
        if (!videoTrack) continue;
        if (removeMiddleItem(videoTrack, startTicks, endTicks, frameTicks)) removedSomething = true;
      } catch (eVTrack) {
        var vMsg = (eVTrack && eVTrack.message) ? eVTrack.message : String(eVTrack);
        debugLog("segment " + args.segmentIndex + " video track " + v + " FAILED: " + vMsg);
        errors.push("segment " + args.segmentIndex + " video track " + v + ": " + vMsg);
      }
    }

    return safeReturn({
      applied: removedSomething,
      errors: errors
    });
  } catch (e) {
    debugLog("xsr_applyOneCut top-level FAILED (segment " + (args && args.segmentIndex) + "): " + (e && e.message ? e.message : String(e)));
    return safeError(e);
  }
}

// Move the playhead to `ticksStr` and razor ALL tracks there, using the
// Adobe-documented sequence-level razor form. Returns true only if an edit
// point actually appeared near that position afterwards (verified, not
// assumed). setPlayerPosition() takes a ticks string; qeSeq.razor() takes
// the CTI's timecode string.
function razorSequenceAt(seq, qeSeq, ticksStr, segmentIndex) {
  var posNum = Number(ticksStr);

  function anyEdgeNear(pos, tol) {
    var qeTrack = qeSeq.getAudioTrackAt(0);
    if (!qeTrack) return false;
    for (var k = 0; k < qeTrack.numItems; k++) {
      var it = qeTrack.getItemAt(k);
      if (!it) continue;
      if (Math.abs(Number(it.start.ticks) - pos) <= tol ||
          Math.abs(Number(it.end.ticks) - pos) <= tol) return true;
    }
    return false;
  }

  try {
    seq.setPlayerPosition(ticksStr);
    $.sleep(80);
    var tc = qeSeq.CTI.timecode; // current-time-indicator timecode string
    debugLog("razorSequenceAt(seg " + segmentIndex + "): playhead -> " + ticksStr +
      " (CTI.timecode=" + tc + "), calling qeSeq.razor()");
    qeSeq.razor(tc);
    $.sleep(120);
    // Tolerance of ~1 frame is enough to confirm the edit landed where we
    // asked; use a small fixed tolerance since the playhead frame-snaps.
    var tol = 254016000000 / 10; // 0.1s, comfortably more than one frame
    var landed = anyEdgeNear(posNum, tol);
    debugLog("razorSequenceAt(seg " + segmentIndex + "): edit landed=" + landed);
    return landed;
  } catch (e) {
    debugLog("razorSequenceAt(seg " + segmentIndex + ") THREW: " + (e && e.message ? e.message : String(e)));
    return false;
  }
}

// Add a (possibly large) tick offset to a ticks string, returned as a string
// (kept as a string throughout since that's what razor()/getItemAt expect
// to compare against, but Number() precision is fine here — tick values for
// any realistic sequence length stay well under Number.MAX_SAFE_INTEGER).
function addTicks(ticksStr, offsetTicks) {
  return String(Number(ticksStr) + offsetTicks);
}

// Find the item that sits between startTicks and endTicks (the silence
// piece created by the two sequence-level razors) and ripple-delete it so
// everything after shifts left. Returns true if a clip was actually found
// and removed, false otherwise, so callers can tell real cuts apart from
// no-ops. This function no longer razors — razoring is done once, at the
// sequence level, by razorSequenceAt() before this is called.
function removeMiddleItem(qeTrack, startTicksStr, endTicksStr, toleranceTicks) {
  var tol = toleranceTicks || 0;
  var startNum = Number(startTicksStr);
  var endNum = Number(endTicksStr);
  var expectedDuration = endNum - startNum;

  debugLog("removeMiddleItem: scanning " + qeTrack.numItems + " items for start=" + startNum + " end=" + endNum + " tol=" + tol);

  // Allow a small tolerance on both edges to account for frame-snapping.
  for (var i = 0; i < qeTrack.numItems; i++) {
    var item;
    try {
      item = qeTrack.getItemAt(i);
    } catch (eItem) {
      debugLog("removeMiddleItem: getItemAt(" + i + ") THREW: " + (eItem && eItem.message ? eItem.message : String(eItem)));
      continue;
    }
    if (!item) continue;
    var itemStart, itemEnd;
    try {
      itemStart = Number(item.start.ticks);
      itemEnd = Number(item.end.ticks);
    } catch (eBounds) {
      debugLog("removeMiddleItem: reading item " + i + " start/end THREW: " + (eBounds && eBounds.message ? eBounds.message : String(eBounds)));
      continue;
    }
    var containedStart = itemStart >= (startNum - tol);
    var containedEnd = itemEnd <= (endNum + tol);
    debugLog(
      "removeMiddleItem: item " + i + " start=" + itemStart + " end=" + itemEnd +
      " (duration=" + (itemEnd - itemStart) + ") — containedStart=" + containedStart +
      " (need start>=" + (startNum - tol) + ") containedEnd=" + containedEnd +
      " (need end<=" + (endNum + tol) + ")"
    );
    if (containedStart && containedEnd) {
      // SAFETY CHECK: containment alone isn't enough — if a razor cut
      // snapped to an unexpected edit point, this could match (and ripple-
      // delete) a much bigger clip than the silence gap we actually meant
      // to remove. Only proceed if the matched item's real length is
      // close to the intended silence duration; otherwise skip it rather
      // than risk deleting the wrong content.
      var itemDuration = itemEnd - itemStart;
      var durationDiff = Math.abs(itemDuration - expectedDuration);
      if (durationDiff > (tol * 2 + 1)) {
        debugLog(
          "removeMiddleItem: SKIPPED item (start=" + itemStart + " end=" + itemEnd +
          " duration=" + itemDuration + ") — expected duration " + expectedDuration +
          " differs by " + durationDiff + " ticks, too far off to be the intended silence gap."
        );
        continue;
      }
      try {
        item.remove(true, false); // ripple=true, removeFromMedia=false
      } catch (eRemove) {
        debugLog("removeMiddleItem: item.remove() on item " + i + " THREW: " + (eRemove && eRemove.message ? eRemove.message : String(eRemove)));
        throw eRemove;
      }
      return true;
    }
  }
  debugLog("removeMiddleItem: no matching item found (no-op).");
  return false;
}

// ---------------------------------------------------------------------
// xsr_undo — Premiere exposes NO scripted undo (neither app.project.undo()
// nor any QE DOM equivalent exists). Our cuts land on Premiere's normal
// undo stack, so the only reliable revert is the user pressing Ctrl+Z
// (Edit > Undo). We keep this host function so the panel has one place to
// discover that, and in case a future Premiere build adds a real undo() we
// can feature-detect and call it.
// ---------------------------------------------------------------------
function xsr_undo(argJson) {
  try {
    if (app.project && typeof app.project.undo === "function") {
      app.project.undo();
      return safeReturn({ ok: true });
    }
    return safeReturn({ ok: false, nativeUndo: true });
  } catch (e) {
    return safeReturn({ ok: false, nativeUndo: true });
  }
}

// ---------------------------------------------------------------------
// xsr_ping — trivial liveness/version check. Lets the panel confirm which
// host build is actually loaded into Premiere's (persistent, per-session)
// ExtendScript engine, independent of what's on disk.
// ---------------------------------------------------------------------
function xsr_ping(argJson) {
  return safeReturn({ ok: true, build: "xsr-1.0.0" });
}

// Runs once, at the moment this file is evaluated into the ExtendScript
// engine — i.e. only when the engine actually (re)loads host.jsx. If this
// line's timestamp is older than your last redeploy, Premiere is still
// running a stale copy and needs a full restart.
debugLog("host.jsx evaluated (build xsr-1.0.0)");
