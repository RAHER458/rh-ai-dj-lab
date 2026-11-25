/* RH AI DJ Lab · independent dual-deck engine. No RH-MUSIC code. */
(function () {
  'use strict';
  const API = window.RH_DJ_API || 'https://rh-ai-dj-lab-api.rh-launcher.workers.dev';
  const CAMELOT = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B'];

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function rms(data) { let s = 0; for (let i = 0; i < data.length; i += 1) s += data[i] * data[i]; return Math.sqrt(s / Math.max(1, data.length)); }

  function analyzeBuffer(buffer) {
    const sampleRate = buffer.sampleRate;
    const channels = Math.min(2, buffer.numberOfChannels);
    const src = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(sampleRate / 11025));
    const mono = [];
    for (let i = 0; i < src.length; i += step) {
      let v = src[i];
      for (let c = 1; c < channels; c += 1) v += buffer.getChannelData(c)[i];
      mono.push(v / channels);
    }
    const sr = sampleRate / step;
    const frame = Math.max(64, Math.floor(sr * 0.046));
    const hop = Math.max(32, Math.floor(sr * 0.023));
    const energies = [];
    for (let i = 0; i + frame < mono.length; i += hop) {
      let e = 0;
      for (let j = 0; j < frame; j += 1) e += mono[i + j] * mono[i + j];
      energies.push(Math.sqrt(e / frame));
    }
    const onset = energies.map((v, i) => Math.max(0, v - (energies[i - 1] || 0)));
    // Autocorrelation of the onset envelope for BPM (60–200).
    let best = { bpm: 0, score: 0 };
    const minLag = Math.floor(sr / hop * 60 / 200);
    const maxLag = Math.floor(sr / hop * 60 / 60);
    const mean = onset.reduce((a, b) => a + b, 0) / Math.max(1, onset.length);
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let sum = 0; let count = 0;
      for (let i = 0; i + lag < onset.length; i += 1) { sum += (onset[i] - mean) * (onset[i + lag] - mean); count += 1; }
      const score = count ? sum / count : 0;
      if (score > best.score) best = { bpm: 60 * (sr / hop) / lag, score };
    }
    let bpm = best.bpm;
    while (bpm && bpm < 70) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    // Simple chroma via zero-crossing-ish spectral proxy: use low/mid/high band ratios.
    let low = 0; let mid = 0; let high = 0;
    for (let i = 0; i + frame < mono.length; i += hop * 4) {
      for (let j = 0; j < frame; j += 1) {
        const v = mono[i + j];
        const f = Math.abs(v);
        if (f < 0.02) high += f; else if (f < 0.12) mid += f; else low += f;
      }
    }
    const total = low + mid + high || 1;
    const energy = clamp(rms(mono) * 5.5 + (energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length)) * 2, 0, 1);
    const vocal = clamp(mid / total * 1.2 + (1 - high / total) * 0.2, 0, 1);
    const keyIndex = Math.abs(Math.round((low - high) / total * 12)) % 12;
    const duration = buffer.duration;
    const introEnd = Math.min(duration * 0.18, 24);
    const outroStart = Math.max(duration - Math.min(duration * 0.18, 32), duration * 0.65);
    return {
      bpm: Math.round(bpm * 10) / 10,
      bpmConfidence: clamp(best.score * 18, 0, 1),
      key: CAMELOT[keyIndex],
      keyConfidence: 0.45,
      energy,
      vocalRisk: vocal,
      duration,
      introEnd,
      outroStart,
      beat: 60 / Math.max(60, bpm || 120),
      phrase: 32 * (60 / Math.max(60, bpm || 120)),
      low, mid, high,
    };
  }

  function keyDistance(a, b) {
    if (!a || !b) return 3;
    const pa = a.match(/^(\d+)([AB])$/); const pb = b.match(/^(\d+)([AB])$/);
    if (!pa || !pb) return 3;
    const diff = Math.abs(Number(pa[1]) - Number(pb[1]));
    return Math.min(diff, 12 - diff) + (pa[2] === pb[2] ? 0 : 1);
  }

  function scoreCandidate(current, next) {
    if (!current || !next) return -999;
    const bpmDelta = Math.abs((next.bpm || 0) - (current.bpm || 0)) / Math.max(1, current.bpm || 1);
    const harmonic = keyDistance(current.key, next.key);
    const energyDelta = Math.abs((next.energy || 0) - (current.energy || 0));
    const vocal = Math.min(current.vocalRisk || 0, next.vocalRisk || 0);
    return 5 - bpmDelta * 30 - harmonic * 0.9 - energyDelta * 2 - vocal;
  }

  class Deck {
    constructor(ctx, master) {
      this.audio = new Audio();
      this.audio.crossOrigin = 'anonymous';
      this.audio.preload = 'auto';
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 180;
      this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = 0.7;
      this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 6500;
      this.source.connect(this.low).connect(this.mid).connect(this.high).connect(this.gain).connect(master);
      this.gain.gain.value = 0;
    }
    load(url) {
      return new Promise((resolve, reject) => {
        this.audio.src = url;
        this.audio.load();
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('audio_load_failed')); };
        const cleanup = () => { this.audio.removeEventListener('canplay', ok); this.audio.removeEventListener('error', bad); };
        this.audio.addEventListener('canplay', ok, { once: true });
        this.audio.addEventListener('error', bad, { once: true });
      });
    }
    async play(offset = 0) {
      try { this.audio.currentTime = offset; } catch { /* ignore */ }
      await this.audio.play();
    }
    pause() { this.audio.pause(); }
    setGain(value, time = 0.2) {
      const now = this.gain.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), now);
      this.gain.gain.linearRampToValueAtTime(Math.max(0, value), now + time);
    }
    setBass(value) { this.low.gain.setTargetAtTime(value, this.gain.context.currentTime, 0.03); }
  }

  class Engine {
    constructor({ onStatus = () => {}, onTrack = () => {} } = {}) {
      this.ctx = null; this.master = null;
      this.decks = null; this.current = 0; this.track = null; this.library = [];
      this.analysis = new Map(); this.playing = false; this.mix = false;
      this.timer = null; this.transitioning = false; this.onStatus = onStatus; this.onTrack = onTrack;
    }
    async init() {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      document.addEventListener('pointerdown', () => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }, { passive: true });
      this.decks = [new Deck(this.ctx, this.master), new Deck(this.ctx, this.master)];
    }
    async analyze(track) {
      if (this.analysis.has(track.id)) return this.analysis.get(track.id);
      const res = await fetch(API + '/api/stream/' + track.source + '/' + encodeURIComponent(track.sourceId));
      if (!res.ok) throw new Error('stream_unavailable');
      const buf = await res.arrayBuffer();
      const decoded = await this.ctx.decodeAudioData(buf.slice(0));
      const analysis = analyzeBuffer(decoded);
      analysis.trackId = track.id;
      this.analysis.set(track.id, analysis);
      this.onStatus({ phase: 'analyzed', track });
      return analysis;
    }
    async setLibrary(tracks) { this.library = tracks || []; }
    async playTrack(track, index = 0) {
      await this.init();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const deck = this.decks[this.current];
      this.track = track;
      this.onStatus({ phase: 'loading', track });
      const url = API + '/api/stream/' + track.source + '/' + encodeURIComponent(track.sourceId);
      await deck.load(url);
      deck.setGain(1, 0.08);
      deck.setBass(0);
      // Не блокируем UI на play(): iOS может отложить разрешение автоплея.
      deck.play(0).catch(() => { this.playing = false; this.onStatus({ phase: 'paused', track }); });
      this.playing = true;
      this.onTrack(track);
      this.onStatus({ phase: 'playing', track });
      this.analyze(track).catch(() => {});
      this.primeCandidates(track);
      this.startMonitor();
    }
    async primeCandidates(currentTrack) {
      const candidates = this.library.filter((t) => t.id !== currentTrack.id).slice(0, 4);
      for (const track of candidates) {
        if (this.analysis.has(track.id)) continue;
        try { await this.analyze(track); } catch { /* skip */ }
      }
    }
    startMonitor() {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.tick().catch(() => {}), 1200);
    }
    async tick() {
      if (!this.mix || !this.playing || this.transitioning) return;
      const deck = this.decks[this.current];
      const track = this.track;
      if (!deck || !track) return;
      let analysis = this.analysis.get(track.id);
      if (!analysis) { try { analysis = await this.analyze(track); } catch { return; } }
      const info = this.getMixInfo();
      const remaining = (deck.audio.duration || analysis.duration || 0) - deck.audio.currentTime;
      if (!info || remaining <= 0) return;
      if (remaining > Math.max(2, (analysis.duration || 0) - info.at + 2)) return;
      await this.transition();
    }
    getMixInfo() {
      if (!this.track) return null;
      const analysis = this.analysis.get(this.track.id);
      if (!analysis) return null;
      const bpm = Math.max(60, Number(analysis.bpm) || 120);
      const beat = 60 / bpm;
      const phrase = beat * 32;
      const lead = Math.min(48, Math.max(24, phrase));
      let at = Math.max(analysis.introEnd || 8, (analysis.duration || 0) - lead);
      // Привязываем точку к четырёхтактовой сетке, чтобы метка совпадала с музыкой.
      at = Math.max(0, Math.floor(at / (beat * 4)) * beat * 4);
      const candidates = this.library.filter((t) => t.id !== this.track.id);
      let next = candidates[0] || null;
      let bestScore = -999;
      for (const candidate of candidates.slice(0, 6)) {
        const ca = this.analysis.get(candidate.id);
        if (!ca) continue;
        const score = scoreCandidate(analysis, ca);
        if (score > bestScore) { bestScore = score; next = candidate; }
      }
      return { at, next, lead, phrase, score: bestScore };
    }
    seek(seconds) {
      if (!this.decks) return false;
      const deck = this.decks[this.current];
      const duration = deck.audio.duration || (this.track && this.track.duration) || 0;
      if (!duration) return false;
      deck.audio.currentTime = clamp(Number(seconds) || 0, 0, Math.max(0, duration - 0.15));
      this.onStatus({ phase: this.playing ? 'playing' : 'paused', track: this.track });
      return true;
    }
    async transition() {
      if (this.transitioning) return;
      this.transitioning = true;
      try {
        const currentTrack = this.track;
        const currentAnalysis = this.analysis.get(currentTrack.id);
        const candidates = this.library.filter((t) => t.id !== currentTrack.id).slice(0, 6);
        let best = null; let bestScore = -999;
        for (const candidate of candidates) {
          let ca = this.analysis.get(candidate.id);
          if (!ca) { try { ca = await this.analyze(candidate); } catch { continue; } }
          const score = scoreCandidate(currentAnalysis, ca);
          if (score > bestScore) { bestScore = score; best = { track: candidate, analysis: ca }; }
        }
        if (!best) return;
        this.onStatus({ phase: 'mixing', next: best.track });
        const nextDeck = this.decks[1 - this.current];
        const url = API + '/api/stream/' + best.track.source + '/' + encodeURIComponent(best.track.sourceId);
        await nextDeck.load(url);
        const bars = bestScore > 2 ? 8 : 4;
        const duration = Math.min(20, Math.max(6, bars * 4 * (60 / Math.max(70, currentAnalysis.bpm || 120))));
        const now = this.ctx.currentTime;
        nextDeck.setGain(0, 0.01);
        nextDeck.setBass(-6);
        await nextDeck.play(0);
        const fade = nextDeck.gain.gain;
        fade.cancelScheduledValues(now);
        fade.setValueAtTime(0.0001, now);
        fade.linearRampToValueAtTime(1, now + duration);
        const out = this.decks[this.current].gain.gain;
        out.cancelScheduledValues(now);
        out.setValueAtTime(Math.max(0.0001, out.value), now);
        out.linearRampToValueAtTime(0.0001, now + duration);
        nextDeck.setBass(0);
        const old = this.decks[this.current];
        setTimeout(() => { try { old.pause(); old.audio.removeAttribute('src'); old.audio.load(); } catch { /* ignore */ } }, (duration + 0.4) * 1000);
        this.current = 1 - this.current;
        this.track = best.track;
        this.onTrack(best.track);
        this.onStatus({ phase: 'playing', track: best.track });
        setTimeout(() => { this.transitioning = false; }, duration * 1000);
      } catch {
        this.transitioning = false;
      }
    }
    setMix(on) {
      this.mix = !!on;
      this.onStatus({ phase: on ? 'mix_on' : 'mix_off' });
      if (on) this.tick().catch(() => {});
    }
    async toggle() {
      if (!this.playing) return;
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
      this.setMix(!this.mix);
    }
    pause() {
      this.decks && this.decks[this.current].pause();
      this.playing = false;
      this.onStatus({ phase: 'paused' });
    }
    async resume() {
      if (!this.decks) return;
      await this.decks[this.current].play();
      this.playing = true;
      this.onStatus({ phase: 'playing', track: this.track });
    }
    setVolume(value) { if (this.master) this.master.gain.value = clamp(value, 0, 1); }
    position() { return this.decks ? this.decks[this.current].audio.currentTime : 0; }
    duration() { return this.decks ? this.decks[this.current].audio.duration || (this.track && this.track.duration) || 0 : 0; }
  }

  window.RH_DJ = { Engine, analyzeBuffer, scoreCandidate, API };
})();
