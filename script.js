/* ══ AUTHOR SETTINGS ═════════════════════════════════════════════ */
const PRESETS = [
  { id: 'chimes', name: '🎐 Wind Chimes', src: 'backgrounds/japanese-furin-wind-chimes-moewalls-com.mp4', fallback: 'japanese-furin-wind-chimes-moewalls-com.mp4' },
  { id: 'fields', name: '🏔️ Green Fields', src: 'backgrounds/green-fields-and-peaks.3840x2160.mp4' }
];

const MAX_WAIT = 6000;               /* never sit on the loader longer than this */
const DEFAULT_PLAYLIST = 'PLFgMElN_CyHc';
const DEFAULT_SPOTIFY = '37i9dQZF1DXcBWIGoYBM5M'; /* Japanese Lofi Chill */
const SHARE_HOURS = 24;              /* how long a copied link stays good */
const SHUFFLE = true, LOOP = true;
/* ════════════════════════════════════════════════════════════════ */

const $ = s => document.querySelector(s);
const KEY = 'tuktuk:playlist';
const SPOTIFY_KEY = 'tuktuk:spotify';
const AUDIO_SRC_KEY = 'tuktuk:audio_source';
const BG_CHOICE_KEY = 'tuktuk:bg_choice';
const BG_URL_KEY = 'tuktuk:bg_url';

/* ── IndexedDB for Custom File Background ──────────────────────── */
const DB_NAME = 'tuktuk_bg_db', DB_STORE = 'custom_bg';
function getDB() {
  return new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
async function saveCustomFile(file) {
  const db = await getDB(); if (!db) return;
  return new Promise(resolve => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(file, 'user_bg');
    tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
  });
}
async function getCustomFile() {
  const db = await getDB(); if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('user_bg');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}
async function clearCustomFile() {
  const db = await getDB(); if (!db) return;
  const tx = db.transaction(DB_STORE, 'readwrite');
  tx.objectStore(DB_STORE).delete('user_bg');
}

/* base64url — keeps the ?s= payload short and URL-safe */
const b64 = {
  enc: o => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
              .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),
  dec: s => JSON.parse(new TextDecoder().decode(
              Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)))),
};

/* accepts a full youtube/youtube-music URL or a bare list id */
const listOf = v => {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{12,}$/.test(s) && !/[.\/\s]/.test(s)) return s;
  return null;                      /* looks like a link, but not a playlist */
};

/* accepts full spotify URL, URI, or bare ID */
const parseSpotify = v => {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/(?:spotify\.com\/(?:embed\/)?(playlist|album|track)\/|spotify:(playlist|album|track):)([a-zA-Z0-9]{22})/);
  if (m) return { type: m[1] || m[2], id: m[3], uri: `spotify:${m[1] || m[2]}:${m[3]}` };
  if (/^[a-zA-Z0-9]{22}$/.test(s)) return { type: 'playlist', id: s, uri: `spotify:playlist:${s}` };
  return null;
};

/* format seconds into M:SS or H:MM:SS */
function fmtTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ── audio source & playlist initialization ─────────────────────── */
let audioSource = localStorage.getItem(AUDIO_SRC_KEY) || 'youtube';
let list = DEFAULT_PLAYLIST;
let spotifyObj = parseSpotify(localStorage.getItem(SPOTIFY_KEY)) || parseSpotify(DEFAULT_SPOTIFY);
let linkExpiry = null, expired = false;

try {
  const s = new URLSearchParams(location.search).get('s');
  if (s) {
    const d = b64.dec(s);
    if (d.e && Date.now() > d.e) expired = true;
    else if (d.src === 'spotify' && parseSpotify(d.sp)) {
      audioSource = 'spotify'; spotifyObj = parseSpotify(d.sp); linkExpiry = d.e || null;
    } else if (listOf(d.p)) {
      audioSource = 'youtube'; list = listOf(d.p); linkExpiry = d.e || null;
    }
  } else {
    const savedYt = localStorage.getItem(KEY);
    if (savedYt && listOf(savedYt)) list = listOf(savedYt);
    const savedSp = localStorage.getItem(SPOTIFY_KEY);
    if (savedSp && parseSpotify(savedSp)) spotifyObj = parseSpotify(savedSp);
  }
} catch (e) { /* malformed link or storage — stay on defaults */ }

/* Declared up here, not down by the YouTube code: a cached background image
   makes markBg() fire synchronously during this first pass, and maybeStart()
   reads `ready` — a `let` below would be in the temporal dead zone and take
   the whole script down with it. */
