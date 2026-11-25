(() => {
  'use strict';
  const API = window.RH_DJ.API;
  const KEY = 'rh_dj_library_v1';
  const $ = (id) => document.getElementById(id);
  let library = [];
  try { library = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { library = []; }
  let current = null;
  let seekDirty = false;
  let searchAbort = null;

  const engine = new window.RH_DJ.Engine({
    onStatus(info) { renderStatus(info); },
    onTrack(track) { renderCurrent(track); },
  });
  engine.setLibrary(library);

  function save() { try { localStorage.setItem(KEY, JSON.stringify(library)); } catch { /* ignore */ } }
  function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmt(s) { const n = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }

  function renderLibrary() {
    $('libraryCount').textContent = library.length + ' треков';
    if (!library.length) { $('library').innerHTML = '<div class="empty">Пока пусто. Найди треки выше и добавь их сюда.</div>'; return; }
    $('library').innerHTML = library.map((t) => `<div class="lib-row">
      <div class="cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : '♪'}</div>
      <div class="meta"><div class="title">${esc(t.title)}</div><div class="sub">${esc(t.artist)} · ${fmt(t.duration)}</div></div>
      <button class="lib-play" data-play="${esc(t.id)}">▶</button>
      <button class="lib-del" data-del="${esc(t.id)}">×</button>
    </div>`).join('');
  }

  function renderCurrent(track) {
    current = track;
    $('trackTitle').textContent = track.title;
    $('trackArtist').textContent = track.artist + (track.source === 'zvuk' ? ' · Zvuk' : ' · SoundCloud');
    $('cover').innerHTML = track.cover ? `<img src="${esc(track.cover)}" alt="">` : '♪';
  }

  function renderStatus(info) {
    const map = { loading:'Загрузка', analyzed:'Анализ готов', playing:'Играет', paused:'Пауза', mixing:'Переход', mix_on:'AutoMix включён', mix_off:'Mix выключен' };
    $('mixState').textContent = map[info.phase] || info.phase;
    $('enginePill').textContent = (info.phase || 'idle').toUpperCase();
    $('mixBtn').classList.toggle('on', engine.mix);
  }

  async function search() {
    const q = $('searchInput').value.trim();
    if (!q) return;
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    $('searchMeta').textContent = 'Ищем в Zvuk и SoundCloud…';
    $('searchResults').innerHTML = '';
    try {
      const res = await fetch(API + '/api/search?q=' + encodeURIComponent(q) + '&limit=24', { signal: searchAbort.signal });
      const data = await res.json();
      const items = data.items || [];
      $('searchMeta').textContent = items.length ? 'Найдено: ' + items.length : 'Ничего не найдено';
      $('searchResults').innerHTML = items.map((t) => `<div class="result">
        <div class="cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : '♪'}</div>
        <div class="meta"><div class="title">${esc(t.title)}</div><div class="sub">${esc(t.artist)} · ${t.source}</div></div>
        <button class="add" data-add="${esc(t.id)}">+</button>
      </div>`).join('');
      window.__searchItems = items;
    } catch (error) {
      if (error.name !== 'AbortError') $('searchMeta').textContent = 'Поиск недоступен.';
    }
  }

  function add(id) {
    const item = (window.__searchItems || []).find((t) => t.id === id);
    if (!item || library.some((t) => t.id === id)) return;
    library.push(item); save(); engine.setLibrary(library); renderLibrary();
  }
  function remove(id) {
    library = library.filter((t) => t.id !== id); save(); engine.setLibrary(library); renderLibrary();
  }

  $('searchBtn').addEventListener('click', search);
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  document.addEventListener('click', async (e) => {
    const addBtn = e.target.closest('[data-add]'); if (addBtn) { add(addBtn.dataset.add); return; }
    const delBtn = e.target.closest('[data-del]'); if (delBtn) { remove(delBtn.dataset.del); return; }
    const playBtn = e.target.closest('[data-play]');
    if (playBtn) {
      const track = library.find((t) => t.id === playBtn.dataset.play);
      if (!track) return;
      try { await engine.playTrack(track); renderCurrent(track); } catch { $('mixState').textContent = 'Трек недоступен'; }
    }
  });
  $('playBtn').addEventListener('click', async () => {
    try {
      if (engine.playing) { engine.pause(); $('playBtn').textContent = '▶'; }
      else if (engine.decks) { await engine.resume(); $('playBtn').textContent = '❚❚'; }
      else if (library[0]) { await engine.playTrack(library[0]); renderCurrent(library[0]); $('playBtn').textContent = '❚❚'; }
    } catch { $('mixState').textContent = 'Не удалось включить'; }
  });
  $('nextBtn').addEventListener('click', async () => {
    if (!current) return;
    const idx = library.findIndex((t) => t.id === current.id);
    const next = library[(idx + 1) % library.length];
    if (next) { try { await engine.playTrack(next); renderCurrent(next); } catch { /* ignore */ } }
  });
  $('mixBtn').addEventListener('click', () => engine.toggle());
  function fmt(s) { const n = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }
  function updateTimeline() {
    if (!engine.decks) return;
    const d = engine.duration(); const p = engine.position();
    const pct = d ? Math.min(100, p / d * 100) : 0;
    $('currentTime').textContent = fmt(p);
    $('durationTime').textContent = fmt(d);
    if (!seekDirty) {
      $('seekBar').value = String(Math.round(pct * 10));
      $('seekBar').style.setProperty('--played', pct + '%');
    }
    const info = engine.getMixInfo();
    const marker = $('mixMarker');
    if (info && d) {
      marker.hidden = false;
      marker.style.left = Math.min(100, info.at / d * 100) + '%';
      marker.title = 'Переход: ' + fmt(info.at) + (info.next ? ' → ' + info.next.title : '');
      $('mixPointLabel').textContent = 'MIX ' + fmt(info.at) + (info.next ? ' → ' + info.next.title : '');
    } else {
      marker.hidden = true;
      $('mixPointLabel').textContent = '';
    }
    const btn = $('playBtn'); if (btn) btn.textContent = engine.playing ? '❚❚' : '▶';
  }
  $('seekBar').addEventListener('input', () => {
    seekDirty = true;
    const d = engine.duration();
    const value = Number($('seekBar').value) / 1000;
    $('seekBar').style.setProperty('--played', (value * 100) + '%');
    $('currentTime').textContent = fmt(d * value);
  });
  $('seekBar').addEventListener('change', () => {
    const d = engine.duration();
    engine.seek(d * Number($('seekBar').value) / 1000);
    seekDirty = false;
    updateTimeline();
  });
  setInterval(updateTimeline, 500);
  renderLibrary();
  window.__djDebug = { engine, getLibrary: () => library, getCurrent: () => current };
})();
