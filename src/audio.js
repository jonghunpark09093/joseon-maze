// Procedural female-ghost voice, synthesized entirely with the Web Audio API —
// no sample files (nothing to host, license, or attribute). The voice is a
// simple formant synth: a buzzy glottal source (two detuned sawtooths with
// vibrato) is fed through parallel band-pass "formant" filters tuned to vowel
// resonances, which is what makes raw oscillators read as a human "aah/eeh".
//
// Behaviour is distance-driven, set every frame via setProximity():
//   • far / lurking  → a wavering, descending *sob* every couple of seconds,
//     faint in the distance so it works as an early warning;
//   • close / chasing → it snaps into manic, pitch-jumping *laughter*.
// Crossing from far to near (or waking to chase) fires a sudden full laugh —
// the jump scare.
//
// Browsers block audio until a user gesture, so init() must run from a
// click/keypress (we gate it behind an in-game audio toggle).

const CRY_FORMANTS = [[600, 8, 1.0], [1040, 10, 0.7], [2500, 12, 0.3]];
const LAUGH_FORMANTS = [[850, 7, 1.0], [1220, 9, 0.8], [2800, 11, 0.35]];

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export class GhostAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.mode = 'cry';       // 'cry' | 'laugh'
    this._next = 0;          // next scheduled utterance time (ctx clock)
    this._suddenLaugh = false;
    this._demoUntil = 0;     // while > ctx time, force full-volume preview
  }

  init() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.master.gain.linearRampToValueAtTime(0.7, ctx.currentTime + 0.4);

    // Distance attenuation lives between every voice and the master.
    this.distGain = ctx.createGain();
    this.distGain.gain.value = 0;
    this.distGain.connect(this.master);

    this.ready = true;
    this._next = ctx.currentTime + 0.4;
  }

  silence() {
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  // Immediate full-volume preview so you can hear the voice on demand (the
  // distance fade otherwise keeps it near-silent until the ghost is close).
  // Plays two sobs then a sudden manic laugh. Works on the title screen too.
  demo() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0.7, t);
    this.distGain.gain.cancelScheduledValues(t);
    this.distGain.gain.setValueAtTime(0.9, t);
    this._demoUntil = t + 5.2; // setProximity won't override distance for ~5s
    this._sob(t + 0.1);
    this._sob(t + 1.9);
    this._laugh(t + 3.5, 1); // the jump-scare laugh
  }

  // One vocal utterance: detuned glottal saws + vibrato, shaped by formant
  // band-passes, with a pitch glide f0a→f0b and a percussive amp envelope.
  _voice(t, dur, f0a, f0b, formants, peak, { vibHz = 5, vibDepth = 8 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createGain();
    src.gain.value = 0.5;

    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = o2.type = 'sawtooth';
    const fb = Math.max(50, f0b);
    o1.frequency.setValueAtTime(f0a, t);
    o1.frequency.exponentialRampToValueAtTime(fb, t + dur);
    o2.frequency.setValueAtTime(f0a * 1.006, t);
    o2.frequency.exponentialRampToValueAtTime(fb * 1.006, t + dur);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = vibHz;
    const lg = ctx.createGain();
    lg.gain.value = vibDepth;
    lfo.connect(lg);
    lg.connect(o1.frequency);
    lg.connect(o2.frequency);

    o1.connect(src);
    o2.connect(src);

    const out = ctx.createGain();
    out.gain.value = 0.0001;
    for (const [fr, q, g] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fr;
      bp.Q.value = q;
      const fg = ctx.createGain();
      fg.gain.value = g;
      src.connect(bp);
      bp.connect(fg);
      fg.connect(out);
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3800;
    out.connect(lp);
    lp.connect(this.distGain);

    out.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.08, dur * 0.3));
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o1.start(t); o2.start(t); lfo.start(t);
    const end = t + dur + 0.05;
    o1.stop(end); o2.stop(end); lfo.stop(end);
  }

  // A sob/whimper: wavering pitch that catches and falls, sometimes doubled.
  _sob(t) {
    const f = 300 + Math.random() * 40;
    this._voice(t, 0.65, f, f * 0.7, CRY_FORMANTS, 0.5, { vibHz: 5.5, vibDepth: 14 });
    if (Math.random() < 0.5) {
      this._voice(t + 0.75, 0.4, f * 0.8, f * 0.6, CRY_FORMANTS, 0.35, { vibHz: 6, vibDepth: 12 });
    }
  }

  // Manic laughter: a burst of short "ha" syllables whose pitch jumps and
  // climbs. Returns the burst duration so the scheduler can space the next one.
  _laugh(t, intensity) {
    const n = 5 + Math.round(intensity * 7);
    const rate = 9 + intensity * 4; // syllables per second
    let dur = 0;
    for (let i = 0; i < n; i++) {
      const tt = t + i / rate;
      const f = 300 + Math.random() * 140 + i * 10 * intensity;
      this._voice(tt, 0.075, f, f * 0.9, LAUGH_FORMANTS, 0.55, { vibHz: 7, vibDepth: 5 });
      dur = i / rate + 0.12;
    }
    return dur;
  }

  // Force an immediate manic laugh (called when the ghost wakes into a chase).
  scream() {
    if (!this.ready) return;
    this.mode = 'laugh';
    this._suddenLaugh = true;
    this._next = this.ctx.currentTime;
  }

  // Drive the voice from the ghost's straight-line distance (world units) and
  // whether it is chasing. Audible from ~48 units, full volume under ~5.
  setProximity(dist, chasing) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (t < this._demoUntil) return; // a preview is playing; don't fight it

    const near = clamp01((48 - dist) / 43);
    this.distGain.gain.setTargetAtTime(near * near * 0.9, t, 0.3);

    // Mode: laugh when chasing or close; cry otherwise. Snap a sudden laugh on
    // the cry→laugh transition.
    const wantLaugh = chasing || dist < 12;
    if (wantLaugh && this.mode !== 'laugh') {
      this.mode = 'laugh';
      this._suddenLaugh = true;
      this._next = t;
    } else if (!wantLaugh && this.mode !== 'cry') {
      this.mode = 'cry';
      this._next = t + 0.25;
    }

    // Scheduler: advance one utterance whenever the clock passes _next.
    if (t >= this._next) {
      if (this.mode === 'laugh') {
        const intensity = this._suddenLaugh ? 1 : clamp01((12 - dist) / 12) * 0.8 + 0.2;
        const dur = this._laugh(t + 0.02, intensity);
        this._suddenLaugh = false;
        this._next = t + dur + 0.25 + Math.random() * 0.5;
      } else {
        this._sob(t + 0.02);
        this._next = t + 1.4 + Math.random() * 1.4;
      }
    }
  }
}
