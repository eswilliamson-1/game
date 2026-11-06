(function () {
  "use strict";

  // Original procedural techno track, synthesized live with the Web Audio API.
  // No audio files are used: every kick, hat, bass note and stab is generated here.

  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null, master = null, noiseBuf = null, sfxGain = null, bus = null;
  var playing = false, muted = false;
  var BPM = 128;
  var STEP = 60 / BPM / 4; // sixteenth note
  var LOOK = 0.25;
  var step = 0, nextTime = 0;
  var VOLUME = 0.5;
  var KEY = "signalSorterMusicMuted";

  // datacenter hum (separate from the music, always running while playing)
  var humGain = null, humLevel = 0.3, humSent = -1;
  var HUM_VOL = 0.5;

  try { muted = localStorage.getItem(KEY) === "1"; } catch (e) { muted = false; }

  // A minor groove: Am - Am - F - G
  var ROOTS = [33, 33, 29, 31];
  var CHORDS = [[57, 60, 64], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
  // bass offsets per sixteenth (-1 = rest)
  var BASS = [-1, -1, 0, 0, -1, -1, 0, 12, -1, -1, 0, 0, -1, 7, 0, 12];

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function init() {
    if (ctx) return true;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { ctx = null; return false; }
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    bus = comp;
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(comp);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.6;
    sfxGain.connect(comp);
    comp.connect(ctx.destination);
    var len = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  function env(g, t, peak, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  }

  function kick(t) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    env(g, t, 0.95, 0.4);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.42);
  }

  function noiseHit(t, type, freq, q, peak, decay) {
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    env(g, t, peak, decay);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + decay + 0.02);
  }

  function hat(t, open) {
    noiseHit(t, "highpass", 7500, 0.7, open ? 0.12 : 0.05, open ? 0.18 : 0.04);
  }

  function clap(t, vol) {
    noiseHit(t, "bandpass", 1600, 1.2, vol, 0.16);
  }

  function bass(t, midi) {
    var o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(mtof(midi), t);
    f.type = "lowpass"; f.Q.value = 8;
    f.frequency.setValueAtTime(180, t);
    f.frequency.linearRampToValueAtTime(950, t + 0.01);
    f.frequency.exponentialRampToValueAtTime(200, t + 0.1);
    env(g, t, 0.26, STEP * 0.95);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + STEP);
  }

  function stab(t, notes, cutoff) {
    var f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = "lowpass"; f.Q.value = 4; f.frequency.setValueAtTime(cutoff, t);
    env(g, t, 0.07, 0.22);
    f.connect(g); g.connect(master);
    for (var i = 0; i < notes.length; i++) {
      var o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(mtof(notes[i]), t);
      o.detune.value = (i - 1) * 7;
      o.connect(f);
      o.start(t); o.stop(t + 0.24);
    }
  }

  function arp(t, midi) {
    var o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(mtof(midi), t);
    f.type = "lowpass"; f.frequency.value = 2500;
    env(g, t, 0.035, 0.1);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.12);
  }

  function scheduleStep(s, t) {
    var bar = Math.floor(s / 16) % 16;
    var st = s % 16;
    var ci = bar % 4;
    var fill = bar === 15 && st >= 12;

    if (st % 4 === 0 && !fill) kick(t);
    if (st % 4 === 2) hat(t, true);
    else if (st % 2 === 1) hat(t, false);

    if (bar >= 4 && (st === 4 || st === 12) && !fill) clap(t, 0.22);
    if (fill) clap(t, 0.1 + (st - 12) * 0.05);

    var b = BASS[st];
    if (b >= 0 && !fill) bass(t, ROOTS[ci] + b + 12);

    if (bar >= 4 && (st === 3 || st === 10)) {
      var cutoff = 900 + 1600 * (0.5 + 0.5 * Math.sin(s * 0.02));
      stab(t, CHORDS[ci], cutoff);
    }

    if (bar >= 8 && !fill) {
      var ch = CHORDS[ci];
      arp(t, ch[st % 3] + ((st % 6) >= 3 ? 12 : 0));
    }
  }

  // ---- datacenter hum: fan roar, air hiss, electrical buzz, wavering whine ----
  function startHum() {
    if (humGain || !ctx) return;
    try {
      humGain = ctx.createGain();
      humGain.gain.value = 0;
      humGain.connect(bus);

      var src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;

      var lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 650; lp.Q.value = 0.7;
      var roar = ctx.createGain();
      roar.gain.value = 0.6;
      src.connect(lp); lp.connect(roar); roar.connect(humGain);

      var bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 3300; bp.Q.value = 9;
      var hiss = ctx.createGain();
      hiss.gain.value = 0.35;
      src.connect(bp); bp.connect(hiss); hiss.connect(humGain);

      var o1 = ctx.createOscillator();
      o1.type = "sawtooth"; o1.frequency.value = 60;
      var lp2 = ctx.createBiquadFilter();
      lp2.type = "lowpass"; lp2.frequency.value = 300;
      var buzz = ctx.createGain();
      buzz.gain.value = 0.16;
      o1.connect(lp2); lp2.connect(buzz); buzz.connect(humGain);

      var o2 = ctx.createOscillator();
      o2.type = "sine"; o2.frequency.value = 120;
      var drone = ctx.createGain();
      drone.gain.value = 0.12;
      o2.connect(drone); drone.connect(humGain);

      var o3 = ctx.createOscillator();
      o3.type = "triangle"; o3.frequency.value = 940;
      var whine = ctx.createGain();
      whine.gain.value = 0.02;
      o3.connect(whine); whine.connect(humGain);
      var lfo = ctx.createOscillator();
      lfo.type = "sine"; lfo.frequency.value = 0.23;
      var lfoG = ctx.createGain();
      lfoG.gain.value = 14;
      lfo.connect(lfoG); lfoG.connect(o3.frequency);

      var trem = ctx.createOscillator();
      trem.type = "sine"; trem.frequency.value = 1.6;
      var tremG = ctx.createGain();
      tremG.gain.value = 0.12;
      trem.connect(tremG); tremG.connect(roar.gain);

      src.start(0);
      o1.start(0); o2.start(0); o3.start(0); lfo.start(0); trem.start(0);
      humSent = humLevel;
      humGain.gain.setTargetAtTime(humLevel * HUM_VOL, ctx.currentTime, 0.6);
    } catch (e) {
      humGain = null;
    }
  }

  function setHum(level) {
    if (typeof level !== "number" || !isFinite(level)) return;
    humLevel = Math.max(0, Math.min(1, level));
    if (!humGain || !ctx) return;
    if (Math.abs(humLevel - humSent) < 0.015) return;
    humSent = humLevel;
    humGain.gain.setTargetAtTime(humLevel * HUM_VOL, ctx.currentTime, 0.3);
  }

  // ---- sound effects (pistol shot, explosion) ----
  function sfxNoise(t, type, freq, q, peak, decay) {
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    s.loop = true;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    env(g, t, peak, decay);
    s.connect(f); f.connect(g); g.connect(sfxGain);
    s.start(t, Math.random() * 0.5);
    s.stop(t + decay + 0.05);
  }

  function sfxTone(t, type, f0, f1, peak, decay) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    env(g, t, peak, decay);
    o.connect(g); g.connect(sfxGain);
    o.start(t); o.stop(t + decay + 0.05);
  }

  function sfx(name) {
    if (!init()) return;
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();
    var t = ctx.currentTime + 0.01;
    if (name === "shot") {
      sfxNoise(t, "bandpass", 2400, 0.8, 0.5, 0.09);
      sfxTone(t, "square", 320, 90, 0.16, 0.07);
    } else if (name === "boom") {
      sfxNoise(t, "lowpass", 1100, 0.7, 0.9, 0.8);
      sfxNoise(t, "lowpass", 380, 0.5, 0.7, 1.2);
      sfxTone(t, "sine", 120, 32, 0.8, 0.6);
    }
  }

  function applyVolume() {
    if (!ctx) return;
    var now = ctx.currentTime;
    var target = (playing && !muted) ? VOLUME : 0;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(target, now + (target > 0 ? 0.05 : 0.6));
  }

  function start() {
    if (!init()) return;
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();
    if (!playing) {
      playing = true;
      step = 0;
      nextTime = ctx.currentTime + 0.08;
    }
    applyVolume();
    startHum();
  }

  function stop() {
    if (!ctx) return;
    playing = false;
    applyVolume();
  }

  function tick() {
    if (!ctx || !playing || ctx.state !== "running") return;
    var now = ctx.currentTime;
    if (nextTime < now - 0.3) nextTime = now + 0.05;
    while (nextTime < now + LOOK) {
      if (!muted) scheduleStep(step, nextTime);
      nextTime += STEP;
      step++;
    }
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(KEY, muted ? "1" : "0"); } catch (e) { /* ignore */ }
    applyVolume();
  }

  document.addEventListener("visibilitychange", function () {
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.suspend) ctx.suspend();
    } else if (playing && ctx.resume) {
      ctx.resume();
    }
  });

  window.TechnoMusic = {
    start: start,
    stop: stop,
    tick: tick,
    setMuted: setMuted,
    setHum: setHum,
    sfx: sfx,
    isMuted: function () { return muted; }
  };
})();