let player, ready = false, seeking = false, pendingShuffle = false;

/* ── background management ─────────────────────────────────────── */
const bg = $('#bg'), bgv = $('#bgv');
const conn = navigator.connection;

let currentBgId = localStorage.getItem(BG_CHOICE_KEY) || 'chimes';
let customBlobUrl = null;

const holdVideo = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ||
  !!(conn && (conn.saveData || /^(2g|slow-2g)$/.test(conn.effectiveType || '')));

let bgDone = false, started = false, needsSound = false;
const markBg = () => { bgDone = true; maybeStart(); };

const nudgeVideo = () => {
  if (bgv.src && bgv.paused) {
    bgv.muted = true;
    bgv.play().then(() => bgv.classList.add('live')).catch(() => {});
  }
};

function setBgMedia(src, isImage = false) {
  if (isImage) {
    bgv.classList.remove('live');
    bgv.pause();
    bg.src = src;
    bg.style.display = 'block';
    markBg();
  } else {
    /* Keep poster fallback displayed while video buffers so screen is never black */
    bg.style.display = 'block';
    bgv.muted = true;
    bgv.playsInline = true;
    bgv.loop = true;
    bgv.preload = 'auto';

    const targetSrc = encodeURI(src);
    if (bgv.getAttribute('src') !== targetSrc && bgv.src !== targetSrc) {
      bgv.classList.remove('live');
      bgv.src = targetSrc;
      bgv.load();
    }

    const p = bgv.play();
    if (p && p.then) {
      p.then(() => {
        bgv.classList.add('live');
        markBg();
      }).catch(() => {
        nudgeVideo();
      });
    } else {
      bgv.classList.add('live');
      markBg();
    }
  }
}

async function applyBackground(id, optionalUrl = null, optionalFile = null) {
  currentBgId = id;

  document.querySelectorAll('.bg-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  if (id === 'custom_file') {
    const file = optionalFile || await getCustomFile();
    if (file) {
      if (customBlobUrl) URL.revokeObjectURL(customBlobUrl);
      customBlobUrl = URL.createObjectURL(file);
      const isImg = file.type.startsWith('image/');
      setBgMedia(customBlobUrl, isImg);
      return;
    }
  } else if (id === 'custom_url') {
    const url = optionalUrl || localStorage.getItem(BG_URL_KEY);
    if (url) {
      const isImg = /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(url);
      setBgMedia(url, isImg);
      return;
    }
  }

  const preset = PRESETS.find(p => p.id === id) || PRESETS[0];
  setBgMedia(preset.src, false);
}

applyBackground(currentBgId);

['canplay', 'canplaythrough', 'playing', 'loadeddata', 'timeupdate'].forEach(evt => {
  bgv.addEventListener(evt, () => {
    bgv.classList.add('live');
    markBg();
  });
});
bgv.addEventListener('error', () => {
  const preset = PRESETS.find(p => p.id === currentBgId);
  if (preset && preset.fallback && bgv.getAttribute('src') !== encodeURI(preset.fallback)) {
    bgv.src = encodeURI(preset.fallback);
    bgv.load();
    nudgeVideo();
    return;
  }
  bgv.classList.remove('live');
  markBg();
});

/* if the browser revises its estimate upward, pick the video up late */
if (conn) conn.addEventListener('change', nudgeVideo);

/* some browsers leave it paused after a tab switch or a wake from sleep */
document.addEventListener('visibilitychange', () => { if (!document.hidden) nudgeVideo(); });
addEventListener('pointerdown', nudgeVideo, { passive: true });

/* ── eq bars ───────────────────────────────────────────────────── */
$('#eq').innerHTML = [.9,.55,1.2,.7,1].map(d =>
  `<i style="--d:${d}s;animation-delay:-${d}s"></i>`).join('');

/* ── YouTube ───────────────────────────────────────────────────── */
const api = document.createElement('script');
api.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(api);

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('yt', {
    host: 'https://www.youtube-nocookie.com',
    playerVars: {
      listType: 'playlist', list,
      autoplay: 0, controls: 0, disablekb: 1,
      modestbranding: 1, playsinline: 1, rel: 0, fs: 0,
    },
    events: { onReady, onStateChange: onState, onError },
  });
};

function onReady() {
  if (audioSource === 'youtube') ready = true;
  if (SHUFFLE) player.setShuffle(true);
  if (LOOP) player.setLoop(true);
  if (audioSource === 'youtube') $('#deck').classList.add('ready');
  syncMeta();
  maybeStart();
}

