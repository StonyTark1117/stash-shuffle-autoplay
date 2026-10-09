/**
 * Shuffle Plugin for Stash - v3.0.0
 * Picks a random scene, builds an autoplay queue of similar videos
 * (matched by performers → tags → studio), and feeds them into Stash's
 * native queue system for seamless playback (no page reloads, fullscreen
 * and autoplay preserved).
 */
(function () {
  "use strict";

  // ─── Constants ────────────────────────────────────────────────────────────

  const BTN_ID      = "shuffle-plugin-btn";
  const PANEL_ID    = "shuffle-plugin-panel";
  const QUEUE_LEN   = 20;

  // localStorage keys — survive page-reload navigation
  const LS_QUEUE  = "stash-shuffle-queue";   // JSON array of {id,title,screenshot}
  const LS_POS    = "stash-shuffle-pos";     // current index (string)
  const LS_ACTIVE = "stash-shuffle-active";  // "1" when queue mode is on

  // ─── GraphQL helper ───────────────────────────────────────────────────────

  async function callGQL(query, variables = {}) {
    const r = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error("GraphQL HTTP " + r.status);
    const j = await r.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
  }

  // ─── Queue storage ────────────────────────────────────────────────────────

  function getQueue()      { try { return JSON.parse(localStorage.getItem(LS_QUEUE)); } catch { return null; } }
  function setQueue(q)     { localStorage.setItem(LS_QUEUE,  JSON.stringify(q)); }
  function getPos()        { return parseInt(localStorage.getItem(LS_POS) || "0", 10); }
  function setPos(p)       { localStorage.setItem(LS_POS, String(p)); }
  function isActive()      { return localStorage.getItem(LS_ACTIVE) === "1"; }
  function setActive(v)    { v ? localStorage.setItem(LS_ACTIVE, "1") : localStorage.removeItem(LS_ACTIVE); }
  function clearQueue()    { localStorage.removeItem(LS_QUEUE); localStorage.removeItem(LS_POS); setActive(false); }

  // ─── Scene queries ────────────────────────────────────────────────────────

  const SCENE_FIELDS = `id title paths { screenshot }`;

  async function countAndRandom(sceneFilter, perPage = 1) {
    const c = await callGQL(
      `query($f: SceneFilterType) { findScenes(scene_filter: $f, filter: { per_page: 0 }) { count } }`,
      { f: sceneFilter }
    );
    const count = c.findScenes.count;
    if (!count) return [];
    const totalPages = Math.ceil(count / perPage);
    const page = Math.floor(Math.random() * totalPages) + 1;
    const d = await callGQL(
      `query($f: SceneFilterType, $ff: FindFilterType) {
         findScenes(scene_filter: $f, filter: $ff) { scenes { ${SCENE_FIELDS} } }
       }`,
      { f: sceneFilter, ff: { per_page: perPage, page } }
    );
    return d.findScenes.scenes;
  }

  async function randomScene(sceneFilter = {}) {
    const scenes = await countAndRandom(sceneFilter, 1);
    return scenes[0] ?? null;
  }

  async function getSceneDetails(id) {
    const d = await callGQL(
      `query($id: ID!) {
         findScene(id: $id) {
           id title paths { screenshot }
           performers { id }
           tags        { id }
           studio      { id }
         }
       }`,
      { id }
    );
    return d.findScene;
  }

  async function findScenesSample(sceneFilter, perPage = 80) {
    return countAndRandom(sceneFilter, perPage);
  }

  // ─── Queue building ───────────────────────────────────────────────────────

  /**
   * Builds QUEUE_LEN-item queue starting from seedId.
   * Scores by shared performers (3 pts each), tags (1 pt each), studio (1 pt).
   * Fills gaps with random scenes if not enough similar content.
   */
  async function buildQueue(seedId) {
    const seed = await getSceneDetails(seedId);
    const used   = new Set([seed.id]);
    const scores = new Map(); // id → { scene, score }

    function absorb(scenes, pts) {
      for (const s of scenes) {
        if (used.has(s.id)) continue;
        const e = scores.get(s.id);
        if (e) e.score += pts;
        else scores.set(s.id, { scene: s, score: pts });
      }
    }

    const pIds = seed.performers.map(p => p.id);
    const tIds = seed.tags.slice(0, 6).map(t => t.id);
    const sId  = seed.studio?.id;

    // Fire all three similarity queries in parallel
    const [byPerf, byTag, byStudio] = await Promise.all([
      pIds.length ? findScenesSample({ performers: { value: pIds, modifier: "INCLUDES" } }) : [],
      tIds.length ? findScenesSample({ tags:       { value: tIds, modifier: "INCLUDES" } }) : [],
      sId         ? findScenesSample({ studios:    { value: [sId], modifier: "INCLUDES" } }, 50) : [],
    ]);

    absorb(byPerf,   3);
    absorb(byTag,    1);
    absorb(byStudio, 1);

    // Sort by score descending; ties broken randomly
    const ranked = [...scores.values()]
      .sort((a, b) => b.score - a.score || Math.random() - 0.5)
      .map(e => e.scene);

    const queue = [{
      id:         seed.id,
      title:      seed.title,
      screenshot: seed.paths?.screenshot,
    }];

    for (const s of ranked.slice(0, QUEUE_LEN - 1)) {
      queue.push({ id: s.id, title: s.title, screenshot: s.paths?.screenshot });
      used.add(s.id);
    }

    // Pad with random scenes if similarity pool was too small
    let attempts = 0;
    while (queue.length < QUEUE_LEN && attempts++ < 30) {
      const r = await randomScene().catch(() => null);
      if (r && !used.has(r.id)) {
        queue.push({ id: r.id, title: r.title, screenshot: r.paths?.screenshot });
        used.add(r.id);
      }
    }

    return queue;
  }

  // ─── Navigation (using Stash's native queue) ─────────────────────────────

  /**
   * Build a Stash-native queue URL with qs= params for each scene ID.
   * Stash's SceneQueue reads these on page load and populates its internal
   * queue. With continue=true + autoplay=true, Stash handles all transitions
   * via SPA navigation (history.replace) — no page reloads, fullscreen and
   * autoplay are preserved.
   */
  function buildQueueUrl(sceneId, queue) {
    const params = [];
    // Add all scene IDs to the native queue
    for (const s of queue) {
      params.push("qs=" + encodeURIComponent(s.id));
    }
    params.push("autoplay=true");
    params.push("continue=true");
    return `/scenes/${sceneId}?${params.join("&")}`;
  }

  /**
   * Navigate to a scene. On first entry (initial shuffle click), this uses
   * window.location.href which causes a one-time page load. After that,
   * Stash's native queue handles all subsequent transitions via SPA.
   */
  function goToScene(id) {
    const queue = getQueue();
    if (queue && queue.length > 1) {
      window.location.href = buildQueueUrl(id, queue);
    } else {
      window.location.href = `/scenes/${id}?autoplay=true`;
    }
  }

  function skipToNext() {
    const queue = getQueue();
    if (!queue) return;
    const next = getPos() + 1;
    if (next >= queue.length) { clearQueue(); return; }
    setPos(next);
    goToScene(queue[next].id);
  }

  // ─── Context filter (for initial shuffle) ────────────────────────────────

  function contextFilter() {
    const path = window.location.pathname;
    const pm = path.match(/^\/performers\/(\d+)/);
    if (pm) return { performers: { value: [pm[1]], modifier: "INCLUDES_ALL" } };
    const sm = path.match(/^\/studios\/(\d+)/);
    if (sm) return { studios:    { value: [sm[1]], modifier: "INCLUDES" } };
    const tm = path.match(/^\/tags\/(\d+)/);
    if (tm) return { tags:       { value: [tm[1]], modifier: "INCLUDES_ALL" } };
    const q = new URLSearchParams(window.location.search).get("q");
    if (q && path === "/scenes") return { title: { value: q, modifier: "INCLUDES" } };
    return {};
  }

  function contextLabel() {
    const p = window.location.pathname;
    if (p.match(/^\/performers\/\d+/)) return "Shuffle this performer's scenes";
    if (p.match(/^\/studios\/\d+/))   return "Shuffle this studio's scenes";
    if (p.match(/^\/tags\/\d+/))      return "Shuffle scenes with this tag";
    if (p === "/scenes")              return "Shuffle filtered scenes";
    return isActive() ? "🔀 Shuffle (queue active)" : "Shuffle: play a random scene";
  }

  // ─── Shuffle button action ────────────────────────────────────────────────

  async function shuffle() {
    const btn = document.getElementById(BTN_ID);
    if (btn) { btn.disabled = true; btn.querySelector(".shuffle-icon").textContent = "⏳"; }

    try {
      clearQueue();
      const seed = await randomScene(contextFilter());
      if (!seed) {
        if (btn) { btn.disabled = false; btn.querySelector(".shuffle-icon").textContent = "⚠️"; }
        return;
      }

      // Build the full queue BEFORE navigating so we can pass all IDs
      // to Stash's native queue system via qs= URL params
      const queue = await buildQueue(seed.id);
      setQueue(queue);
      setActive(true);
      setPos(0);

      // Navigate with the full native queue — Stash handles autoplay,
      // continue, and all subsequent transitions via SPA
      goToScene(seed.id);
    } catch (err) {
      console.error("[Shuffle]", err);
      if (btn) {
        btn.disabled = false;
        btn.querySelector(".shuffle-icon").textContent = "⚠️";
        setTimeout(() => { if (btn) btn.querySelector(".shuffle-icon").textContent = "🔀"; }, 2500);
      }
    }
  }

  // ─── Queue panel ──────────────────────────────────────────────────────────

  function renderQueuePanel() {
    document.getElementById(PANEL_ID)?.remove();
    if (!isActive()) return;

    const queue = getQueue();
    const pos   = getPos();

    if (!queue) return; // queue is always built before navigating now

    const panel = document.createElement("div");
    panel.id        = PANEL_ID;
    panel.className = "shuffle-panel";

    // ── Header ──
    const header = document.createElement("div");
    header.className = "shuffle-panel-header";

    const titleEl = document.createElement("span");
    titleEl.className   = "shuffle-panel-title";
    titleEl.textContent = "🔀 Shuffle Queue";

    const controls = document.createElement("div");
    controls.className  = "shuffle-panel-controls";

    // Skip button
    const skipBtn = document.createElement("button");
    skipBtn.className   = "shuffle-ctrl-btn";
    skipBtn.title       = "Skip to next";
    skipBtn.textContent = "⏭";
    skipBtn.onclick     = skipToNext;

    // Collapse toggle
    const toggleBtn = document.createElement("button");
    toggleBtn.className   = "shuffle-ctrl-btn";
    toggleBtn.title       = "Collapse";
    toggleBtn.textContent = "▼";
    toggleBtn.onclick     = () => {
      const collapsed = panel.classList.toggle("shuffle-collapsed");
      toggleBtn.textContent = collapsed ? "▲" : "▼";
    };

    // Stop shuffle
    const stopBtn = document.createElement("button");
    stopBtn.className   = "shuffle-ctrl-btn shuffle-stop-btn";
    stopBtn.title       = "Stop shuffle";
    stopBtn.textContent = "✕";
    stopBtn.onclick     = () => { clearQueue(); panel.remove(); updateNavBtn(); };

    controls.append(skipBtn, toggleBtn, stopBtn);
    header.append(titleEl, controls);
    panel.appendChild(header);

    // ── Body ──
    const body = document.createElement("div");
    body.className = "shuffle-panel-body";

    // Show a window of items around the current position
    const start = Math.max(0, pos - 1);
    const end   = Math.min(queue.length, start + 7);

    for (let i = start; i < end; i++) {
      const item    = queue[i];
      const isCurrent = i === pos;

      const el = document.createElement("div");
      el.className = "shuffle-queue-item" + (isCurrent ? " shuffle-current" : "");
      el.title     = item.title || `Scene #${item.id}`;
      if (!isCurrent) {
        el.style.cursor = "pointer";
        el.onclick = () => { setPos(i); goToScene(item.id); };
      }

      // Thumbnail
      if (item.screenshot) {
        const img = document.createElement("img");
        img.src       = item.screenshot;
        img.className = "shuffle-queue-thumb";
        img.loading   = "lazy";
        el.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "shuffle-queue-thumb shuffle-thumb-placeholder";
        ph.textContent = "🎬";
        el.appendChild(ph);
      }

      // Info
      const info  = document.createElement("div");
      info.className = "shuffle-queue-info";

      const badge = document.createElement("span");
      badge.className   = "shuffle-queue-badge" + (isCurrent ? " shuffle-badge-now" : "");
      badge.textContent = isCurrent ? "▶ Now Playing" : `Up Next #${i + 1}`;

      const titleSpan = document.createElement("span");
      titleSpan.className   = "shuffle-queue-title";
      titleSpan.textContent = item.title || `Scene #${item.id}`;

      info.append(badge, titleSpan);
      el.appendChild(info);
      body.appendChild(el);
    }

    // Remaining count
    const remaining = queue.length - pos - 1;
    if (remaining > 0) {
      const rem = document.createElement("div");
      rem.className   = "shuffle-remaining";
      rem.textContent = `${remaining} more scene${remaining === 1 ? "" : "s"} in queue`;
      body.appendChild(rem);
    }

    panel.appendChild(body);
    document.body.appendChild(panel);
  }

  function updateNavBtn() {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.title = contextLabel();
  }

  // ─── Scene page logic ─────────────────────────────────────────────────────

  let _scenePageInit = false;

  function initScenePage(sceneId) {
    if (_scenePageInit) return;
    _scenePageInit = true;

    // Sync our position to the current scene
    const queue = getQueue();
    if (queue) {
      const idx = queue.findIndex(s => s.id === sceneId);
      if (idx >= 0 && idx !== getPos()) setPos(idx);
    }

    // Show our floating queue panel
    renderQueuePanel();

    // Stash's native queue (via qs= URL params) handles autoplay and
    // continue — no custom video event listeners needed.
  }

  // ─── Navbar button ────────────────────────────────────────────────────────

  function addNavbarButton() {
    if (document.getElementById(BTN_ID)) {
      updateNavBtn();
      return;
    }

    const targets = [
      ".navbar-buttons",
      ".top-nav .navbar-nav:last-child",
      "nav.navbar .d-flex",
    ];
    let container = null;
    for (const sel of targets) {
      container = document.querySelector(sel);
      if (container) break;
    }
    if (!container) return;

    const btn = document.createElement("button");
    btn.id        = BTN_ID;
    btn.className = "btn btn-secondary shuffle-plugin-button";
    btn.title     = contextLabel();
    btn.setAttribute("aria-label", "Shuffle: play a random scene");

    const icon = document.createElement("span");
    icon.className   = "shuffle-icon";
    icon.textContent = "🔀";

    btn.appendChild(icon);
    btn.addEventListener("click", shuffle);
    container.appendChild(btn);
  }

  // ─── Current scene ID from URL ────────────────────────────────────────────

  function getCurrentSceneId() {
    const m = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  // ─── Per-navigation init ──────────────────────────────────────────────────

  function init() {
    addNavbarButton();
    _scenePageInit = false;

    const sceneId = getCurrentSceneId();

    if (sceneId && isActive()) {
      // Wait for the scene player container to appear, then init
      let attempts = 0;
      const iv = setInterval(() => {
        const ready = document.querySelector(
          ".scene-player, .VideoPlayer, .player-container, video"
        );
        if (ready || ++attempts > 25) {
          clearInterval(iv);
          initScenePage(sceneId);
        }
      }, 300);
    } else if (!isActive()) {
      // Not in shuffle mode — remove any lingering panel
      document.getElementById(PANEL_ID)?.remove();
    }
  }

  // ─── Event listeners ──────────────────────────────────────────────────────

  // Stash SPA navigation — fires on every client-side route change
  if (typeof PluginApi !== "undefined" && PluginApi.Event) {
    PluginApi.Event.addEventListener("stash:location", init);
  }

  // Initial page load — wait for navbar to be rendered by React
  let _initAttempts = 0;
  const _initIv = setInterval(() => {
    const ready = document.querySelector(".navbar-buttons, .top-nav");
    if (ready || ++_initAttempts > 30) {
      clearInterval(_initIv);
      init();
    }
  }, 200);

})();
