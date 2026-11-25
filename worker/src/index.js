/**
 * RH AI DJ Lab — independent API Worker.
 * Tokens live only in Worker secrets: ZVUK_TOKEN, SC_CLIENT_ID.
 */
const ZVUK_GQL = 'https://zvuk.com/api/v1/graphql';
const SC_API = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(), ...extra },
});

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}

function fail(status, code, message) {
  return json({ ok: false, error: { code, message } }, status);
}

async function zvukGql(env, query, variables = {}) {
  if (!env.ZVUK_TOKEN) throw new Error('NO_ZVUK_TOKEN');
  const res = await fetch(ZVUK_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://zvuk.com',
      'Referer': 'https://zvuk.com/',
      'User-Agent': UA,
      'X-Auth-Token': env.ZVUK_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error('ZVUK_HTTP_' + res.status);
  const data = await res.json();
  if (data.errors) throw new Error('ZVUK_GQL: ' + data.errors.map((e) => e.message).join('; '));
  return data.data || {};
}

function zvukTrack(t) {
  if (!t) return null;
  const artists = t.artists || [];
  const cover = t.release && t.release.image && t.release.image.src;
  return {
    id: 'zvuk:' + t.id,
    source: 'zvuk',
    sourceId: String(t.id),
    title: t.title || 'Без названия',
    artist: artists.map((a) => a.title).filter(Boolean).join(', ') || 'Неизвестный исполнитель',
    album: t.release && t.release.title || '',
    duration: Number(t.duration) || 0,
    cover: cover ? String(cover).replace('{size}', '400') : null,
    streamKind: 'progressive',
  };
}

async function zvukSearch(env, q, limit = 20) {
  const data = await zvukGql(env, `query djSearch($q: String, $limit: Int) {
    search(query: $q) { tracks(limit: $limit) { items { id title duration artists { id title } release { id title image { src } } } } }
  }`, { q, limit });
  return ((data.search && data.search.tracks && data.search.tracks.items) || []).map(zvukTrack).filter(Boolean);
}

async function zvukStream(env, id) {
  const data = await zvukGql(env, `query djStream($ids: [ID!]!) {
    mediaContents(ids: $ids) { __typename ... on Track { id stream { mid } } }
  }`, { ids: [String(id)] });
  const item = (data.mediaContents || []).find((x) => x && x.stream && x.stream.mid);
  if (!item) throw new Error('ZVUK_NO_MID');
  return { url: item.stream.mid, quality: '128' };
}

async function scSearch(env, q, limit = 20) {
  if (!env.SC_CLIENT_ID) return [];
  const url = new URL(SC_API + '/search/tracks');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('client_id', env.SC_CLIENT_ID);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://soundcloud.com/' } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.collection || []).map((t) => {
    if (!t || !t.id || t.streamable === false) return null;
    return {
      id: 'sc:' + t.id,
      source: 'soundcloud',
      sourceId: String(t.id),
      title: t.title || 'Без названия',
      artist: (t.user && t.user.username) || 'SoundCloud',
      album: '',
      duration: Math.round((Number(t.duration) || 0) / 1000),
      cover: t.artwork_url || (t.user && t.user.avatar_url) || null,
      streamKind: 'progressive',
    };
  }).filter(Boolean);
}

async function scStream(env, id) {
  if (!env.SC_CLIENT_ID) throw new Error('NO_SC_CLIENT');
  const res = await fetch(SC_API + '/tracks/' + encodeURIComponent(id) + '?client_id=' + encodeURIComponent(env.SC_CLIENT_ID), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('SC_HTTP_' + res.status);
  const track = await res.json();
  const items = (track.media && track.media.transcodings) || [];
  const progressive = items.find((x) => x && !x.snipped && x.format && x.format.protocol === 'progressive' && /audio\/mpeg/.test(x.format.mime_type || ''));
  if (!progressive) throw new Error('SC_NO_PROGRESSIVE');
  const url = new URL(progressive.url);
  url.searchParams.set('client_id', env.SC_CLIENT_ID);
  const resolved = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resolved.ok) throw new Error('SC_RESOLVE_' + resolved.status);
  const data = await resolved.json();
  if (!data.url) throw new Error('SC_NO_URL');
  return { url: data.url, quality: 'progressive' };
}

async function proxyAudio(request, stream) {
  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  const upstream = await fetch(stream.url, { headers: { ...headers, 'User-Agent': UA, 'Referer': 'https://zvuk.com/' }, redirect: 'follow' });
  if (!upstream.ok && upstream.status !== 206) return fail(502, 'STREAM_HTTP', 'Аудио недоступно (' + upstream.status + ').');
  const out = new Headers(cors());
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  out.set('Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    try {
      if (url.pathname === '/api/health') return json({ ok: true, zvuk: !!env.ZVUK_TOKEN, soundcloud: !!env.SC_CLIENT_ID });
      if (url.pathname === '/api/search') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) return json({ ok: true, items: [] });
        const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const [zvuk, sc] = await Promise.all([
          zvukSearch(env, q, limit).catch(() => []),
          scSearch(env, q, limit).catch(() => []),
        ]);
        const items = [];
        for (let i = 0; i < Math.max(zvuk.length, sc.length); i += 1) {
          if (zvuk[i]) items.push(zvuk[i]);
          if (sc[i]) items.push(sc[i]);
        }
        return json({ ok: true, items });
      }
      if (url.pathname.startsWith('/api/stream/zvuk/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        const stream = await zvukStream(env, id);
        return proxyAudio(request, stream);
      }
      if (url.pathname.startsWith('/api/stream/sc/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        const stream = await scStream(env, id);
        return proxyAudio(request, stream);
      }
      return fail(404, 'NOT_FOUND', 'Маршрут не найден.');
    } catch (error) {
      return fail(502, 'UPSTREAM', String(error && error.message || error));
    }
  },
};