function onState(e) {
  if (audioSource !== 'youtube') return;
  document.body.classList.toggle('playing', e.data === YT.PlayerState.PLAYING);
  $('#play-i').innerHTML = e.data === YT.PlayerState.PLAYING
    ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>'
    : '<path d="M7 4.5v15L20 12z"/>';
  $('#play').title = e.data === YT.PlayerState.PLAYING ? 'Pause' : 'Play';
  if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.CUED) syncMeta();

  if (pendingShuffle && (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.CUED)) {
    pendingShuffle = false;
    if (SHUFFLE) player.setShuffle(true);
  }
}

function onError() {
  if (audioSource !== 'youtube') return;
  setTitle('TRACK UNAVAILABLE — SKIPPING');
  setTimeout(() => player.nextVideo(), 900);
}

function syncMeta() {
  if (audioSource !== 'youtube') return;
  const d = player.getVideoData && player.getVideoData();
  if (!d || !d.title) return;
  setTitle(d.title);
  if (d.video_id) $('#art').src = `https://i.ytimg.com/vi/${d.video_id}/mqdefault.jpg`;
}

/* ── Spotify ───────────────────────────────────────────────────── */
let spotifyController = null, spotifyReady = false;
let spotifyDuration = 0, spotifyPosition = 0;

const spotifyApiScript = document.createElement('script');
spotifyApiScript.src = 'https://open.spotify.com/embed/iframe-api/v1';
document.head.appendChild(spotifyApiScript);

window.onSpotifyIframeApiReady = (IFrameAPI) => {
  const element = document.getElementById('spotify-embed');
  const options = {
    uri: spotifyObj ? spotifyObj.uri : 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    width: '100%',
    height: '152'
  };
  const callback = (EmbedController) => {
    spotifyController = EmbedController;
    spotifyController.addListener('ready', () => {
      spotifyReady = true;
      if (audioSource === 'spotify') {
        ready = true;
        $('#deck').classList.add('ready');
        setTitle('SPOTIFY PLAYLIST READY');
        $('#art').src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%231DB954"%3E%3Cpath d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.899 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.019zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.72 1.62.54.3.72 1.02.42 1.56-.3.42-1.02.6-1.56.3z"/%3E%3C/svg%3E';
        maybeStart();
      }
    });
    spotifyController.addListener('playback_update', e => {
      if (audioSource !== 'spotify') return;
      const { isPaused, isBuffering, position, duration } = e.data;
      const isPlaying = !isPaused && !isBuffering;
      document.body.classList.toggle('playing', isPlaying);
      $('#play-i').innerHTML = isPlaying
        ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>'
        : '<path d="M7 4.5v15L20 12z"/>';
      $('#play').title = isPlaying ? 'Pause' : 'Play';
      if (duration > 0 && !seeking) {
        spotifyDuration = duration / 1000;
        spotifyPosition = position / 1000;
        $('#fill').style.width = (position / duration) * 100 + '%';
        if ($('#t-curr')) $('#t-curr').textContent = fmtTime(spotifyPosition);
        if ($('#t-dur')) $('#t-dur').textContent = fmtTime(spotifyDuration);
      }
    });
  };
  IFrameAPI.createController(element, options, callback);
};

/* ── marquee: only scroll when the title actually overflows ────── */
function setTitle(text) {
  const t = $('#title');
  t.classList.remove('scroll');
  t.style.transform = '';
  t.textContent = text;
  requestAnimationFrame(() => {
    const over = t.scrollWidth - $('#screen').clientWidth + 14;
    if (over > 0) {
      t.style.setProperty('--shift', `-${over}px`);
      t.style.setProperty('--dur', `${Math.max(8, over / 22)}s`);
      t.classList.add('scroll');
    }
  });
}

/* ── progress ──────────────────────────────────────────────────── */
setInterval(() => {
  if (audioSource !== 'youtube' || !ready || seeking || !player || !player.getDuration) return;
  const dur = player.getDuration();
  const curr = player.getCurrentTime ? player.getCurrentTime() : 0;
  if (dur > 0) {
    $('#fill').style.width = (curr / dur) * 100 + '%';
    if ($('#t-curr')) $('#t-curr').textContent = fmtTime(curr);
    if ($('#t-dur')) $('#t-dur').textContent = fmtTime(dur);
  }
}, 450);

