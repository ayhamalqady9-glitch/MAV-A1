// Procedural mission sound for PROJECT MAV-A1 (Web Audio, no audio files). Off until the visitor
// turns it on (browsers block sound before a click anyway).
//
// Mars carries sound differently: the thin CO₂ atmosphere absorbs high frequencies and the speed of
// sound is ~240 m/s, so everything heard "on Mars" (wind, rotors, LiDAR) goes through a low-pass
// filter. Inside the lava tube a long, dark reverb takes over. The space drone and the short UI
// tones are score, not sound in air, so they skip the filter.
const lerp = (a, b, t) => a + (b - a) * t;

export function createAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let ctx = null, on = false, N = null;

  function noise(sec, brown) {
    const b = ctx.createBuffer(2, Math.round(ctx.sampleRate * sec), ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
      }
    }
    return b;
  }
  function impulse(sec, decay) {
    const b = ctx.createBuffer(2, Math.round(ctx.sampleRate * sec), ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, decay);
    }
    return b;
  }
  const loop = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };
  const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
  const filter = (type, f, q, to) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (to) b.connect(to); return b; };
  const lfo = (freq, depth, param) => { const o = ctx.createOscillator(); o.frequency.value = freq; const g = gain(depth); o.connect(g); g.connect(param); o.start(); return o; };

  function build() {
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3; comp.connect(ctx.destination);
    const master = gain(0, comp);
    // ---- Mars air: low-pass for everything heard on the surface; reverb send for the cave
    const dry = gain(1, master), wet = gain(0, master);
    const verb = ctx.createConvolver(); verb.buffer = impulse(3.4, 2.8); verb.connect(wet);
    const air = filter('lowpass', 1800, 0.5);
    air.connect(dry); air.connect(verb);
    const brown = noise(7, true), white = noise(2, false);

    // ---- space: a low, slowly breathing chord (score, no air)
    const space = gain(0, master);
    [[55, 0, 0.5], [82.41, 4, 0.3], [110, -6, 0.17], [164.81, 3, 0.07], [246.94, -3, 0.03]].forEach(([f, det, a], i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = det;
      const g = gain(a, space); o.connect(g); o.start(); lfo(0.05 + i * 0.027, a * 0.45, g.gain);
    });
    // ---- entry: buffeting plasma roar
    const roar = gain(0, master);
    { const s = loop(brown, 1.3); const lp = filter('lowpass', 520, 0.7, roar); s.connect(lp); lfo(0.9, 160, lp.frequency); }
    // ---- wind on the surface: gusting, band-limited
    const wind = gain(0, air);
    { const s = loop(brown, 0.8); const bp = filter('bandpass', 240, 0.45); const gust = gain(0.7, wind); s.connect(bp); bp.connect(gust);
      lfo(0.11, 0.35, gust.gain); lfo(0.043, 110, bp.frequency); }
    // ---- rotors: blade-pass buzz + harmonics + a broadband swish, pitched by RPM
    const rotor = gain(0);
    const rotorLP = filter('lowpass', 1200, 0.6, air); rotor.connect(rotorLP);
    const rotorOsc = [[1, 'sawtooth', 0.2], [1.007, 'sawtooth', 0.16], [2, 'triangle', 0.1], [3.02, 'sine', 0.05]].map(([m, type, a]) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = 120 * m; o.connect(gain(a, rotor)); o.start(); return { o, m };
    });
    { const s = loop(white); const bp = filter('bandpass', 850, 0.8); s.connect(bp); bp.connect(gain(0.06, rotor)); }
    lfo(7.3, 0.04, rotor.gain);                                         // beating between the six rotors
    // ---- LiDAR: the spinning sensor's soft 10 Hz tick
    const lidar = gain(0, air);
    { const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.1), ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) { const t = i / ctx.sampleRate; d[i] = Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t * 520) * 0.55; }
      loop(b).connect(lidar); }
    // dosimeter clicks: a 4 ms tick, played at a random rate that follows the dose
    const tick = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.004), ctx.sampleRate), td = tick.getChannelData(0);
    for (let i = 0; i < td.length; i++) td[i] = (Math.random() * 2 - 1) * Math.exp(-i / (td.length * 0.18));
    const geiger = gain(0.05, master), gbp = filter('bandpass', 3200, 0.9, geiger);
    N = { master, dry, wet, air, space, roar, wind, rotor, rotorOsc, lidar, verb, tick, gbp, lastT: 0 };
  }

  const set = (param, v, tc = 0.2) => param.setTargetAtTime(v, ctx.currentTime, tc);
  /** Continuous mix, called every frame. */
  function update(st) {
    if (!ctx || !on) return;
    set(N.space.gain, st.space * 0.24, 0.6);
    set(N.roar.gain, st.roar * 0.5, 0.15);
    set(N.wind.gain, st.wind * 0.42, 0.5);
    set(N.rotor.gain, st.rotor * 0.16, 0.12);
    const f = 70 + st.rpm * 190;
    N.rotorOsc.forEach(({ o, m }) => set(o.frequency, f * m, 0.15));
    set(N.lidar.gain, st.lidar * 0.07, 0.2);
    set(N.wet.gain, st.cave * 0.85, 0.5);
    set(N.dry.gain, lerp(1, 0.6, st.cave), 0.5);
    set(N.air.frequency, lerp(1900, 1300, st.cave), 0.5);
    // Poisson-ish clicks: ~7 per second at the surface dose, ~19 in cruise, almost none deep in the tube
    const now = ctx.currentTime, dt = Math.min(0.1, now - (N.lastT || now)); N.lastT = now;
    const rate = 10.5 * (st.rad || 0);
    let n = 0; while (Math.random() < rate * dt - n && n < 3) n++;
    for (let i = 0; i < n; i++) { const b = ctx.createBufferSource(); b.buffer = N.tick; b.playbackRate.value = 0.8 + Math.random() * 0.5; b.connect(N.gbp); b.start(now + Math.random() * dt); }
  }

  function tone(freq, start, dur, { type = 'sine', vol = 0.15, to = null, slide = 0 } = {}) {
    const t0 = ctx.currentTime + start, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0); if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur / 4)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(to || N.master); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  /** One-shot cues for story moments. */
  function cue(kind) {
    if (!ctx || !on) return;
    if (kind === 'lock') { tone(1320, 0, 0.09, { vol: 0.08 }); tone(1760, 0.11, 0.16, { vol: 0.08 }); }
    else if (kind === 'alert') { for (let i = 0; i < 3; i++) tone(880, i * 0.16, 0.1, { type: 'square', vol: 0.045 }); }
    else if (kind === 'flash') { tone(220, 0, 0.9, { type: 'sawtooth', vol: 0.05, slide: 0.35, to: N.air }); }
    else if (kind === 'node') { tone(540, 0, 0.25, { vol: 0.08, slide: 0.55, to: N.air }); tone(1240, 0.28, 0.5, { vol: 0.05, to: N.air }); }
    else if (kind === 'dock') { tone(70, 0, 0.55, { vol: 0.32, slide: 0.7, to: N.air }); [392, 523.25, 659.25].forEach((f, i) => tone(f, 0.25 + i * 0.12, 0.9, { vol: 0.05 })); }
    else if (kind === 'doors') { tone(150, 0, 2.2, { type: 'sawtooth', vol: 0.03, slide: 0.35, to: N.air }); tone(300, 0.05, 2.0, { type: 'triangle', vol: 0.015, to: N.air }); tone(58, 2.1, 0.4, { vol: 0.22, to: N.air }); }
    else if (kind === 'received') { tone(988, 0, 0.35, { vol: 0.06 }); tone(1318.5, 0.18, 0.9, { vol: 0.05 }); }
    else if (kind === 'lights') { [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.07, 1.6, { vol: 0.035 })); }
    else if (kind === 'epilogue') { [196, 293.66, 392, 493.88, 587.33].forEach((f, i) => tone(f, i * 0.35, 6.5, { vol: 0.03, type: i % 2 ? 'triangle' : 'sine' })); }
    else if (kind === 'success') {
      [261.63, 329.63, 392, 523.25, 783.99].forEach((f, i) => { tone(f, i * 0.09, 4.2, { vol: 0.045, type: i % 2 ? 'triangle' : 'sine' }); });
      tone(130.81, 0, 4.8, { vol: 0.07 });
    }
  }
  function toggle() {
    if (!ctx) build();
    on = !on;
    if (on) ctx.resume();
    set(N.master.gain, on ? 0.85 : 0, 0.25);
    return on;
  }
  return { toggle, update, cue, get on() { return on; } };
}
