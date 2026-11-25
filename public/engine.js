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
    const beat = 60 / Math.max(60, a.bpm || 120);
    const phrase = beat * 32;
    const base = scoreCandidate(a, b);
    const exits = [];
    for (const section of a.sections || []) {
      if (section.start > a.duration * 0.45 && section.start < a.duration - 6) exits.push(section.start);
      if (section.end > a.duration * 0.5 && section.end < a.duration - 5) exits.push(section.end);
    }
    for (let t = a.duration * 0.5; t < a.duration - 6; t += phrase) exits.push(t);
    if (!exits.length) exits.push(Math.max(a.duration * 0.6, a.duration - 24));
    const entries = [];
    for (const section of b.sections || []) {
      if (section.start < b.duration - 6 && (section.kind === 'drop' || section.kind === 'verse')) entries.push(section.start);
    }
    if (b.introEnd) entries.push(b.introEnd);
    if (!entries.length) {
      for (const section of b.sections || []) {
        if (section.start < b.duration - 6 && section.start > 0) entries.push(section.start);
      }
    }
    if (!entries.length) entries.push(0);
    let best = null;
    for (const exitRaw of exits) {
      const exitAt = Math.max(0, Math.floor(exitRaw / (beat * 4)) * beat * 4);
      if (exitAt >= a.duration - 4) continue;
      for (const entryRaw of entries) {
        const entryAt = Math.max(0, Math.floor(entryRaw / (beat * 4)) * beat * 4);
        if (entryAt >= b.duration - 5) continue;
        let bars = 8;
        if (a.duration - exitAt > phrase * 3) bars = 16;
        let durationSec = bars * 4 * beat;
        if (exitAt + durationSec > a.duration - 1) { bars = 4; durationSec = bars * 4 * beat; }
        if (exitAt + durationSec > a.duration - 0.5) continue;
        const section = (a.sections || []).find((item) => exitAt >= item.start - 1 && exitAt <= item.end + 1);
        const sectionEnergy = section ? section.energy : 0.5;
        const entrySection = (b.sections || []).find((item) => entryAt >= item.start - 1 && entryAt <= item.end + 1);
        const entryEnergy = entrySection ? entrySection.energy : 0.5;
        const nearEndPenalty = Math.max(0, exitAt - (a.duration - 35)) / 8;
        const pairScore = base + sectionEnergy * 2 + entryEnergy * 1.2 - Math.abs(sectionEnergy - entryEnergy) * 1.5 - nearEndPenalty;
        const bpmDiff = Math.abs((b.bpm || 0) - (a.bpm || 0)) / Math.max(1, a.bpm || 1);
        const harmonic = keyDistance(a.key, b.key);
        const vocal = Math.min(a.vocalRisk || 0, b.vocalRisk || 0);
        const strategy = bpmDiff > 0.1 ? 'filter fallback'
          : vocal > 0.55 ? 'vocal-aware phrase blend'
            : harmonic <= 1 ? 'beat + EQ phrase blend' : 'phrase blend';
        if (!best || pairScore > best.score) {
          best = { exitAt, entryAt, durationSec, bars, strategy, score: pairScore, next: b };
        }
      }
    }
    return best || { exitAt: Math.max(a.duration * 0.65, a.duration - 20), entryAt: b.introEnd || 0, durationSec: phrase, bars: 8, strategy: 'safe fallback', score: base, next: b };
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
      this.prepared = null;
      this.analyze(track).then(() => this.prepareNext()).catch(() => {});
      this.primeCandidates(track).then(() => this.prepareNext()).catch(() => {});
      this.startMonitor();
    }
    async primeCandidates(currentTrack) {
      const candidates = this.library.filter((t) => t.id !== currentTrack.id).slice(0, 4);
      for (const track of candidates) {
        if (this.analysis.has(track.id)) continue;
        try { await this.analyze(track); } catch { /* skip */ }
      }
    }
    async prepareNext() {
      if (!this.track || this.transitioning) return null;
      const currentAnalysis = this.analysis.get(this.track.id);
      if (!currentAnalysis) return null;
      if (this.prepared && this.prepared.forId === this.track.id) return this.prepared;
      const candidates = this.library.filter((t) => t.id !== this.track.id).slice(0, 8);
      let best = null; let bestScore = -999; let bestPlan = null;
      for (const candidate of candidates) {
        const ca = this.analysis.get(candidate.id);
        if (!ca) continue;
        const plan = planTransition(currentAnalysis, ca);
        const score = plan ? plan.score : scoreCandidate(currentAnalysis, ca);
        if (score > bestScore) { bestScore = score; best = { track: candidate, analysis: ca }; bestPlan = plan; }
      }
      if (!best && candidates[0]) {
        try {
          const ca = await this.analyze(candidates[0]);
          best = { track: candidates[0], analysis: ca };
          bestPlan = planTransition(currentAnalysis, ca);
        } catch { return null; }
      }
      if (!best) return null;
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
      const candidates = this.library.filter((t) => t.id !== this.track.id);
      let next = candidates[0] || null;
      let bestPlan = null;
      for (const candidate of candidates.slice(0, 8)) {
        const ca = this.analysis.get(candidate.id);
        if (!ca) continue;
        const plan = planTransition(analysis, ca);
        if (!plan) continue;
        if (!bestPlan || plan.score > bestPlan.score) { bestPlan = plan; next = candidate; }
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
        if (!prepared || prepared.forId !== currentTrack.id) prepared = await this.prepareNext();
        if (!prepared) { this.transitioning = false; return; }
        const best = { track: prepared.track, analysis: prepared.analysis };
        if (prepared.deckIndex !== 1 - this.current) { this.transitioning = false; return; }
        const nextDeck = this.decks[prepared.deckIndex];
        const oldDeck = this.decks[this.current];

        const plan = prepared.plan || planTransition(currentAnalysis, best.analysis);
        const strategy = plan.strategy;
        this.onStatus({ phase: 'mixing', next: best.track, strategy, plan });

        // Дек уже подготовлен в prepareNext(): не загружаем и не анализируем
        // следующий трек в момент перехода.

        // Реальный beatmatch: подгоняем темп B под A с сохранением питча.
        const targetBpm = Math.max(60, currentAnalysis.bpm || 120);
        const sourceBpm = Math.max(60, best.analysis.bpm || targetBpm);
        const rate = clamp(targetBpm / sourceBpm, 0.94, 1.06);
        nextDeck.setRate(rate);
        const beat = 60 / targetBpm;
        let entry = Math.max(0, Number(plan.entryAt) || 0);
        if (entry >= (best.analysis.duration || 0) - 4) entry = 0;
        // Фазовая синхронизация: ставим первый beat B на текущую фазу beat A.
        const mod = (n, m) => ((n % m) + m) % m;
        const aPhase = mod((oldDeck.audio.currentTime || 0) - (currentAnalysis.beatOffset || 0), beat);
        const bPhase = mod(entry - (best.analysis.beatOffset || 0), beat);
        const phaseShift = mod(aPhase - bPhase, beat);
        if (entry + phaseShift < (best.analysis.duration || 0) - 2) entry += phaseShift;

        const bars = plan.bars || 8;
        const duration = Math.min(32, Math.max(6, plan.durationSec || bars * 4 * beat));
        const start = this.ctx.currentTime + 0.06;

        nextDeck.setGain(0, 0.01);
        nextDeck.setEq(-24, -18, -14, 0.01);
        if (strategy === 'filter fallback') {
          nextDeck.setFilter('highpass', 320, 0.01);
          oldDeck.setFilter('lowpass', 18000, 0.01);
        } else {
          nextDeck.setFilter('allpass', 20000, 0.01);
          oldDeck.setFilter('allpass', 20000, 0.01);
        }
        await nextDeck.play(entry);

        const gainOut = oldDeck.gain.gain;
        const gainIn = nextDeck.gain.gain;
        const ramp = (param, from, to, at, sec) => {
          param.cancelScheduledValues(at);
          param.setValueAtTime(from, at);
          param.linearRampToValueAtTime(to, at + sec);
        };
        ramp(gainIn, 0.0001, 1, start, duration);
        ramp(gainOut, 1, 0.0001, start, duration);

        // Bass swap ближе к середине фразы, а не в случайный момент.
        const swapStart = start + duration * 0.5;
        const swapLen = Math.max(0.4, beat * 2);
        for (const deck of [oldDeck, nextDeck]) deck.setEq(0, 0, 0, 0.01);
        // Стартовый EQ: у B срезан низ, у A пока полный.
        nextDeck.low.gain.setValueAtTime(-24, start);
        nextDeck.mid.gain.setValueAtTime(-18, start);
        nextDeck.high.gain.setValueAtTime(-14, start);
        nextDeck.low.gain.linearRampToValueAtTime(0, swapStart + swapLen);
        nextDeck.mid.gain.linearRampToValueAtTime(0, swapStart + swapLen);
        nextDeck.high.gain.linearRampToValueAtTime(0, swapStart + swapLen);
        oldDeck.low.gain.setValueAtTime(0, swapStart);
        oldDeck.low.gain.linearRampToValueAtTime(-24, swapStart + swapLen);
        oldDeck.mid.gain.setValueAtTime(0, swapStart);
        oldDeck.mid.gain.linearRampToValueAtTime(-8, swapStart + swapLen);
        if (strategy === 'filter fallback') {
          nextDeck.filter.frequency.linearRampToValueAtTime(35, start + duration * 0.85);
          oldDeck.filter.frequency.linearRampToValueAtTime(1400, start + duration * 0.85);
        }
        if (strategy.includes('vocal')) {
          nextDeck.mid.gain.setValueAtTime(-18, start);
          nextDeck.mid.gain.linearRampToValueAtTime(-8, swapStart);
          oldDeck.mid.gain.setValueAtTime(0, start);
          oldDeck.mid.gain.linearRampToValueAtTime(-12, start + duration * 0.6);
        }

        this.current = 1 - this.current;
        this.prepared = null;
        this.track = best.track;
        this.onTrack(best.track);
        this.onStatus({ phase: 'playing', track: best.track, strategy });
        setTimeout(() => {
          try { oldDeck.pause(); oldDeck.audio.removeAttribute('src'); oldDeck.audio.load(); } catch { /* ignore */ }
          this.transitioning = false;
          this.primeCandidates(best.track);
        }, (duration + 0.5) * 1000);
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