/* ── controls ──────────────────────────────────────────────────── */
$('#play').onclick = () => {
  if (audioSource === 'spotify') {
    if (spotifyController) spotifyController.togglePlay();
  } else {
    if (player && player.getPlayerState) {
      player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
    }
  }
};
$('#next').onclick = () => {
  if (audioSource === 'spotify') {
    if (spotifyController) spotifyController.next();
  } else {
    if (player && player.nextVideo) player.nextVideo();
  }
};
$('#prev').onclick = () => {
  if (audioSource === 'spotify') {
    if (spotifyController) spotifyController.previous();
  } else {
    if (player && player.previousVideo) {
      player.getCurrentTime() > 3 ? player.seekTo(0) : player.previousVideo();
    }
  }
};

const ICON_SOUND = '<path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>';
const ICON_MUTED = '<path d="M4 9v6h4l5 4V5L8 9H4zm15.5-1.1-1.4-1.4L15.7 9 13.3 6.5l-1.4 1.4L14.3 10l-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4 1.4-1.4L17.1 10z"/>';

let muted = false;

function setMuted(v) {
  muted = v;
  if (audioSource === 'youtube' && player) v ? player.mute() : player.unMute();
  $('#mute-i').innerHTML = v ? ICON_MUTED : ICON_SOUND;
  $('#mute').title = v ? 'Unmute' : 'Mute';
  $('#mute').setAttribute('aria-label', v ? 'Unmute' : 'Mute');
  if (!v && needsSound) { needsSound = false; $('#sound').classList.remove('show'); }
}

$('#mute').onclick = () => setMuted(!muted);

/* scrub */
const seek = e => {
  const r = $('#bar').getBoundingClientRect();
  const p = Math.min(1, Math.max(0, ((e.clientX ?? e.touches[0].clientX) - r.left) / r.width));
  $('#fill').style.width = p * 100 + '%';
  let dur = 0;
  if (audioSource === 'spotify') dur = spotifyDuration;
  else if (player && player.getDuration) dur = player.getDuration();
  if (dur > 0 && $('#t-curr')) $('#t-curr').textContent = fmtTime(p * dur);
  return p;
};
$('#bar').addEventListener('pointerdown', e => {
  if (!ready) return;
  seeking = true; seek(e); $('#bar').setPointerCapture(e.pointerId);
});
$('#bar').addEventListener('pointermove', e => { if (seeking) seek(e); });
$('#bar').addEventListener('pointerup', e => {
  if (!seeking) return;
  seeking = false;
  const p = seek(e);
  if (audioSource === 'spotify') {
    if (spotifyController && spotifyDuration > 0) {
      spotifyController.seek(Math.floor(p * spotifyDuration));
    }
  } else {
    if (player && player.seekTo && player.getDuration) {
      player.seekTo(p * player.getDuration(), true);
    }
  }
});

/* keyboard — ignored while typing in the settings panel */
addEventListener('keydown', e => {
  if (e.key === 'Escape') return closePanel();
  if (!ready || e.target.matches('input')) return;
  const k = { ' ': '#play', ArrowRight: '#next', ArrowLeft: '#prev', m: '#mute' }[e.key];
  if (k) { e.preventDefault(); $(k).click(); }
});

/* ── settings panel ────────────────────────────────────────────── */
const panel = $('#panel'), gear = $('#gear'), field = $('#f-playlist'), fieldSp = $('#f-spotify'), err = $('#e-playlist'), errSp = $('#e-spotify');

function showErr(msg) { err.textContent = msg; err.classList.add('show'); field.classList.add('bad'); }
function clearErr() { err.classList.remove('show'); field.classList.remove('bad'); }
field.addEventListener('input', clearErr);

function showSpotifyErr(msg) { errSp.textContent = msg; errSp.classList.add('show'); fieldSp.classList.add('bad'); }
function clearSpotifyErr() { errSp.classList.remove('show'); fieldSp.classList.remove('bad'); }
fieldSp.addEventListener('input', clearSpotifyErr);

function setAudioSourceTab(src) {
  audioSource = src;
  localStorage.setItem(AUDIO_SRC_KEY, src);
  $('#tab-yt').classList.toggle('active', src === 'youtube');
  $('#tab-spotify').classList.toggle('active', src === 'spotify');
  $('#wrap-yt').style.display = src === 'youtube' ? 'block' : 'none';
  $('#wrap-spotify').style.display = src === 'spotify' ? 'block' : 'none';
}

$('#tab-yt').onclick = () => setAudioSourceTab('youtube');
$('#tab-spotify').onclick = () => setAudioSourceTab('spotify');

