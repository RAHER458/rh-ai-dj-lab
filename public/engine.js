/* RH AI DJ Lab · independent dual-deck engine. No RH-MUSIC code. */
(function () {
  'use strict';
  const API = window.RH_DJ_API || 'https://rh-ai-dj-lab-api.rh-launcher.workers.dev';
  const CAMELOT = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B'];
  const ANALYSIS_CACHE = 'rh_dj_analysis_v2';
  const readCache = () => { try { return JSON.parse(localStorage.getItem(ANALYSIS_CACHE) || '{}') || {}; } catch { return {}; } };
  const writeCache = (cache) => { try { localStorage.setItem(ANALYSIS_CACHE, JSON.stringify(cache)); } catch { /* quota */ } };

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
    let beatOffset = 0; let peak = 0;
    for (let i = 0; i < Math.min(onset.length, 220); i += 1) {
      if (onset[i] > peak) { peak = onset[i]; beatOffset = i * hop / sr; }
    }
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
    const beatSec = 60 / Math.max(60, bpm || 120);
    const sections = [];
    const block = Math.max(8, beatSec * 32);
    const frameRate = sr / hop;
    const blockEnergies = [];
    for (let start = 0; start < duration; start += block) {
      const end = Math.min(duration, start + block);
      const from = Math.max(0, Math.floor(start * frameRate));
      const to = Math.min(energies.length, Math.ceil(end * frameRate));
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += energies[i] || 0;
      const avg = to > from ? sum / (to - from) : 0;
      blockEnergies.push(avg);
      const kind = start < duration * 0.12 ? 'intro'
        : end > duration * 0.88 ? 'outro'
          : avg < 0.025 ? 'breakdown'
            : avg > 0.07 ? 'drop' : 'verse';
      sections.push({ start, end, energy: avg, kind });
    }
    const maxBlock = Math.max(0.0001, ...blockEnergies);
    for (const section of sections) section.energy = clamp(section.energy / maxBlock, 0.15, 1);
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
      beatOffset,
      sections,
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

  function planTransition(a, b) {
    if (!a || !b) return null;
    const beatA = 60 / Math.max(60, a.bpm || 120);
    const phraseA = beatA * 16; // phrase estimate: 4 bars, not a hard-coded transition duration
    const base = scoreCandidate(a, b);
    const exits = [];
    // Only use analyzed section boundaries and grid-aligned phrase candidates.
    for (const section of (a.sections || [])) {
      if (section.start > a.duration * 0.30 && section.start < a.duration - 8) exits.push(section.start);
      if (section.end > a.duration * 0.30 && section.end < a.duration - 8) exits.push(section.end);
    }
    for (let t = a.duration * 0.30; t < a.duration - 8; t += phraseA) exits.push(t);
    const entries = [];
    for (const section of (b.sections || [])) {
      if (section.start < b.duration - 8 && section.start > 4) entries.push(section.start);
    }
    if (b.introEnd > 4 && b.introEnd < b.duration - 8) entries.push(b.introEnd);
    if (!entries.length) entries.push(0);
    const unique = (arr) => [...new Set(arr.map(v => Math.round(v * 10) / 10))];
    let best = null;
    for (const exitRaw of unique(exits)) for (const entryRaw of unique(entries)) {
      const exitAt = Math.max(0, Math.round(exitRaw / (beatA * 4)) * beatA * 4);
      const entryAt = Math.max(0, Math.round(entryRaw / (60 / Math.max(60,b.bpm||120) * 4)) * (60 / Math.max(60,b.bpm||120) * 4));
      if (exitAt < a.duration * 0.25 || exitAt > a.duration - 10 || entryAt >= b.duration - 10) continue;
      // Select blend length by tempo confidence, energy and phrase overlap risk.
      const bpmDiff = Math.abs((b.bpm || 0) - (a.bpm || 0)) / Math.max(1, a.bpm || 1);
      const vocalRisk = Math.max(a.vocalRisk || 0, b.vocalRisk || 0);
      let bars = bpmDiff < 0.045 && vocalRisk < 0.48 ? 16 : bpmDiff < 0.09 ? 8 : 4;
      let durationSec = bars * 4 * beatA;
      if (exitAt + durationSec > a.duration - 0.5) {
        bars = 4; durationSec = bars * 4 * beatA;
      }
      if (exitAt + durationSec > a.duration - 0.2) continue;
      const sectionA = (a.sections || []).find(s => exitAt >= s.start - 1 && exitAt <= s.end + 1);
      const sectionB = (b.sections || []).find(s => entryAt >= s.start - 1 && entryAt <= s.end + 1);
      const eA = sectionA?.energy ?? a.energy ?? 0.5;
      const eB = sectionB?.energy ?? b.energy ?? 0.5;
      const latePenalty = Math.max(0, exitAt - (a.duration - 45)) / 12;
      const entryStructureBonus = sectionB && ['drop','verse'].includes(sectionB.kind) ? 0.35 : 0;
      const score = base + 1.8 * eA + 1.3 * eB - Math.abs(eA-eB)*1.8 - latePenalty + entryStructureBonus;
      const strategy = bpmDiff > 0.12 ? 'tempo-safe blend'
        : vocalRisk > 0.65 ? 'vocal-aware blend'
          : keyDistance(a.key,b.key) <= 1 ? 'harmonic phrase blend' : 'phrase blend';
      if (!best || score > best.score) best = { exitAt, entryAt, durationSec, bars, strategy, score, next: b };
    }
    return best || { exitAt: Math.max(a.duration*0.6,a.duration-20), entryAt: b.introEnd || 0, durationSec: 12, bars: 4, strategy:'fallback', score:base, next:b };
  }

  function nextInOrder(library, current) {
    if (!library.length) return null;
    const index = library.findIndex((t) => t.id === current.id);
    if (index < 0) return library[0];
    return library[(index + 1) % library.length];
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
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'allpass'; this.filter.frequency.value = 20000; this.filter.Q.value = 0.7;
      this.source.connect(this.low).connect(this.mid).connect(this.high).connect(this.filter).connect(this.gain).connect(master);
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
    setEq(lowDb, midDb, highDb, seconds = 0.2) {
      const now = this.gain.context.currentTime;
      const ramp = (param, value) => {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(value, now + Math.max(0.01, seconds));
      };
      ramp(this.low.gain, lowDb);
      ramp(this.mid.gain, midDb);
      ramp(this.high.gain, highDb);
    }
    setFilter(type, frequency, time = 0.2) {
      const now = this.gain.context.currentTime;
      this.filter.type = type;
      this.filter.frequency.cancelScheduledValues(now);
      this.filter.frequency.setValueAtTime(this.filter.frequency.value, now);
      this.filter.frequency.linearRampToValueAtTime(frequency, now + Math.max(0.01, time));
    }
    setRate(value) {
      this.audio.preservesPitch = true;
      this.audio.mozPreservesPitch = true;
      this.audio.webkitPreservesPitch = true;
      this.audio.playbackRate = clamp(Number(value) || 1, 0.9, 1.1);
    }
  }

  class Engine {
    constructor({ onStatus = () => {}, onTrack = () => {} } = {}) {
      this.ctx = null; this.master = null;
      this.decks = null; this.current = 0; this.track = null; this.library = [];
      this.analysis = new Map(); this.playing = false; this.mix = false;
      this.timer = null; this.transitioning = false; this.prepared = null; this.onStatus = onStatus; this.onTrack = onTrack;
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
      const cache = readCache();
      if (cache[track.id] && cache[track.id].bpm) {
        this.analysis.set(track.id, cache[track.id]);
        return cache[track.id];
      }
      const res = await fetch(API + '/api/stream/' + track.source + '/' + encodeURIComponent(track.sourceId));
      if (!res.ok) throw new Error('stream_unavailable');
      const buf = await res.arrayBuffer();
      const decoded = await this.ctx.decodeAudioData(buf.slice(0));
      const analysis = analyzeBuffer(decoded);
      analysis.trackId = track.id;
      this.analysis.set(track.id, analysis);
      const nextCache = readCache();
      nextCache[track.id] = analysis;
      const ids = Object.keys(nextCache);
      if (ids.length > 80) for (const id of ids.slice(0, ids.length - 80)) delete nextCache[id];
      writeCache(nextCache);
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
      this.prepared = null;
      this.analyze(track).then(() => this.prepareNext()).catch(() => {});
      this.primeCandidates(track).then(() => this.prepareNext()).catch(() => {});
      this.startMonitor();
    }
    async primeCandidates(currentTrack) {
      const next = nextInOrder(this.library, currentTrack);
      if (next && !this.analysis.has(next.id)) {
        try { await this.analyze(next); } catch { /* skip */ }
      }
    }
    async prepareNext() {
      if (!this.track || this.transitioning) return null;
      const currentAnalysis = this.analysis.get(this.track.id);
      if (!currentAnalysis) return null;
      if (this.prepared && this.prepared.forId === this.track.id) return this.prepared;
      // Порядок задаёт пользователь. Движок не ранжирует и не переставляет треки.
      const candidate = nextInOrder(this.library, this.track);
      if (!candidate) return null;
      let best = null; let bestPlan = null;
      try {
        const ca = await this.analyze(candidate);
        best = { track: candidate, analysis: ca };
        bestPlan = planTransition(currentAnalysis, ca);
      } catch { return null; }
      const bestScore = bestPlan ? bestPlan.score : scoreCandidate(currentAnalysis, best.analysis);
      const deckIndex = 1 - this.current;
      const deck = this.decks[deckIndex];
      try {
        await deck.load(API + '/api/stream/' + best.track.source + '/' + encodeURIComponent(best.track.sourceId));
      } catch { return null; }
      this.prepared = { ...best, plan: bestPlan, deckIndex, forId: this.track.id, score: bestScore };
      this.onStatus({ phase: this.mix ? 'prepared' : 'ready_next', next: best.track });
      return this.prepared;
    }
    startMonitor() {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.tick().catch(() => {}), 400);
    }
    async tick() {
      if (!this.mix || !this.playing || this.transitioning) return;
      const deck = this.decks[this.current];
      const track = this.track;
      if (!deck || !track) return;
      let analysis = this.analysis.get(track.id);
      if (!analysis) { try { analysis = await this.analyze(track); } catch { return; } }
      const info = this.getMixInfo();
      if (!info) return;
      const position = deck.audio.currentTime || 0;
      if (!this.prepared && position >= Math.max(0, info.at - 60)) await this.prepareNext();
      if (position < info.at) return;
      await this.transition();
    }
    getMixInfo() {
      if (!this.track) return null;
      const analysis = this.analysis.get(this.track.id);
      if (!analysis) return null;
      const beat = 60 / Math.max(60, analysis.bpm || 120);
      const next = nextInOrder(this.library, this.track);
      let bestPlan = null;
      if (next) {
        const ca = this.analysis.get(next.id);
        if (ca) bestPlan = planTransition(analysis, ca);
      }
      if (!bestPlan) {
        const fallbackAt = Math.max(analysis.duration * 0.65, analysis.duration - 20);
        bestPlan = { exitAt: Math.floor(fallbackAt / (beat * 4)) * beat * 4, entryAt: 0, durationSec: 12, bars: 8, score: 0, strategy: 'safe fallback' };
      }
      return { ...bestPlan, at: bestPlan.exitAt, next: next || bestPlan.next, analysis };
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
        if (!currentAnalysis) { this.transitioning = false; return; }
        let prepared = this.prepared;
        const expected = nextInOrder(this.library, currentTrack);
        if (!prepared || prepared.forId !== currentTrack.id || !expected || prepared.track.id !== expected.id) prepared = await this.prepareNext();
        if (!prepared || prepared.deckIndex !== 1 - this.current) { this.transitioning = false; return; }
        const nextTrack = prepared.track, nextAnalysis = prepared.analysis;
        const nextDeck = this.decks[prepared.deckIndex], oldDeck = this.decks[this.current];
        const plan = prepared.plan || planTransition(currentAnalysis,nextAnalysis);
        this.onStatus({ phase:'mixing', next:nextTrack, strategy:plan.strategy, plan });

        // Match tempo conservatively: extreme tempo shifts degrade the mix and are rejected.
        const bpmA = Math.max(60,currentAnalysis.bpm||120), bpmB = Math.max(60,nextAnalysis.bpm||bpmA);
        const rate = clamp(bpmA/bpmB,0.94,1.06);
        nextDeck.setRate(rate);
        const beat = 60/bpmA;
        const entry = clamp(Number(plan.entryAt)||0,0,Math.max(0,(nextAnalysis.duration||nextDeck.audio.duration||0)-2));
        await nextDeck.play(entry);

        const duration = clamp(plan.durationSec || beat*32, beat*16, beat*64);
        const start = this.ctx.currentTime + 0.12;
        const end = start + duration;
        const applyCurve = (param, values, at, sec) => {
          param.cancelScheduledValues(at);
          try {
            param.setValueAtTime(param.value, at);
            param.setValueCurveAtTime(Float32Array.from(values), at, sec);
          } catch {
            // Safari edge case: fall back to a safe linear ramp, never abort the mix.
            param.cancelScheduledValues(at);
            param.setValueAtTime(values[0], at);
            param.linearRampToValueAtTime(values[values.length - 1], at + sec);
          }
        };
        const curve = applyCurve;
        const N=129, fadeIn=[], fadeOut=[];
        for(let i=0;i<N;i++){
          const x=i/(N-1);
          fadeIn.push(Math.sin(x*Math.PI/2));
          fadeOut.push(Math.cos(x*Math.PI/2));
        }
        // Equal-power blend curves (not a linear volume fade).
        curve(nextDeck.gain.gain,fadeIn,start,duration);
        curve(oldDeck.gain.gain,fadeOut,start,duration);

        const ramp = applyCurve;
        // Independent frequency-space choreography: new deck opens highs/mids first;
        // low end is deliberately exchanged in the middle of the phrase.
        const lowIn=[], lowOut=[], midIn=[], midOut=[], highIn=[], highOut=[];
        for(let i=0;i<N;i++){
          const x=i/(N-1);
          const smooth=x*x*(3-2*x);
          const swap=clamp((x-0.42)/0.18,0,1);
          const s=swap*swap*(3-2*swap);
          lowIn.push(-18+18*s);
          lowOut.push(-2-22*s);
          midIn.push(-8+8*smooth);
          midOut.push(0-8*smooth);
          highIn.push(-5+5*smooth);
          highOut.push(0-5*smooth);
        }
        ramp(nextDeck.low.gain,lowIn,start,duration);
        ramp(oldDeck.low.gain,lowOut,start,duration);
        ramp(nextDeck.mid.gain,midIn,start,duration);
        ramp(oldDeck.mid.gain,midOut,start,duration);
        ramp(nextDeck.high.gain,highIn,start,duration);
        ramp(oldDeck.high.gain,highOut,start,duration);

        // For high vocal-risk pairs, attenuate the mid band more deeply on the outgoing deck.
        if((currentAnalysis.vocalRisk||0)+(nextAnalysis.vocalRisk||0)>1.25){
          const duck=[]; for(let i=0;i<N;i++){const x=i/(N-1); duck.push(-10*Math.sin(x*Math.PI/2));}
          ramp(oldDeck.mid.gain,duck,start,duration);
        }
        // Tempo-safe fallback gets a real filter transition; compatible pairs
        // stay open so the two full-range signals can interact.
        if (plan.strategy === 'tempo-safe blend') {
          nextDeck.setFilter('highpass', 260, 0.04);
          oldDeck.setFilter('lowpass', 18000, 0.04);
          nextDeck.filter.frequency.setValueAtTime(260, start);
          nextDeck.filter.frequency.linearRampToValueAtTime(35, end);
          oldDeck.filter.frequency.setValueAtTime(18000, start);
          oldDeck.filter.frequency.linearRampToValueAtTime(1200, end);
        } else {
          nextDeck.setFilter('allpass', 20000, 0.04);
          oldDeck.setFilter('allpass', 20000, 0.04);
        }

        this.current=prepared.deckIndex;
        this.prepared=null;
        this.track=nextTrack;
        this.onTrack(nextTrack);
        this.onStatus({phase:'playing',track:nextTrack,strategy:plan.strategy});
        setTimeout(()=>{
          try { oldDeck.pause(); oldDeck.audio.removeAttribute('src'); oldDeck.audio.load(); oldDeck.setGain(0,0.02); }
          catch{/* cleanup best effort */}
          this.transitioning=false;
          this.primeCandidates(nextTrack).then(()=>this.prepareNext()).catch(()=>{});
        },(duration+0.6)*1000);
      } catch {
        this.transitioning=false;
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
