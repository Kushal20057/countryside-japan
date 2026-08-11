# Ambient music page — build brief

A full-screen looping video background with a frosted-glass audio player floating
on top, playing a YouTube playlist through a hidden iframe. One HTML file, no
build step, no dependencies, deploys as a static site.

Hand this document to Claude as the spec. The **Traps** section is the point —
every item there is a bug that shipped and had to be diagnosed. Reading it first
saves the rebuild from repeating them.

---

## Shape

Single `index.html`. Inline `<style>`, inline `<script>`, no framework, no npm.
Assets in `public/`. Layers, back to front:

| Layer | Element | Notes |
|---|---|---|
| Still background | `<img>` | Always rendered. Doubles as poster **and** video fallback |
| Video background | `<video muted loop playsinline>` | Fades in over the image on `canplay` |
| Vignette | `<div>` | Radial gradient, `pointer-events:none` |
| Player deck | `<div class="glass">` | Fixed, top-centre |
| Settings + credit | `<button>` / `<div>` | Bottom corners |
| Loader | `<div>` | Covers everything until ready |
| YouTube iframe | `<div id="yt">` | 1×1, positioned off-screen |

Because the image is always mounted underneath, the video failing is a non-event —
there is no swap, no flash, no empty frame. Build it that way from the start.

## Audio

YouTube IFrame Player API, `listType: 'playlist'`, `host: 'youtube-nocookie.com'`.
The player element is 1×1 and off-screen; all controls are your own HTML calling
`playVideo()` / `nextVideo()` / `previousVideo()` / `mute()` / `seekTo()`.

Track title comes from `player.getVideoData().title`, artwork from
`https://i.ytimg.com/vi/{video_id}/mqdefault.jpg`.

> **Licensing note.** YouTube's Terms require the player be at least 200×200 and
> visibly rendered. Hiding it is common practice but is not compliant, and the
> embed can break. If that matters, render it small but genuinely visible, or
> self-host the audio.

## Glass

The look is a white sheen gradient over a **smoked** base, not clear glass:

```css
background:
  linear-gradient(175deg, rgba(255,255,255,.22), rgba(255,255,255,.04) 45%, rgba(255,255,255,.09)),
  rgba(16,17,21,.36);
backdrop-filter: blur(30px) saturate(180%) brightness(.72);
```

Clear glass looks better in isolation and fails in practice — over a bright
background, white icons and light text wash out completely. The dark tint and
`brightness(.72)` are doing legibility work, not decoration.

Two details that sell it:

- **Specular rim** — a 1px gradient border via `mask-composite: exclude`, with the
  gradient angle animated 0→360° using a registered `@property --ang`. Declare a
  static gradient first as the fallback; where `@property` is unsupported the
  animated declaration is invalid and the static one wins.
- **Sheen** — a pseudo-element over the top ~48% with an asymmetric
  `border-radius` so the highlight pools like light on a real lens.

## Config

Author-controlled constants at the top of the script — background is the author's,
only the playlist is visitor-editable:

```js
const BG_VIDEO = 'public/loop.mp4';
const BG_IMAGE = 'public/bg.jpg';
const MAX_WAIT = 6000;
const DEFAULT_PLAYLIST = 'PL…';
const SHARE_HOURS = 24;
```

Visitor's playlist persists to `localStorage`. Share links encode
`{playlist, expiry}` as base64url in a `?s=` param (~77 chars). Precedence:
share link → saved → default.

Client-side expiry is a courtesy, not a control — the timestamp travels in the
link and anyone can edit it or change their clock. Enforcing it needs a KV store
with a TTL.

---

## Traps

**1. Audible autoplay is blocked. There is no way around it.**
Chrome allows it only for sites with high engagement; Safari and Firefox
essentially never. Attempt sound, check `getPlayerState()` ~1.1s later, and if it
hasn't reached `PLAYING`/`BUFFERING`, fall back to muted playback and show a
"tap for sound" affordance. Any gesture then unmutes. Muted *video* autoplay is
always fine — that's unrelated and always works.

**2. `isMuted()` is stale immediately after `mute()`/`unMute()`.**
The API is `postMessage`-based, so commands don't apply synchronously. Reading the
value back to draw your icon leaves the button one click behind and looking
inverted. Track the state you asked for in a local variable; never read it back.

**3. A single `video.play()` is not enough.**
Setting `.src` aborts any `play()` already in flight, and that rejection is
indistinguishable from a policy block. If you `.catch(() => {})` it with no retry,
the video loads and sits frozen on frame 0 — and it will work on localhost and
fail over a real network, so you won't catch it locally. Re-attempt on `canplay`,
`loadeddata`, `visibilitychange`, first pointer input, and a few timeouts.

**4. `navigator.connection.effectiveType` lies on first paint.**
It's a rolling estimate over the browser's recent history, not this page load. It
routinely reports one tier low for the first second on a fast link. Gating video
on `'3g'` silently kills it permanently for users on perfectly good wifi. Only
block on `saveData`, genuine `2g`/`slow-2g`, or `prefers-reduced-motion` — and
listen for `connection.change` to pick it up late.

**5. Temporal dead zone, triggered only when the image is cached.**
If your "background ready" callback can fire synchronously — e.g.
`bg.complete ? markBg() : bg.addEventListener('load', markBg)` — it runs during the
script's first pass. Anything it touches that's declared with `let` further down
throws `Cannot access 'X' before initialization` and takes the *entire script*
down: stuck loader, no player, no music. Declare shared state above the background
block. This only reproduces with a warm cache, so it hides during development.

**6. Never gate a state change on a stale comparison.**
Original save handler: `list = id` unconditionally, but
`if (changed && ready) loadPlaylist(…)`. The moment those drifted apart, `changed`
computed `false` forever and every save silently did nothing but write to storage.
Just always call `loadPlaylist` — reloading the same playlist is harmless.
Also re-apply `setShuffle(true)` after each load; shuffle binds to the loaded list.

**7. You cannot detect an invalid YouTube playlist client-side.**
The IFrame API raises no error for a bad ID, `getPlaylist()` is racy (it returns
0 tracks while the player is actively playing), and the failure mode is
inconsistent — sometimes the old list is retained, sometimes emptied. Attempts to
warn the user end up rejecting valid playlists. Don't try; it needs the YouTube
Data API and a key. Validate link *format* only.

**8. Web Audio cannot reach a YouTube iframe.**
Cross-origin. An equaliser visualisation has to be a decorative animation driven
by play state. It looks identical; just don't plan around real frequency data.

**9. Vercel treats a root `public/` directory as the build output.**
Under the "Other" preset this serves your assets at `/` with no `index.html` at
all. Fix with `vercel.json`:

```json
{ "outputDirectory": ".", "cleanUrls": true }
```

---

## Other things worth doing

- Marquee the track title **only when it actually overflows** — measure
  `scrollWidth` against the container, otherwise short titles jitter pointlessly.
- Prev button: restart the track if past 3s, else go back one. That's the
  behaviour people expect.
- `onError` → skip to the next track after ~900ms. Private, region-blocked and
  embed-disabled videos are common in any real playlist and will otherwise stall.
- Suppress keyboard shortcuts while a settings input has focus.
- Cap the loader with a hard timeout so a stalled asset can't strand anyone.
- `env(safe-area-inset-*)` on anything anchored to a screen edge.
- Keep the loop short and small — 5–6s, under ~2MB. Match its resolution to the
  still, or you'll see the sharpness drop when it fades in.