function relTime(ms) {
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `${h} hour${h > 1 ? 's' : ''}`;
  const m = Math.max(1, Math.round(ms / 60000));
  return `${m} minute${m > 1 ? 's' : ''}`;
}
function linkInfo() {
  $('#linkinfo').textContent = linkExpiry
    ? `You're on a shared link — it stops working in ${relTime(linkExpiry - Date.now())}.`
    : `Copied links last ${SHARE_HOURS} hours.`;
}

function renderPresets() {
  const container = $('#bg-presets');
  if (!container) return;
  container.innerHTML = PRESETS.map(p => `
    <button class="bg-item ${p.id === currentBgId ? 'active' : ''}" data-id="${p.id}" type="button">
      ${p.name}
    </button>
  `).join('');

  container.querySelectorAll('.bg-item').forEach(btn => {
    btn.onclick = () => {
      currentBgId = btn.dataset.id;
      localStorage.setItem(BG_CHOICE_KEY, currentBgId);
      applyBackground(currentBgId);
      toast(`Background set: ${btn.textContent.trim()}`);
    };
  });
}

function openPanel() {
  field.value = list;
  fieldSp.value = localStorage.getItem(SPOTIFY_KEY) || (spotifyObj ? spotifyObj.uri : '');
  clearErr(); clearSpotifyErr(); linkInfo(); renderPresets();
  $('#f-bgurl').value = localStorage.getItem(BG_URL_KEY) || '';
  setAudioSourceTab(audioSource);
  panel.classList.add('open');
  gear.setAttribute('aria-expanded', 'true');
}
function closePanel() {
  panel.classList.remove('open');
  gear.setAttribute('aria-expanded', 'false');
}
gear.onclick = () => panel.classList.contains('open') ? closePanel() : openPanel();
document.addEventListener('pointerdown', e => {
  if (panel.classList.contains('open') && !panel.contains(e.target) && !gear.contains(e.target))
    closePanel();
});

$('#f-bgfile').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await saveCustomFile(file);
  currentBgId = 'custom_file';
  localStorage.setItem(BG_CHOICE_KEY, 'custom_file');
  applyBackground('custom_file', null, file);
  toast('Custom background uploaded!');
});

$('#f-bgurl').addEventListener('change', e => {
  const url = e.target.value.trim();
  if (!url) return;
  localStorage.setItem(BG_URL_KEY, url);
  currentBgId = 'custom_url';
  localStorage.setItem(BG_CHOICE_KEY, 'custom_url');
  applyBackground('custom_url', url);
  toast('Custom URL background applied!');
});

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

function readField() {
  const raw = field.value.trim();
  if (!raw) return list || DEFAULT_PLAYLIST;
  const id = listOf(raw);
  if (!id) { showErr("That's not a playlist link — it needs a “list=” in it."); return null; }
  return id;
}

$('#save').onclick = () => {
  clearErr();
  clearSpotifyErr();

  /* 1. Save & apply custom background URL if entered */
  const bgUrlVal = $('#f-bgurl').value.trim();
  if (bgUrlVal && (bgUrlVal !== localStorage.getItem(BG_URL_KEY) || currentBgId === 'custom_url')) {
    localStorage.setItem(BG_URL_KEY, bgUrlVal);
    currentBgId = 'custom_url';
    localStorage.setItem(BG_CHOICE_KEY, 'custom_url');
    applyBackground('custom_url', bgUrlVal);
  }

  /* 2. Save & trigger audio playback for current audio source */
  if (audioSource === 'spotify') {
    const raw = fieldSp.value.trim();
    let parsed = parseSpotify(raw);
    if (!parsed) {
      if (spotifyObj) {
        parsed = spotifyObj;
      } else {
        showSpotifyErr('Paste a valid Spotify playlist, album, or track link / ID.');
        return;
      }
    }
    spotifyObj = parsed;
    localStorage.setItem(SPOTIFY_KEY, parsed.uri);
    localStorage.setItem(AUDIO_SRC_KEY, 'spotify');
    if (player && player.pauseVideo) player.pauseVideo();
    if (spotifyController) {
      ready = true;
      $('#deck').classList.add('ready');
      spotifyController.loadUri(parsed.uri);
      spotifyController.play();
    } else {
      location.reload();
      return;
    }
  } else {
    const id = readField();
    if (!id) return;
    list = id;
    localStorage.setItem(KEY, id);
    localStorage.setItem(AUDIO_SRC_KEY, 'youtube');
    if (spotifyController && spotifyController.pause) spotifyController.pause();
    if (!ready || !player || !player.loadPlaylist) {
      location.reload();
      return;
    }
    player.loadPlaylist({ listType: 'playlist', list: id });
    if (player.playVideo) player.playVideo();
    pendingShuffle = true;
  }

  linkExpiry = null;
  history.replaceState(null, '', location.pathname);
  closePanel();
  toast('Saved & Playing!');
  nudgeVideo();
};

