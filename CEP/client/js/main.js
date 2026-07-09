(function () {
  const csInterface = new CSInterface();
  // CEP with --enable-nodejs + mixed-context exposes Node's require() directly.
  const fs = (typeof require !== "undefined") ? require("fs") : null;

  const els = {
    seqName: document.getElementById("seqName"),
    threshold: document.getElementById("threshold"),
    thresholdVal: document.getElementById("thresholdVal"),
    minDur: document.getElementById("minDur"),
    minDurVal: document.getElementById("minDurVal"),
    padding: document.getElementById("padding"),
    paddingVal: document.getElementById("paddingVal"),
    scope: document.getElementById("scope"),
    trackList: document.getElementById("trackList"),
    btnRefreshTracks: document.getElementById("btnRefreshTracks"),
    rippleDelete: document.getElementById("rippleDelete"),
    btnAnalyze: document.getElementById("btnAnalyze"),
    btnApply: document.getElementById("btnApply"),
    btnUndo: document.getElementById("btnUndo"),
    btnBatch: document.getElementById("btnBatch"),
    btnExportLog: document.getElementById("btnExportLog"),
    progressWrap: document.getElementById("progressWrap"),
    progressBar: document.getElementById("progressBar"),
    status: document.getElementById("status"),
    canvas: document.getElementById("waveform"),
    summary: document.getElementById("summary"),
    seqStatus: document.getElementById("seqStatus"),
    preview: document.getElementById("preview")
  };

  let lastAnalysis = null; // { speechSegments, silenceSegments, totalDurationMs, sequenceFps }
  let isBusy = false;      // true while analyzing/applying — pauses background polling
  let lastSeqName = null;  // last active-sequence name seen by the poller
  let lastTrackSig = null; // fingerprint of the track list, to avoid needless re-renders

  // status accepts an optional tone: "", "ok", "busy", "error"
  function setStatus(msg, tone) {
    els.status.textContent = msg || "";
    if (tone) els.status.setAttribute("data-tone", tone);
    else els.status.removeAttribute("data-tone");
  }
  function setSeqState(state) { els.seqStatus.setAttribute("data-state", state); }
  function showProgress(pct) {
    if (pct === null) { els.progressWrap.classList.add("hidden"); return; }
    els.progressWrap.classList.remove("hidden");
    els.progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  }
  // toggle the spinner + disabled state on an action button
  function setBusy(btn, busy) {
    btn.classList.toggle("is-busy", busy);
    btn.disabled = busy;
  }

  // ---- sliders: live label + filled-track paint ----
  function paintSlider(el) {
    const min = parseFloat(el.min), max = parseFloat(el.max);
    const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
    el.style.setProperty("--fill", pct + "%");
  }
  function bindSlider(el, label, unit) {
    const update = () => { label.textContent = el.value + " " + unit; paintSlider(el); };
    el.addEventListener("input", update);
    update();
  }
  bindSlider(els.threshold, els.thresholdVal, "dB");
  bindSlider(els.minDur, els.minDurVal, "ms");
  bindSlider(els.padding, els.paddingVal, "ms");

  // ---- ExtendScript bridge helper (Promise wrapper around evalScript) ----
  function callHost(fnName, args) {
    return new Promise((resolve, reject) => {
      const argStr = JSON.stringify(args === undefined ? {} : args);
      const script = `${fnName}(${JSON.stringify(argStr)})`;
      csInterface.evalScript(script, (result) => {
        if (result === "__CEP_MISSING__") {
          reject(new Error("Not running inside Premiere Pro (CEP bridge missing)."));
          return;
        }
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.error) reject(new Error(parsed.error));
          else resolve(parsed);
        } catch (e) {
          reject(new Error("Bad response from host: " + result));
        }
      });
    });
  }

  // ---- Audio-track picker ----
  // A fingerprint of the track layout, so auto-refresh only re-renders when
  // something actually changed (no flicker, no lost checkbox selections).
  function trackSignature(tracks) {
    return tracks.map((t) => t.index + ":" + t.name + ":" + t.clipCount + ":" + t.muted).join("|");
  }
  function currentSelection() {
    const map = {};
    els.trackList.querySelectorAll('input[type="checkbox"]').forEach((b) => {
      map[b.dataset.trackIndex] = b.checked;
    });
    return map;
  }

  function renderTrackList(tracks) {
    const prev = currentSelection(); // preserve the user's picks across re-renders
    els.trackList.innerHTML = "";
    if (!tracks || !tracks.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No audio tracks in this sequence.";
      els.trackList.appendChild(empty);
      return;
    }
    tracks.forEach((t) => {
      const row = document.createElement("label");
      row.className = "track-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.trackIndex = t.index;
      // Keep an existing choice; otherwise default to tracks that have clips
      // and aren't muted.
      cb.checked = (String(t.index) in prev) ? prev[String(t.index)] : (t.clipCount > 0 && !t.muted);
      const name = document.createElement("span");
      name.textContent = t.name;
      const meta = document.createElement("span");
      meta.className = "track-meta";
      meta.textContent = (t.clipCount === 1 ? "1 clip" : t.clipCount + " clips") + (t.muted ? " · muted" : "");
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(meta);
      els.trackList.appendChild(row);
    });
  }

  function refreshAudioTracks(force) {
    return callHost("xsr_listAudioTracks")
      .then((res) => {
        const tracks = res.tracks || [];
        const sig = trackSignature(tracks);
        if (!force && sig === lastTrackSig) return; // unchanged — leave the DOM alone
        lastTrackSig = sig;
        renderTrackList(tracks);
      })
      .catch(() => { lastTrackSig = null; renderTrackList([]); });
  }

  // Selected audio-track indices, or null to mean "all tracks".
  function getSelectedTrackIndices() {
    const boxes = els.trackList.querySelectorAll('input[type="checkbox"]');
    const all = Array.from(boxes);
    const selected = all.filter(b => b.checked).map(b => Number(b.dataset.trackIndex));
    if (all.length === 0 || selected.length === all.length) return null; // all
    return selected;
  }

  els.btnRefreshTracks.addEventListener("click", () => refreshAudioTracks(true));

  // ---- Keep the header + track list live -------------------------------
  // Premiere has no reliable "active sequence changed" CEP event, and it may
  // not have a sequence ready the instant the panel loads — so poll. Cheap:
  // two evalScripts every couple of seconds, paused while a job is running,
  // and the track list only re-renders when its fingerprint actually changes.
  function syncSequence() {
    if (isBusy) return;
    callHost("xsr_getSequenceInfo")
      .then((info) => {
        const name = (info && info.name) ? info.name : null;
        if (name) { els.seqName.textContent = name; setSeqState("ok"); }
        else { els.seqName.textContent = "No sequence"; setSeqState("idle"); }
        const changed = name !== lastSeqName;
        lastSeqName = name;
        if (name) refreshAudioTracks(changed); // force a redraw when the sequence itself changed
        else { lastTrackSig = null; renderTrackList([]); }
      })
      .catch(() => { /* transient — try again next tick */ });
  }
  const POLL_MS = 2000;
  setInterval(syncSequence, POLL_MS);
  csInterface.addEventListener("com.adobe.csxs.events.DocumentAfterActivate", syncSequence);

  // Confirm which host build is actually loaded in Premiere's (persistent,
  // per-session) ExtendScript engine — surfaced in the panel so we don't
  // have to hunt for a log file. If this errors, the engine is running a
  // stale host.jsx and Premiere needs a FULL restart.
  const EXPECTED_HOST_BUILD = "xsr-1.0.0";
  callHost("xsr_ping")
    .then((r) => {
      if (r && r.build === EXPECTED_HOST_BUILD) {
        setStatus("Ready — set your thresholds, then Analyze.", "ok");
      } else {
        setStatus("Old host code loaded. Fully quit and relaunch Premiere Pro to update.", "error");
      }
    })
    .catch(() => {
      setStatus("Stale host code. Fully quit Premiere Pro (not just the panel) and relaunch.", "error");
    });

  syncSequence(); // initial fill; the interval above keeps it current

  // ---- Draw waveform / segment preview ----
  const CSS = getComputedStyle(document.documentElement);
  const COL = {
    accent: (CSS.getPropertyValue("--accent") || "#38e0be").trim(),
    accentLo: (CSS.getPropertyValue("--accent-lo") || "#24b899").trim(),
    cut: (CSS.getPropertyValue("--cut") || "#ff6b6b").trim(),
    grid: "rgba(255,255,255,0.05)"
  };

  function drawPreview(analysis) {
    const canvas = els.canvas;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, canvas.clientWidth || 360);
    const H = 96, PAD = 8, mid = H / 2;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, H);

    const curve = analysis.dbCurve;
    const total = analysis.totalDurationMs || 1;
    const sil = analysis.silenceSegments || [];
    const xOf = (ms) => (ms / total) * cssWidth;

    // faint centre line
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(cssWidth, mid + 0.5); ctx.stroke();

    // soft coral wash marking each silence gap (so short-amplitude gaps stay legible)
    sil.forEach((s) => {
      const x1 = xOf(s.startMs), x2 = xOf(s.endMs);
      ctx.fillStyle = "rgba(255,107,107,0.12)";
      ctx.fillRect(x1, PAD, Math.max(1, x2 - x1), H - PAD * 2);
    });

    if (curve && curve.length) {
      // Downsample the loudness curve into fixed-width mirrored bars — reads
      // like a real audio waveform and stays crisp at any panel width.
      const barW = 2, gap = 1, step = barW + gap;
      const bars = Math.max(1, Math.floor(cssWidth / step));
      const originX = (cssWidth - bars * step) / 2 + 0.5;
      const maxAmp = mid - PAD;

      const inSilence = (ms) => {
        for (let k = 0; k < sil.length; k++) if (ms >= sil[k].startMs && ms < sil[k].endMs) return true;
        return false;
      };

      for (let b = 0; b < bars; b++) {
        const i0 = Math.floor((b / bars) * curve.length);
        const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / bars) * curve.length));
        let peak = 0;
        for (let i = i0; i < i1 && i < curve.length; i++) {
          const n = Math.max(0, Math.min(1, (curve[i] + 60) / 60)); // -60..0 dB -> 0..1
          if (n > peak) peak = n;
        }
        // gentle curve so quiet detail is visible without the loud parts clipping
        const amp = Math.max(1, Math.pow(peak, 0.85) * maxAmp);
        const midMs = ((i0 + i1) / 2 / curve.length) * total;
        const x = originX + b * step;
        ctx.fillStyle = inSilence(midMs) ? "rgba(255,107,107,0.85)" : COL.accent;
        ctx.fillRect(x, mid - amp, barW, amp * 2);
      }
    }

    els.preview.classList.add("has-data");
  }

  function msToTimecode(ms) {
    const totalSec = ms / 1000;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = (totalSec % 60).toFixed(1);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.padStart(4, "0")}`;
  }

  // ---- Analyze ----
  els.btnAnalyze.addEventListener("click", async () => {
    els.btnApply.disabled = true;
    lastAnalysis = null;
    isBusy = true;
    setBusy(els.btnAnalyze, true);
    setSeqState("busy");
    setStatus("Exporting reference audio…", "busy");
    showProgress(10);

    try {
      const exportInfo = await callHost("xsr_exportSequenceAudio", {
        scope: els.scope.value,
        analyzeTracks: getSelectedTrackIndices(),
        extensionRoot: csInterface.getSystemPath("extension")
      });
      // exportInfo = { wavPath, sequenceFps, sequenceName, durationMs, offsetTicks }

      showProgress(45);
      setStatus("Reading audio…", "busy");
      if (!fs) throw new Error("Node filesystem access unavailable — check manifest CEFCommandLine flags.");
      const buffer = fs.readFileSync(exportInfo.wavPath).buffer;

      showProgress(65);
      setStatus("Analyzing loudness…", "busy");
      const opts = {
        thresholdDb: parseFloat(els.threshold.value),
        minSilenceMs: parseFloat(els.minDur.value),
        paddingMs: parseFloat(els.padding.value)
      };
      const analysis = SilenceDetect.analyzeWavBuffer(buffer, opts);
      analysis.sequenceFps = exportInfo.sequenceFps;
      analysis.sequenceName = exportInfo.sequenceName;
      // Tick position on the real timeline that corresponds to WAV sample 0
      // (differs when analyzing an in/out range or a selected clip).
      analysis.offsetTicks = exportInfo.offsetTicks;

      lastAnalysis = analysis;
      showProgress(100);
      drawPreview(analysis);

      const cutCount = analysis.silenceSegments.length;
      const cutTotalMs = analysis.silenceSegments.reduce((a, s) => a + (s.endMs - s.startMs), 0);
      const afterMs = analysis.totalDurationMs - cutTotalMs;
      // Compact glance: how many gaps, and how much time gets removed.
      els.summary.innerHTML = cutCount
        ? `<b>${cutCount}</b> gap${cutCount === 1 ? "" : "s"} · ` +
          `<span class="num cut">−${msToClock(cutTotalMs)}</span> to remove`
        : `no gaps at these settings`;

      setSeqState("ok");
      if (cutCount) {
        // Full picture in words: total length before → after the cuts.
        setStatus(
          `Found ${cutCount} gap${cutCount === 1 ? "" : "s"} — removes ${msToClock(cutTotalMs)}. ` +
          `Length ${msToClock(analysis.totalDurationMs)} → ${msToClock(afterMs)}. Review, then Apply cuts.`,
          "ok"
        );
      } else {
        setStatus("No silence found. Try a higher threshold or shorter minimum length.", "");
      }
      els.btnApply.disabled = cutCount === 0;
    } catch (err) {
      setSeqState("error");
      setStatus(friendlyError(err.message), "error");
    } finally {
      isBusy = false;
      setBusy(els.btnAnalyze, false);
      setTimeout(() => showProgress(null), 400);
    }
  });

  // Compact clock for the summary readout (m:ss.d, or h:mm:ss.d when needed).
  function msToClock(ms) {
    const t = ms / 1000;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // Trim the noisiest host errors down to something an editor can act on.
  function friendlyError(msg) {
    if (/No clips are selected/i.test(msg)) return "No clips selected. Select clips on the timeline, or switch Range to Entire sequence.";
    if (/No in\/out range/i.test(msg)) return "No In/Out range set. Mark In (I) and Out (O) on the timeline, or switch Range.";
    if (/No active sequence/i.test(msg)) return "Open a sequence in Premiere, then Analyze.";
    if (/export preset/i.test(msg)) return "Missing WAV export preset — reinstall the panel (see docs/BUILD.md).";
    return msg;
  }

  // Re-run detection instantly on slider change if we already exported audio once
  // (cheap: re-analyzes the cached WAV without re-exporting from Premiere)
  let cachedWavPath = null;
  ["input"].forEach(evt => {
    [els.threshold, els.minDur, els.padding].forEach(el => {
      el.addEventListener(evt, () => {
        if (!lastAnalysis) return;
        // Debounced live re-preview against the same exported audio buffer
        clearTimeout(window.__scpDebounce);
        window.__scpDebounce = setTimeout(() => {
          els.btnAnalyze.click();
        }, 350);
      });
    });
  });

  // ---- Apply cuts, one segment per host round-trip ----
  // IMPORTANT: this does NOT batch all segments into a single evalScript
  // call. ExtendScript blocks Premiere's engine while it runs, so doing
  // razor()/ripple-delete for many segments in one script call means only
  // the very first edit reliably commits — everything after it silently
  // no-ops. Calling the host once per segment, and awaiting each
  // round-trip, gives Premiere's engine time to actually commit each cut.
  async function applyCutsSequentially(segments, { sequenceId, offsetTicks, onProgress } = {}) {
    const prep = await callHost("xsr_prepareCuts", {
      sequenceId,
      offsetTicks,
      silenceSegments: segments.map(s => ({ startMs: s.startMs, endMs: s.endMs }))
    });

    let cutsApplied = 0;
    const cutsAttempted = prep.segments.length;
    const errors = [];

    for (let i = 0; i < prep.segments.length; i++) {
      const seg = prep.segments[i];
      if (onProgress) onProgress(i, cutsAttempted);
      try {
        const result = await callHost("xsr_applyOneCut", {
          sequenceId,
          offsetTicks: prep.offsetTicks,
          frameTicks: prep.frameTicks,
          seg,
          segmentIndex: i
        });
        if (result.applied) cutsApplied++;
        if (result.errors && result.errors.length) errors.push(...result.errors);
      } catch (err) {
        errors.push(`segment ${i}: ${err.message}`);
      }
    }

    return { cutsApplied, cutsAttempted, errors };
  }

  // ---- Apply cuts ----
  els.btnApply.addEventListener("click", async () => {
    if (!lastAnalysis) return;
    isBusy = true;
    setBusy(els.btnApply, true);
    setSeqState("busy");
    setStatus("Applying cuts to timeline…", "busy");
    showProgress(5);
    try {
      const result = await applyCutsSequentially(lastAnalysis.silenceSegments, {
        offsetTicks: lastAnalysis.offsetTicks,
        onProgress: (i, total) => {
          setStatus(`Applying cut ${i + 1} of ${total}…`, "busy");
          showProgress(5 + Math.round((i / total) * 90));
        }
      });
      showProgress(100);
      setSeqState("ok");
      if (result.cutsApplied < result.cutsAttempted) {
        const detail = (result.errors && result.errors.length)
          ? " (" + result.errors.slice(0, 2).join("; ") + ")"
          : "";
        setStatus(
          `Applied ${result.cutsApplied} of ${result.cutsAttempted}. Some gaps didn't match a clip${detail}. Press Ctrl+Z to revert.`,
          "error"
        );
      } else {
        setStatus(`Done — ${result.cutsApplied} cut${result.cutsApplied === 1 ? "" : "s"} applied. Press Ctrl+Z to undo.`, "ok");
      }
    } catch (err) {
      setSeqState("error");
      setStatus("Couldn't apply cuts: " + err.message, "error");
    } finally {
      isBusy = false;
      setBusy(els.btnApply, false);
      els.btnApply.disabled = true; // analysis is now stale; re-analyze before applying again
      setTimeout(() => showProgress(null), 400);
    }
  });

  // ---- Undo ----
  els.btnUndo.addEventListener("click", async () => {
    try {
      const res = await callHost("xsr_undo");
      if (res && res.ok) {
        setStatus("Undo complete.", "ok");
      } else {
        // Premiere exposes no scripted undo — the cuts are on its native undo
        // stack, so direct the user to Ctrl+Z. Each cut is a separate step.
        setStatus("To undo: press Ctrl+Z in Premiere (Edit ▸ Undo). Each cut is one step — repeat to revert several.", "");
      }
    } catch (err) {
      setStatus("To undo: press Ctrl+Z in Premiere (Edit ▸ Undo).", "");
    }
  });

  // ---- Batch process ----
  els.btnBatch.addEventListener("click", async () => {
    setStatus("Scanning project for sequences…");
    try {
      const seqs = await callHost("xsr_listSequences");
      if (!seqs.sequences || seqs.sequences.length === 0) {
        setStatus("No sequences found in project.");
        return;
      }
      const names = seqs.sequences.map(s => s.name).join(", ");
      const proceed = confirm(
        `Batch process ${seqs.sequences.length} sequence(s) with current settings?\n\n${names}`
      );
      if (!proceed) { setStatus("Batch cancelled."); return; }

      isBusy = true;
      let done = 0;
      for (const seq of seqs.sequences) {
        setStatus(`Processing "${seq.name}" (${done + 1}/${seqs.sequences.length})…`);
      // Batch always analyzes each whole sequence across all its audio tracks
      // (in/out and clip-selection scopes don't apply across a batch).
      const exportInfo = await callHost("xsr_exportSequenceAudio", {
        sequenceId: seq.id,
        scope: "entire",
        analyzeTracks: null,
        extensionRoot: csInterface.getSystemPath("extension")
      });
        const buffer = fs.readFileSync(exportInfo.wavPath).buffer;
        const opts = {
          thresholdDb: parseFloat(els.threshold.value),
          minSilenceMs: parseFloat(els.minDur.value),
          paddingMs: parseFloat(els.padding.value)
        };
        const analysis = SilenceDetect.analyzeWavBuffer(buffer, opts);
        await applyCutsSequentially(analysis.silenceSegments, {
          sequenceId: seq.id,
          offsetTicks: exportInfo.offsetTicks
        });
        done++;
      }
      setStatus(`Batch complete — ${done} sequence${done === 1 ? "" : "s"} processed. Press Ctrl+Z to undo.`, "ok");
    } catch (err) {
      setStatus("Batch error: " + err.message, "error");
    } finally {
      isBusy = false;
    }
  });

  // ---- Export cut log ----
  els.btnExportLog.addEventListener("click", () => {
    if (!lastAnalysis) { setStatus("Nothing to export yet — run Analyze first.", ""); return; }
    const lines = ["Xorp's Silence Remover — Cut Log", `Sequence: ${lastAnalysis.sequenceName || "-"}`, ""];
    lastAnalysis.silenceSegments.forEach((s, i) => {
      lines.push(`Cut ${i + 1}: ${msToTimecode(s.startMs)} → ${msToTimecode(s.endMs)} (removed ${msToTimecode(s.endMs - s.startMs)})`);
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "xorps_silence_remover_log.txt";
    a.click();
    setStatus("Cut log exported.", "ok");
  });

})();
