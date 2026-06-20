// Procedural horror audio, synthesized entirely with the Web Audio API — no
// external sound files (so nothing to host, license, or attribute). Two layers:
//   1. a distance-driven breathy "presence" (filtered noise) that rises as the
//      ghost nears, audible from far away as an early warning, plus
//   2. a low drone that fades in only while the ghost is actively chasing.
// A one-shot scream stinger fires the moment the ghost wakes and gives chase.
//
// Browsers block audio until a user gesture, so `init()` must be called from a
// click/keypress handler (we call it when the player starts the game).
export class GhostAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
  }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // --- Layer 1: breathy presence (looping low-passed noise) ----------------
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    this.presenceGain = ctx.createGain();
    this.presenceGain.gain.value = 0;
    noise.connect(lp).connect(this.presenceGain).connect(this.master);
    noise.start();

    // --- Layer 2: chase drone (detuned low sines) ---------------------------
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneGain.connect(this.master);
    [52, 52.6].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(this.droneGain);
      osc.start();
    });

    this.ready = true;
  }

  // Update both layers from the ghost's straight-line distance (world units)
  // and whether it is chasing. Audible from ~48 units, loudest under ~5.
  setProximity(dist, chasing) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const near = Math.max(0, Math.min(1, (48 - dist) / 43));
    // Curve it so it stays faint far away and swells close up.
    const swell = near * near;
    this.presenceGain.gain.setTargetAtTime(swell * 0.5, t, 0.25);
    this.droneGain.gain.setTargetAtTime(chasing ? 0.18 + swell * 0.22 : 0, t, 0.4);
  }

  // One-shot scream: a falling sawtooth sweep + a noise burst. Fired when the
  // ghost transitions into the chase state.
  scream() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.7);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.55, t + 0.04);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.95);

    const burst = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    burst.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.4, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    burst.connect(bp).connect(bg).connect(this.master);
    burst.start(t);
  }
}