$('#share').onclick = async () => {
  let payload;
  if (audioSource === 'spotify') {
    const raw = fieldSp.value.trim() || (spotifyObj ? spotifyObj.uri : '');
    const parsed = parseSpotify(raw);
    if (!parsed) { showSpotifyErr('Paste a valid Spotify link.'); return; }
    payload = { src: 'spotify', sp: parsed.uri, e: Date.now() + SHARE_HOURS * 3600000 };
  } else {
    const id = readField();
    if (!id) return;
    payload = { src: 'youtube', p: id, e: Date.now() + SHARE_HOURS * 3600000 };
  }

  const url = location.origin + location.pathname + '?s=' + b64.enc(payload);
  try {
    await navigator.clipboard.writeText(url);
    toast(`Link copied — good for ${SHARE_HOURS} hours`);
  } catch (e) {
    prompt('Copy this link:', url);
  }
};

$('#reset').onclick = async () => {
  localStorage.removeItem(KEY);
  localStorage.removeItem(SPOTIFY_KEY);
  localStorage.removeItem(AUDIO_SRC_KEY);
  localStorage.removeItem(BG_CHOICE_KEY);
  localStorage.removeItem(BG_URL_KEY);
  await clearCustomFile();
  location.href = location.pathname;
};

/* ── start ─────────────────────────────────────────────────────── */
/* the loader lifts once the video can play through AND the player is up,
   whichever of those is slower — or after MAX_WAIT, so a stalled download
   can never strand anyone on the splash */
function maybeStart(force) {
  if (started) return;
  if (!force && !(bgDone && ready)) return;
  started = true;
  nudgeVideo();
  [400, 1200, 3000].forEach(ms => setTimeout(nudgeVideo, ms));   /* catch late aborts */
  if (expired) setTimeout(() => toast('That link has expired — playing the house selection.'), 900);

  /* on the forced path YouTube may still be coming up — wait for it there
     rather than holding the whole page hostage to a script that may be blocked */
  if (ready) startAudio();
  else {
    const t = setInterval(() => { if (ready) { clearInterval(t); startAudio(); } }, 150);
    setTimeout(() => clearInterval(t), 20000);
  }
}
setTimeout(() => maybeStart(true), MAX_WAIT);

/* Chrome allows audible autoplay only for sites the visitor uses often;
   everywhere else it's blocked. Ask for sound, and if the player hasn't
   moved a second later, take the muted consolation prize and say so. */
function startAudio() {
  setMuted(false);
  if (audioSource === 'youtube' && player && player.playVideo) player.playVideo();
  else if (audioSource === 'spotify' && spotifyController && spotifyController.play) spotifyController.play();
  setTimeout(() => {
    if (audioSource === 'youtube' && player && player.getPlayerState) {
      const s = player.getPlayerState();
      if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) return;
    } else if (audioSource === 'spotify') {
      return;
    }
    needsSound = true;                 /* set first — setMuted(false) clears it */
    setMuted(true);
    if (player && player.playVideo) player.playVideo();
    $('#sound').classList.add('show');
  }, 1100);
}

/* any real gesture counts as permission — the prompt is just a hint.
   the mute button is excluded because setMuted() already handles it */
function grantSound(e) {
  if (!needsSound) return;
  if (e && e.target.closest && e.target.closest('#mute')) return;
  setMuted(false);
  if (audioSource === 'youtube' && player && player.playVideo) player.playVideo();
  else if (audioSource === 'spotify' && spotifyController && spotifyController.play) spotifyController.play();
}
addEventListener('pointerdown', grantSound, { passive: true });
addEventListener('keydown', grantSound);

/* ── clock ─────────────────────────────────────────────────────── */
function updateClock() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  hours = hours % 12 || 12;
  const timeStr = `${hours}:${minutes}`;

  const timeEl = $('#clock-time');
  if (timeEl) timeEl.textContent = timeStr;
}
setInterval(updateClock, 1000);
updateClock();
