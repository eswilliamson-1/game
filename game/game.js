(function () {
  "use strict";

  var GOAL = "Explore Mossvale and discover all 5 places: the venture capital bank, the pond, the narrow pass through the rocky ridge, the roaring datacenter in the middle, and Copperline Tower, the glass skyscraper in the far northeast corner past the ridge. Equip your pistol (G or the Pistol button) to blast trees out of your way. Look at the rocket in the southeast and press L to launch it (it reloads in about a minute). Press I or the Inventory button to see what you carry and where you have been.";
  window.gameTest = { inputsHandled: 0, goal: GOAL };

  var music = window.TechnoMusic || { start: function () {}, stop: function () {}, tick: function () {}, setMuted: function () {}, isMuted: function () { return true; }, sfx: function () {}, setHum: function () {} };
  if (typeof music.sfx !== "function") music.sfx = function () {};
  if (typeof music.setHum !== "function") music.setHum = function () {};

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var stage = document.getElementById("stage");
  var goalEl = document.getElementById("goal");
  var overlay = document.getElementById("overlay");
  var overlayTitle = document.getElementById("overlayTitle");
  var startBtn = document.getElementById("startBtn");
  var musicBtn = document.getElementById("musicBtn");
  var gunBtn = document.getElementById("gunBtn");
  var invBtn = document.getElementById("invBtn");
  var invPanel = document.getElementById("invPanel");
  var invList = document.getElementById("invList");
  var invEmpty = document.getElementById("invEmpty");
  var invClose = document.getElementById("invClose");
  var placesList = document.getElementById("placesList");
  var treeCountEl = document.getElementById("treeCount");
  var placeCountEl = document.getElementById("placeCount");
  var bannerEl = document.getElementById("banner");
  var lockHint = document.getElementById("lockHint");
  var resetBtn = document.getElementById("resetBtn");
  var resetPanel = document.getElementById("resetPanel");
  var resetYes = document.getElementById("resetYes");
  var resetNo = document.getElementById("resetNo");

  goalEl.textContent = GOAL;

  // ---- account save (optional; localStorage keeps working on its own) ----
  var MUSIC_KEY = "signalSorterMusicMuted";
  var hadLocalMusicPref = false;
  try { hadLocalMusicPref = localStorage.getItem(MUSIC_KEY) !== null; } catch (e) { hadLocalMusicPref = false; }
  var musicTouched = false;
  var lastStored = null;
  var accountState = "idle"; // idle -> loading -> ready
  var resetBeforeSync = false;
  var storeTimer = null, lastStoreAt = -1e9, STORE_GAP = 8000;

  function accountApi() {
    var g = window.gameSave;
    if (g && typeof g.load === "function" && typeof g.store === "function") return g;
    return null;
  }

  function saveText() {
    return JSON.stringify({ v: 2, musicMuted: !!music.isMuted(), progress: currentProgress() });
  }

  function storeAccount() {
    var api = accountApi();
    if (!api) return;
    // never write before we've seen what the account already holds
    if (accountState !== "ready") {
      if (accountState === "idle") loadAccount();
      return;
    }
    var t = saveText();
    if (t.length > 32000 || t === lastStored) return;
    lastStored = t;
    lastStoreAt = performance.now();
    try {
      var p = api.store(t);
      if (p && typeof p.then === "function") {
        p.then(function (ok) {
          if (!ok && lastStored === t) lastStored = null;
        }, function () {
          if (lastStored === t) lastStored = null;
        });
      }
    } catch (e) {
      lastStored = null;
    }
  }

  // tree clearing can happen often, so account saves for it are spaced out
  function scheduleStore() {
    if (storeTimer !== null || !accountApi()) return;
    var wait = Math.max(0, lastStoreAt + STORE_GAP - performance.now());
    storeTimer = setTimeout(function () {
      storeTimer = null;
      storeAccount();
    }, wait);
  }

  function parseAccount(text) {
    if (typeof text !== "string" || !text || text.length > 32000) return null;
    var d;
    try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    return {
      musicMuted: typeof d.musicMuted === "boolean" ? d.musicMuted : null,
      progress: normalizeProgress(d.progress, true)
    };
  }

  function reconcileAccount(text) {
    var acct = (text === null || text === undefined) ? null : parseAccount(text);
    // the browser's own music setting wins; the account fills it in on a new browser
    if (acct && acct.musicMuted !== null && !hadLocalMusicPref && !musicTouched) {
      music.setMuted(acct.musicMuted);
      updateMusicBtn();
    }
    // whichever copy of the valley has more progress is kept
    if (acct && acct.progress && !resetBeforeSync && accountIsAhead(acct.progress, currentProgress())) {
      applyProgress(acct.progress);
      saveProgress();
      if (overlayTitle && state !== "play") overlayTitle.textContent = "Welcome back to Mossvale";
      showMessage("Your valley was loaded from your account");
    }
    if (typeof text === "string" && saveText() === text) {
      lastStored = text;
      return;
    }
    if (acct || resetBeforeSync || hasProgress(currentProgress()) || hadLocalMusicPref || musicTouched) storeAccount();
  }

  function loadAccount() {
    var api = accountApi();
    if (!api || accountState !== "idle") return;
    accountState = "loading";
    try {
      var p = api.load();
      if (p && typeof p.then === "function") {
        p.then(function (text) {
          accountState = "ready";
          try { reconcileAccount(text); } catch (e) { /* keep playing locally */ }
        }, function () { accountState = "idle"; });
      } else {
        accountState = "idle";
      }
    } catch (e) { accountState = "idle"; }
  }

  function updateMusicBtn() {
    musicBtn.textContent = music.isMuted() ? "Music: Off" : "Music: On";
  }

  function toggleMusic() {
    window.gameTest.inputsHandled++;
    musicTouched = true;
    music.setMuted(!music.isMuted());
    updateMusicBtn();
    storeAccount();
  }

  var SCALE = 2;
  var W = 300, H = 400;

  // ---- tuning (x right, y up, z forward/north) ----
  var WORLD = { x0: -32, x1: 32, z0: -32, z1: 32 };
  var START_X = 0, START_Z = -6;
  var PLAYER_R = 0.45, MOVE_SPEED = 5, TURN_SPEED = 2.2, DRAG_TURN = 0.0085;
  var MOUSE_TURN = 0.0026, MOUSE_MAX_STEP = 250;
  var CAM_BACK = 5.5, CAM_UP = 4.2, LOOK_AHEAD = 4, LOOK_Y = 0.5;
  var CAM_PITCH = Math.atan2(CAM_UP - LOOK_Y, CAM_BACK + LOOK_AHEAD);
  // vertical look: an offset added to the resting tilt, limited so the view never flips over
  var PITCH_MIN = -1.25, PITCH_MAX = 0.9, TILT_SPEED = 1.4;
  var NEAR = 0.2;
  var STICK_R = 50;
  var DRAW_DIST = 52;
  var boxRange = DRAW_DIST;
  var SHOT_RANGE = 30, GUN_Y = 1.36, SHOT_COOLDOWN = 0.3;

  // ---- colors ----
  var HAZE = [184, 206, 216];
  var GROUND_COL = [156, 156, 150];
  var ROAD_COL = [116, 118, 122], PLAZA_COL = [178, 176, 168];
  var SHORE_COL = [198, 182, 132], WATER_COL = [64, 124, 168];
  var TRUNK = [112, 80, 52], LEAF_A = [66, 132, 66], LEAF_A2 = [92, 156, 78], LEAF_B = [46, 104, 64];
  var ROCK_COLS = [[128, 128, 124], [112, 114, 116], [140, 134, 124]];
  var STONE = [124, 122, 116], STONE_TOP = [146, 144, 136];
  var BANK_STONE = [226, 220, 204], BANK_STONE2 = [198, 192, 178], BANK_ROOF = [178, 172, 160];
  var BANK_COL = [238, 234, 222], BANK_DOOR = [74, 60, 40], BANK_WIN = [66, 92, 118];
  var BANK_GOLD = [226, 186, 70], BANK_PLATE = [32, 62, 50];
  var WOOD = [134, 98, 62];
  var AV_BODY = [150, 122, 215], AV_HEAD = [226, 222, 210], AV_DARK = [34, 38, 50];
  var AV_EYE = [120, 230, 255], AV_LEG = [84, 90, 108], AV_GOLD = [255, 212, 70];
  var GUN_DARK = [58, 62, 70], GUN_GRIP = [96, 74, 54];
  var DC_WALL = [176, 180, 186], DC_WALL2 = [160, 166, 174], DC_TRIM = [64, 70, 80], DC_STRIPE = [226, 190, 60];
  var DC_GLASS = [30, 40, 54], DC_LED_G = [110, 255, 150], DC_LED_B = [110, 190, 255], DC_LED_OFF = [44, 60, 70];
  var DC_DOOR = [90, 98, 110], DC_VENT = [48, 52, 60], DC_BLADE = [150, 156, 164];
  var DC_UNIT = [196, 200, 204], DC_UNIT_TOP = [170, 176, 182], DC_FAN = [56, 60, 66], DC_PAD = [146, 148, 144];
  var LOT_EDGE = [150, 150, 144], ASPHALT = [72, 74, 78], LOT_LINE = [238, 238, 230];
  var NE_EDGE = [136, 130, 118], NE_GRAVEL = [160, 150, 130];
  // Copperline Tower
  var SKY_GLASS = [66, 128, 192], SKY_GLASS2 = [54, 112, 176], SKY_LOBBY = [40, 60, 82], SKY_LIT = [236, 222, 176];
  var SKY_STEEL = [128, 134, 142], SKY_STEEL_TOP = [160, 166, 172], SKY_COPPER = [184, 112, 64], SKY_COPPER_TOP = [204, 134, 84];
  var SKY_PLINTH = [150, 150, 146], SKY_PLINTH_TOP = [176, 174, 168], SKY_DOOR = [26, 36, 48];
  var TIRE = [28, 28, 32], CAR_GLASS = [44, 58, 74], CAR_BED = [52, 50, 48], CAR_TRIM = [36, 38, 44];
  var CAR_PAINTS = [[196, 52, 48], [48, 92, 170], [232, 232, 226], [42, 44, 50], [152, 156, 162], [44, 120, 86], [220, 172, 62], [118, 40, 58], [86, 148, 196], [206, 110, 44]];
  // launch facility
  var RK_WHITE = [238, 238, 234], RK_RED = [196, 56, 44], RK_DARK = [42, 44, 50], RK_STEEL = [118, 122, 128], RK_STEEL_TOP = [150, 152, 156];
  var RK_WINDOW = [60, 110, 170];
  var TOWER_RED = [190, 74, 48], TOWER_GRAY = [96, 100, 108];
  var PAD_COL = [192, 190, 182], PAD_EDGE = [214, 178, 52], SCORCH_COL = [62, 58, 54], TRENCH_COL = [40, 38, 36];
  var BUNKER_COL = [152, 150, 142], BUNKER_TOP = [170, 168, 160], BUNKER_GLASS = [40, 60, 80];
  var TANK_WHITE = [224, 226, 228], TANK_BAND = [56, 96, 160];
  var BEACON_ON = [255, 64, 50], BEACON_OFF = [96, 34, 30];

  // ---- deterministic random so the world is always the same ----
  var seed = 20240611;
  var SEED_STEP = 1831565813;
  function rnd() {
    seed = (seed + SEED_STEP) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function distSeg(px, pz, ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
    var t = l > 0 ? ((px - ax) * dx + (pz - az) * dz) / l : 0;
    t = Math.max(0, Math.min(1, t));
    var qx = ax + dx * t - px, qz = az + dz * t - pz;
    return Math.sqrt(qx * qx + qz * qz);
  }

  // ---- world layout ----
  // the old dirt path routes are gone; they're only kept so the trees stay where they always grew
  var PATH_HW = 0.9;
  var PATHS = [[0, -31, 0, 2], [0, 2, 8, 5.5], [0, 2, -6, 2.5], [-6, 2.5, -9, 6.5], [0, 2, 12, -4], [12, -4, 24, -10]];
  // square grid of concrete roads
  var GRID_STEP = 8, ROAD_HW = 0.9;
  var POND = { x: -15, z: 13, r: 5.6 };
  function pondR(a) { return POND.r + 0.7 * Math.sin(3 * a + 0.5) + 0.4 * Math.sin(5 * a + 1.3); }
  // the venture capital bank's lot (where the old cottage used to stand)
  var BANK = { x: 8, z: 9, hx: 2.4, hz: 2, h: 2.6 };
  var SIGN = { x: 1.8, z: -4 };

  // the datacenter: a big, noisy block right in the middle of the valley
  var DC = { x: 0, z: 0.5, hx: 4.5, hz: 3, h: 5 };
  var DC_R = { x0: DC.x - DC.hx, x1: DC.x + DC.hx, z0: DC.z - DC.hz, z1: DC.z + DC.hz };
  var DC_UNITS = [[-2.8, DC.z + 0.6], [0, DC.z + 0.6], [2.8, DC.z + 0.6]];
  var DC_N = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  var DC_HALF = [DC.hx, DC.hx, DC.hz, DC.hz];
  var DC_YAW = [Math.PI, 0, -Math.PI / 2, Math.PI / 2];
  var dcPuffT = 0;

  // the parking lot in the southwest corner
  var LOT = { x0: -30.6, x1: -8.6, z0: -30.6, z1: -8.6 };
  var STALL_W = 2.5, STALL_D = 4.6, STALL_X0 = -30.1, STALL_N = 7;
  // each row: [south edge z, which side opens onto a driving lane (+1 north, -1 south)]
  var LOT_ROWS = [[-30.1, 1], [-21.5, -1], [-16.9, 1]];
  // the rocket launch facility, in the southeast corner (twice the pad area it used to have)
  var LAUNCH = { x0: 12.8, x1: 30.4, z0: -30.4, z1: -19.0 };
  var ROCKET = { x: 19.6, z: -24.7 };
  var TOWER = { x: 17.0, z: -24.7, h: 12.6 };
  var BUNKER = { x: 27.0, z: -28.2, hx: 1.5, hz: 1.0, h: 1.3 };
  var TANKS = [[24.2, -21.0], [25.9, -21.0], [27.6, -21.0]];
  var LSIGN = { x: 13.7, z: -20.4 };
  // rocket body, bottom to top: [y0, y1, half width, color]
  var ROCKET_SEGS = [
    [1.14, 1.7, 0.78, RK_DARK], [1.7, 2.2, 0.75, RK_WHITE], [2.2, 2.5, 0.75, RK_RED], [2.5, 5.6, 0.75, RK_WHITE],
    [5.6, 5.9, 0.75, RK_RED], [5.9, 6.6, 0.75, RK_WHITE], [6.6, 7.1, 0.7, RK_DARK], [7.1, 9.4, 0.62, RK_WHITE],
    [9.4, 9.6, 0.62, RK_RED], [9.6, 10.4, 0.6, RK_WHITE], [10.4, 10.95, 0.48, RK_WHITE], [10.95, 11.4, 0.35, RK_WHITE],
    [11.4, 11.75, 0.22, RK_WHITE], [11.75, 12.05, 0.1, RK_RED]
  ];
  var ventT = 0;
  // launching: mode 0 ready on the pad, 1 in flight, 2 reloading; t counts down to the reload
  var RK_RELOAD = 60, RK_LOOK_DIST = 42, RK_GONE_Y = 150;
  var rocket = { mode: 0, y: 0, v: 0, t: 0, fxT: 0 };
  var rocketLook = false;
  // the northeast corner, cleared and graded for skyscrapers (north of the ridge)
  var NE_LOT = { x0: 17, x1: 30.6, z0: 26.4, z1: 30.6 };
  // hw, hl, wheel height, parts [lz, y0, y1, inset, hz, look]; look: 0 paint, 1 windows + painted roof, 2 truck bed, 3 trim
  var CAR_KINDS = [
    { hw: 0.85, hl: 2.1, wh: 0.34, parts: [[0, 0.34, 0.86, 0, 2.1, 0], [-0.15, 0.86, 1.32, 0.08, 0.95, 1]] },
    { hw: 0.86, hl: 2.25, wh: 0.34, parts: [[0, 0.34, 0.88, 0, 2.25, 0], [-0.45, 0.88, 1.38, 0.08, 1.45, 1]] },
    { hw: 0.95, hl: 2.2, wh: 0.4, parts: [[0, 0.4, 1.08, 0, 2.2, 0], [-0.3, 1.08, 1.72, 0.06, 1.55, 1]] },
    { hw: 0.95, hl: 2.45, wh: 0.4, parts: [[1.2, 0.4, 1.05, 0, 1.25, 0], [-1.25, 0.4, 0.98, 0, 1.2, 2], [0.65, 1.05, 1.72, 0.05, 0.6, 1]] },
    { hw: 0.9, hl: 2.05, wh: 0.26, parts: [[0, 0.26, 0.66, 0, 2.05, 0], [-0.2, 0.66, 0.98, 0.12, 0.75, 1], [-1.85, 0.66, 0.8, 0.1, 0.14, 3]] }
  ];
  var CARS = [];

  var RECTS = [], CIRCS = [], TREES = [], ROCKS = [], RIDGE = [], WALLS = [];
  var BLOCKERS = [];
  var GROUND = [], FLOWERS = [], SHADOWS = [];
  var POND_PTS = [];
  var TREE_SHADOW_COL = [26, 28, 30], TREE_SHADOW_A = 0.22;

  function blobPts(cx, cz, r, n, y, jit) {
    var p = [], i, a, rr;
    for (i = 0; i < n; i++) {
      a = i / n * Math.PI * 2;
      rr = r * (1 + (jit ? (rnd() - 0.5) * jit : 0));
      p.push([cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr]);
    }
    return p;
  }

  function isClear(x, z, m) {
    var i, d, dx, dz;
    if (x < WORLD.x0 + 2 || x > WORLD.x1 - 2 || z < WORLD.z0 + 2 || z > WORLD.z1 - 2) return false;
    for (i = 0; i < PATHS.length; i++) {
      var p = PATHS[i];
      if (distSeg(x, z, p[0], p[1], p[2], p[3]) < PATH_HW + m) return false;
    }
    dx = x - POND.x; dz = z - POND.z;
    if (Math.sqrt(dx * dx + dz * dz) < POND.r + 1.8 + m) return false;
    if (x > BANK.x - BANK.hx - m - 1 && x < BANK.x + BANK.hx + m + 1 && z > BANK.z - BANK.hz - m - 1.5 && z < BANK.z + BANK.hz + m + 1) return false;
    // keep a walkable lane all the way around the datacenter
    if (x > DC_R.x0 - m - 1.5 && x < DC_R.x1 + m + 1.5 && z > DC_R.z0 - m - 1.5 && z < DC_R.z1 + m + 1.5) return false;
    dx = x - SIGN.x; dz = z - SIGN.z;
    if (dx * dx + dz * dz < (1.5 + m) * (1.5 + m)) return false;
    dx = x - START_X; dz = z - START_Z;
    if (dx * dx + dz * dz < 16) return false;
    for (i = 0; i < RIDGE.length; i++) {
      dx = x - RIDGE[i][0]; dz = z - RIDGE[i][1];
      d = RIDGE[i][2] + m + 0.8;
      if (dx * dx + dz * dz < d * d) return false;
    }
    for (i = 0; i < ROCKS.length; i++) {
      dx = x - ROCKS[i].x; dz = z - ROCKS[i].z;
      d = ROCKS[i].s + m + 0.6;
      if (dx * dx + dz * dz < d * d) return false;
    }
    for (i = 0; i < TREES.length; i++) {
      dx = x - TREES[i].x; dz = z - TREES[i].z;
      if (dx * dx + dz * dz < 2.4 * 2.4) return false;
    }
    return true;
  }

  // a concrete road ring running all the way around a building's footprint
  function ringRoad(rc, o0, o1, y) {
    lotQuad(rc.x0 - o1, rc.z0 - o1, rc.x1 + o1, rc.z0 - o0, ROAD_COL, y, 1);
    lotQuad(rc.x0 - o1, rc.z1 + o0, rc.x1 + o1, rc.z1 + o1, ROAD_COL, y, 1);
    lotQuad(rc.x0 - o1, rc.z0 - o0, rc.x0 - o0, rc.z1 + o0, ROAD_COL, y, 1);
    lotQuad(rc.x1 + o0, rc.z0 - o0, rc.x1 + o1, rc.z1 + o0, ROAD_COL, y, 1);
  }

  (function buildWorld() {
    var i, x, z, s, h, rc, gk, gj;
    rc = { x0: BANK.x - BANK.hx, x1: BANK.x + BANK.hx, z0: BANK.z - BANK.hz, z1: BANK.z + BANK.hz };
    var bankRc = rc;
    RECTS.push(rc);
    BLOCKERS.push(rc);
    RECTS.push(DC_R);
    BLOCKERS.push(DC_R);
    CIRCS.push({ x: SIGN.x, z: SIGN.z, r: 0.2 });

    // rocky ridge with a narrow pass through the middle
    for (i = 0; i < 11; i++) {
      if (i === 5 || i === 6) continue;
      s = 0.9 + rnd() * 0.5; h = 1.2 + rnd() * 1.6;
      x = 12 + i * 1.6; z = 15 + i * 0.95 + (rnd() - 0.5) * 0.5;
      RIDGE.push([x, z, s, h, ROCK_COLS[i % 3]]);
      rc = { x0: x - s, x1: x + s, z0: z - s, z1: z + s };
      RECTS.push(rc);
      BLOCKERS.push(rc);
    }

    // scattered rocks
    for (i = 0; i < 60 && ROCKS.length < 16; i++) {
      x = WORLD.x0 + rnd() * (WORLD.x1 - WORLD.x0);
      z = WORLD.z0 + rnd() * (WORLD.z1 - WORLD.z0);
      s = 0.3 + rnd() * 0.5;
      if (!isClear(x, z, s + 0.4)) continue;
      h = s * (0.6 + rnd() * 0.5);
      rc = { x0: x - s, x1: x + s, z0: z - s, z1: z + s };
      ROCKS.push({ x: x, z: z, s: s, h: h, col: ROCK_COLS[Math.floor(rnd() * 3) % 3], rc: rc });
      RECTS.push(rc);
      if (h * 2 > GUN_Y) BLOCKERS.push(rc);
    }

    // trees: some scattered, some in small groves
    var groves = [[-22, -18], [20, -22], [-22, 24], [24, 2], [-24, -2]];
    for (i = 0; i < 260 && TREES.length < 54; i++) {
      if (i % 2 === 0) {
        x = WORLD.x0 + rnd() * (WORLD.x1 - WORLD.x0);
        z = WORLD.z0 + rnd() * (WORLD.z1 - WORLD.z0);
      } else {
        var g = groves[Math.floor(rnd() * groves.length) % groves.length];
        x = g[0] + (rnd() - 0.5) * 14;
        z = g[1] + (rnd() - 0.5) * 14;
      }
      if (!isClear(x, z, 1.0)) continue;
      s = 0.8 + rnd() * 0.5;
      var kind = rnd() < 0.45 ? 1 : 0;
      var circ = { x: x, z: z, r: 0.25 + 0.15 * s };
      var shad = { pts: blobPts(x + 0.25, z - 0.2, 1.1 * s, 8, 0.015, 0), col: TREE_SHADOW_COL, a: TREE_SHADOW_A, x: x, z: z };
      TREES.push({ id: TREES.length, x: x, z: z, s: s, kind: kind, circ: circ, shadow: shad, shadowPts0: shad.pts, gone: false });
      CIRCS.push(circ);
      SHADOWS.push(shad);
    }

    // boundary stone walls
    for (i = 0; i < 16; i++) {
      var c = WORLD.x0 + 2 + i * 4;
      WALLS.push([c, WORLD.z1, 2, 0.4 + rnd() * 0.15, 0.25]);
      WALLS.push([c, WORLD.z0, 2, 0.4 + rnd() * 0.15, 0.25]);
      WALLS.push([WORLD.x0, c, 0.25, 0.4 + rnd() * 0.15, 2]);
      WALLS.push([WORLD.x1, c, 0.25, 0.4 + rnd() * 0.15, 2]);
    }

    // square grid of gray concrete roads over the whole valley (split into blocks for even fog)
    var segs = Math.round((WORLD.x1 - WORLD.x0) / GRID_STEP);
    for (gk = -3; gk <= 3; gk++) {
      var gl = gk * GRID_STEP;
      for (gj = 0; gj < segs; gj++) {
        var a0 = WORLD.x0 + gj * GRID_STEP, a1 = a0 + GRID_STEP;
        lotQuad(gl - ROAD_HW, a0, gl + ROAD_HW, a1, ROAD_COL, 0.005, 1);
        lotQuad(a0, gl - ROAD_HW, a1, gl + ROAD_HW, ROAD_COL, 0.006, 1);
      }
    }

    // a paved plaza and a ring road around the bank
    lotQuad(bankRc.x0 - 0.7, bankRc.z0 - 0.7, bankRc.x1 + 0.7, bankRc.z1 + 0.7, PLAZA_COL, 0.007, 1);
    ringRoad(bankRc, 0.7, 1.9, 0.008);
    // a ring road around the datacenter
    ringRoad(DC_R, 1.3, 2.5, 0.008);

    // concrete pad under the datacenter
    var pm = 1.3, py = 0.011;
    GROUND.push({ pts: [[DC_R.x0 - pm, py, DC_R.z0 - pm], [DC_R.x1 + pm, py, DC_R.z0 - pm], [DC_R.x1 + pm, py, DC_R.z1 + pm], [DC_R.x0 - pm, py, DC_R.z1 + pm]], col: DC_PAD, a: 1, x: DC.x, z: DC.z, r: 0 });

    // pond: sandy shore then water
    var shore = [];
    for (i = 0; i < 24; i++) {
      var a = i / 24 * Math.PI * 2, rr = pondR(a);
      shore.push([POND.x + Math.cos(a) * (rr + 1.0), 0.01, POND.z + Math.sin(a) * (rr + 1.0)]);
      POND_PTS.push([POND.x + Math.cos(a) * rr, 0.02, POND.z + Math.sin(a) * rr]);
    }
    GROUND.push({ pts: shore, col: SHORE_COL, a: 1, x: POND.x, z: POND.z, r: 0 });
    GROUND.push({ pts: POND_PTS, col: WATER_COL, a: 1, x: POND.x, z: POND.z, r: 0 });
  })();

  var ALL_TREES = TREES.slice();

  // ---- parking lot (built after the rest so saved tree numbers stay the same) ----
  function inLot(x, z, m) {
    return x > LOT.x0 - m && x < LOT.x1 + m && z > LOT.z0 - m && z < LOT.z1 + m;
  }

  function inLaunch(x, z, m) {
    return x > LAUNCH.x0 - m && x < LAUNCH.x1 + m && z > LAUNCH.z0 - m && z < LAUNCH.z1 + m;
  }

  function lotQuad(x0, z0, x1, z1, col, y, r) {
    GROUND.push({ pts: [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], col: col, a: 1, x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: r });
  }

  function dropFrom(arr, item) {
    var k = arr.indexOf(item);
    if (k >= 0) arr.splice(k, 1);
  }

  // remove trees, rocks and flowers inside an area (trees keep their saved numbers)
  function clearArea(inside) {
    var i, t, c;
    for (i = TREES.length - 1; i >= 0; i--) {
      t = TREES[i];
      if (!inside(t.x, t.z, 1.2)) continue;
      t.paved = true;
      TREES.splice(i, 1);
      dropFrom(CIRCS, t.circ);
      dropFrom(SHADOWS, t.shadow);
    }
    for (i = ROCKS.length - 1; i >= 0; i--) {
      c = ROCKS[i];
      if (!inside(c.x, c.z, c.s + 0.4)) continue;
      ROCKS.splice(i, 1);
      dropFrom(RECTS, c.rc);
      dropFrom(BLOCKERS, c.rc);
    }
    for (i = FLOWERS.length - 1; i >= 0; i--) {
      if (inside(FLOWERS[i].x, FLOWERS[i].z, 0.3)) FLOWERS.splice(i, 1);
    }
  }

  function buildParkingLot() {
    var i, j, lw = 0.07;
    // pave over whatever grew here
    clearArea(inLot);

    // curb edge, asphalt, then white stall lines
    lotQuad(LOT.x0 - 0.35, LOT.z0 - 0.35, LOT.x1 + 0.35, LOT.z1 + 0.35, LOT_EDGE, 0.012, 0);
    lotQuad(LOT.x0, LOT.z0, LOT.x1, LOT.z1, ASPHALT, 0.013, 0);
    var xEnd = STALL_X0 + STALL_N * STALL_W;
    for (j = 0; j < LOT_ROWS.length; j++) {
      var rz = LOT_ROWS[j][0], open = LOT_ROWS[j][1];
      for (i = 0; i <= STALL_N; i++) {
        var lx = STALL_X0 + i * STALL_W;
        lotQuad(lx - lw, rz, lx + lw, rz + STALL_D, LOT_LINE, 0.015, 1);
      }
      var bz = open > 0 ? rz : rz + STALL_D;
      lotQuad(STALL_X0 - lw, bz - lw, xEnd + lw, bz + lw, LOT_LINE, 0.015, 1);
    }

    // parked vehicles (the whole lot is parking again now that the launch site has moved)
    var n = 0;
    for (j = 0; j < LOT_ROWS.length; j++) {
      var z0 = LOT_ROWS[j][0], op = LOT_ROWS[j][1];
      for (i = 0; i < STALL_N; i++) {
        if (rnd() < 0.16) continue;
        var K = CAR_KINDS[(n * 2 + Math.floor(rnd() * 3)) % CAR_KINDS.length];
        n++;
        var cx = STALL_X0 + (i + 0.5) * STALL_W + (rnd() - 0.5) * 0.24;
        var cz = z0 + STALL_D / 2 + op * Math.max(0, K.hl - 2.15);
        var car = { x: cx, z: cz, k: K, dir: rnd() < 0.75 ? -op : op, col: CAR_PAINTS[Math.floor(rnd() * CAR_PAINTS.length) % CAR_PAINTS.length] };
        car.rc = { x0: cx - K.hw - 0.03, x1: cx + K.hw + 0.03, z0: cz - K.hl, z1: cz + K.hl };
        CARS.push(car);
        RECTS.push(car.rc);
        BLOCKERS.push(car.rc);
      }
    }
  }

  buildParkingLot();

  // ---- rocket launch facility: concrete pad, launch mount, service tower, control bunker, fuel tanks ----
  function solid(x0, z0, x1, z1) {
    var rc = { x0: x0, x1: x1, z0: z0, z1: z1 };
    RECTS.push(rc);
    BLOCKERS.push(rc);
  }

  function buildLaunchSite() {
    var i, rx = ROCKET.x, rz = ROCKET.z;
    clearArea(inLaunch);
    // yellow safety border, then the pad itself
    lotQuad(LAUNCH.x0 - 0.25, LAUNCH.z0 - 0.25, LAUNCH.x1 + 0.25, LAUNCH.z1 + 0.25, PAD_EDGE, 0.017, 0);
    lotQuad(LAUNCH.x0, LAUNCH.z0, LAUNCH.x1, LAUNCH.z1, PAD_COL, 0.018, 0);
    // soot around the mount and the flame trench running east
    GROUND.push({ pts: [[rx - 2.4, 0.019, rz - 2.4], [rx + 2.4, 0.019, rz - 2.4], [rx + 2.4, 0.019, rz + 2.4], [rx - 2.4, 0.019, rz + 2.4]], col: SCORCH_COL, a: 0.45, x: rx, z: rz, r: 0 });
    lotQuad(rx + 1.6, rz - 0.7, rx + 4.2, rz + 0.7, TRENCH_COL, 0.02, 0);
    // things you can't walk through (and that stop pistol shots)
    solid(rx - 1.6, rz - 1.6, rx + 1.6, rz + 1.6);
    solid(TOWER.x - 0.7, TOWER.z - 0.7, TOWER.x + 0.7, TOWER.z + 0.7);
    solid(BUNKER.x - BUNKER.hx, BUNKER.z - BUNKER.hz, BUNKER.x + BUNKER.hx, BUNKER.z + BUNKER.hz);
    for (i = 0; i < TANKS.length; i++) solid(TANKS[i][0] - 0.6, TANKS[i][1] - 0.6, TANKS[i][0] + 0.6, TANKS[i][1] + 0.6);
    CIRCS.push({ x: LSIGN.x, z: LSIGN.z, r: 0.2 });
  }

  buildLaunchSite();

  // ---- northeast corner: demolished and graded flat for skyscrapers ----
  function inNE(x, z, m) {
    return x > NE_LOT.x0 - m && x < NE_LOT.x1 + m && z > NE_LOT.z0 - m && z < NE_LOT.z1 + m;
  }

  function clearNortheast() {
    clearArea(inNE);
    lotQuad(NE_LOT.x0 - 0.3, NE_LOT.z0 - 0.3, NE_LOT.x1 + 0.3, NE_LOT.z1 + 0.3, NE_EDGE, 0.012, 0);
    lotQuad(NE_LOT.x0, NE_LOT.z0, NE_LOT.x1, NE_LOT.z1, NE_GRAVEL, 0.013, 0);
  }

  clearNortheast();

  // ---- Copperline Tower: the first glass-and-steel skyscraper on the northeast plot ----
  var SKY = { x: 24, z: 28.6, hx: 1.9, hz: 1.1, h: 18, floors: 12 };
  var SKY_R = { x0: SKY.x - SKY.hx - 0.15, x1: SKY.x + SKY.hx + 0.15, z0: SKY.z - SKY.hz - 0.15, z1: SKY.z + SKY.hz + 0.15 };
  RECTS.push(SKY_R);
  BLOCKERS.push(SKY_R);

  // ---- places to discover ----
  var PLACES = [
    { id: "vcbank", name: "The Venture Capital Bank", rect: { x0: BANK.x - BANK.hx, x1: BANK.x + BANK.hx, z0: BANK.z - BANK.hz, z1: BANK.z + BANK.hz }, r: 2.5 },
    { id: "pond", name: "The Pond", x: POND.x, z: POND.z, r: POND.r + 2.8 },
    { id: "pass", name: "The Ridge Pass", x: 12 + 5.5 * 1.6, z: 15 + 5.5 * 0.95, r: 2.4 },
    { id: "datacenter", name: "The Datacenter", rect: DC_R, r: 2.5 },
    { id: "copperline", name: "Copperline Tower", rect: SKY_R, r: 2.5 }
  ];
  var found = {};
  var bannerT = 0;

  function foundCount() {
    var n = 0;
    for (var i = 0; i < PLACES.length; i++) if (found[PLACES[i].id]) n++;
    return n;
  }

  function placeDist(p, x, z) {
    var dx, dz;
    if (p.rect) {
      dx = Math.max(p.rect.x0 - x, 0, x - p.rect.x1);
      dz = Math.max(p.rect.z0 - z, 0, z - p.rect.z1);
    } else {
      dx = x - p.x; dz = z - p.z;
    }
    return Math.sqrt(dx * dx + dz * dz);
  }

  var player = { x: START_X, z: START_Z, yaw: 0, walk: 0, walkAmt: 0, inventory: [] };
  var camYaw = 0;
  var lookPitch = 0;
  var cam = { x: 0, y: 0, z: 0, ct: 1, st: 0, cp: 1, sp: 0, f: 300, cx: 150, cy: 200, pitch: CAM_PITCH };
  var keys = {};
  var stick = null, stickId = null, lookers = {};
  var locked = false;
  var state = "ready";
  var glowT = 0;

  function clampPitch(p) {
    if (!isFinite(p)) return 0;
    return Math.max(PITCH_MIN, Math.min(PITCH_MAX, p));
  }

  // ---- pistol state ----
  var gunOn = false, gunCool = 0, gunKick = 0, shake = 0, cleared = 0;
  var PARTS = [], FX = [], TRACERS = [];
  var aim = { tree: null, d: SHOT_RANGE, x: 0, z: 0 };

  // ---- inventory ----
  var ITEM_NAMES = { pistol: "Pistol", wood: "Wood" };
  var invOpen = false;

  function findItem(inv, id) {
    for (var i = 0; i < inv.length; i++) if (inv[i].id === id) return inv[i];
    return null;
  }

  function addItem(who, id, n) {
    var it = findItem(who.inventory, id);
    if (it) it.count += n;
    else who.inventory.push({ id: id, name: ITEM_NAMES[id] || id, count: n });
    if (who === player) renderInventory();
  }

  function renderPlaces() {
    if (!placesList) return;
    while (placesList.firstChild) placesList.removeChild(placesList.firstChild);
    for (var i = 0; i < PLACES.length; i++) {
      var p = PLACES[i], got = !!found[p.id];
      var li = document.createElement("li");
      if (!got) li.className = "unknown";
      var nm = document.createElement("span");
      nm.className = "invName";
      nm.textContent = got ? p.name : "???";
      var st = document.createElement("span");
      st.className = "invCount";
      st.textContent = got ? "Found" : "Not yet";
      li.appendChild(nm);
      li.appendChild(st);
      placesList.appendChild(li);
    }
  }

  function renderInventory() {
    while (invList.firstChild) invList.removeChild(invList.firstChild);
    var shown = 0;
    for (var i = 0; i < player.inventory.length; i++) {
      var it = player.inventory[i];
      if (it.count <= 0) continue;
      var li = document.createElement("li");
      var nm = document.createElement("span");
      nm.className = "invName";
      nm.textContent = it.name;
      var ct = document.createElement("span");
      ct.className = "invCount";
      ct.textContent = "x " + it.count;
      li.appendChild(nm);
      li.appendChild(ct);
      invList.appendChild(li);
      shown++;
    }
    if (shown === 0) {
      invEmpty.classList.remove("hidden");
      invList.classList.add("hidden");
    } else {
      invEmpty.classList.add("hidden");
      invList.classList.remove("hidden");
    }
    renderPlaces();
  }

  function updateInvBtn() {
    invBtn.textContent = invOpen ? "Inventory: Open" : "Inventory";
    if (invOpen) invBtn.classList.add("on");
    else invBtn.classList.remove("on");
  }

  function freeCursor() {
    if (locked && typeof document.exitPointerLock === "function") {
      try { document.exitPointerLock(); } catch (err) { /* ignore */ }
    }
  }

  function setInventory(open) {
    window.gameTest.inputsHandled++;
    invOpen = !!open;
    if (invOpen) {
      renderInventory();
      invPanel.classList.remove("hidden");
      freeCursor();
    } else {
      invPanel.classList.add("hidden");
    }
    updateInvBtn();
  }

  addItem(player, "pistol", 1);

  // ---- saved progress (this browser, plus the account copy when logged in) ----
  var PROGRESS_KEY = "mossvaleProgress";
  var resetOpen = false;

  function woodCount() {
    var it = findItem(player.inventory, "wood");
    return it ? it.count : 0;
  }

  function setWood(n) {
    var it = findItem(player.inventory, "wood");
    if (it) it.count = n;
    else if (n > 0) addItem(player, "wood", n);
  }

  function currentProgress() {
    var gone = [], places = [], i;
    for (i = 0; i < ALL_TREES.length; i++) if (ALL_TREES[i].gone) gone.push(ALL_TREES[i].id);
    for (i = 0; i < PLACES.length; i++) if (found[PLACES[i].id]) places.push(PLACES[i].id);
    return { cleared: cleared, wood: woodCount(), gone: gone, places: places };
  }

  function hasProgress(p) {
    return p.cleared > 0 || p.wood > 0 || p.gone.length > 0 || p.places.length > 0;
  }

  // how far along a valley is: places count for a lot, every cleared tree counts too
  function progressPoints(p) {
    return p.cleared + p.places.length * 5;
  }

  function accountIsAhead(a, mine) {
    var pa = progressPoints(a), pm = progressPoints(mine);
    if (pa !== pm) return pa > pm;
    if (a.gone.length !== mine.gone.length) return a.gone.length > mine.gone.length;
    return a.wood > mine.wood;
  }

  function saveProgress() {
    var p = currentProgress();
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify({ v: 2, cleared: p.cleared, wood: p.wood, gone: p.gone, places: p.places }));
    } catch (e) { /* storage unavailable: play on without saving */ }
  }

  // take a tree out of the world, leaving a scorch mark
  function removeTree(t) {
    var idx = TREES.indexOf(t);
    if (idx < 0) return false;
    TREES.splice(idx, 1);
    var ci = CIRCS.indexOf(t.circ);
    if (ci >= 0) CIRCS.splice(ci, 1);
    t.gone = true;
    t.shadow.col = [44, 34, 24];
    t.shadow.a = 0.45;
    t.shadow.pts = blobPts(t.x, t.z, 0.85 * t.s, 9, 0.016, 0.45);
    return true;
  }

  function safeCount(v) {
    if (typeof v !== "number" || !isFinite(v) || v < 0) return 0;
    return Math.min(1000000000, Math.floor(v));
  }

  // turn saved data (from this browser or the account) into a clean progress record
  function normalizeProgress(d, allowGone) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    var p = { cleared: safeCount(d.cleared), wood: safeCount(d.wood), gone: [], places: [] };
    var seen = {}, i, j;
    if (allowGone && Array.isArray(d.gone)) {
      for (i = 0; i < d.gone.length && i < 1000; i++) {
        var id = d.gone[i];
        if (typeof id !== "number" || id !== Math.floor(id) || id < 0 || id >= ALL_TREES.length) continue;
        if (seen[id] || ALL_TREES[id].paved) continue;
        seen[id] = true;
        p.gone.push(id);
      }
    }
    // the old cottage is gone, so a saved "cottage" discovery simply no longer matches anything
    if (Array.isArray(d.places)) {
      for (i = 0; i < d.places.length && i < 20; i++) {
        var pid = d.places[i];
        if (typeof pid !== "string") continue;
        for (j = 0; j < PLACES.length; j++) {
          if (PLACES[j].id === pid && p.places.indexOf(pid) < 0) p.places.push(pid);
        }
      }
    }
    return p;
  }

  // put every tree back, empty the wood pile and forget places (no saving here)
  function resetWorld() {
    var i, t;
    TREES.length = 0;
    for (i = 0; i < ALL_TREES.length; i++) {
      t = ALL_TREES[i];
      if (t.paved) continue;
      t.gone = false;
      t.shadow.pts = t.shadowPts0;
      t.shadow.col = TREE_SHADOW_COL;
      t.shadow.a = TREE_SHADOW_A;
      TREES.push(t);
      if (CIRCS.indexOf(t.circ) < 0) CIRCS.push(t.circ);
    }
    cleared = 0;
    setWood(0);
    found = {};
    hideBanner();
    PARTS.length = 0; FX.length = 0; TRACERS.length = 0;
    aim.tree = null;
  }

  function refreshHud() {
    updateTreeCount();
    updatePlaceCount();
    renderInventory();
  }

  function applyProgress(p) {
    var i;
    resetWorld();
    for (i = 0; i < p.gone.length; i++) removeTree(ALL_TREES[p.gone[i]]);
    for (i = 0; i < p.places.length; i++) found[p.places[i]] = true;
    cleared = p.cleared;
    setWood(p.wood);
    collide();
    refreshHud();
  }

  function loadProgress() {
    var text = null;
    try { text = localStorage.getItem(PROGRESS_KEY); } catch (e) { text = null; }
    if (typeof text !== "string" || !text || text.length > 32000) return false;
    var d;
    try { d = JSON.parse(text); } catch (e) { return false; }
    if (!d || typeof d !== "object" || (d.v !== 1 && d.v !== 2)) return false;
    // older saves were made before the datacenter moved in and the trees shifted, so only their counts carry over
    var p = normalizeProgress(d, d.v === 2);
    if (!p) return false;
    applyProgress(p);
    return hasProgress(p);
  }

  function hideBanner() {
    bannerT = 0;
    if (bannerEl) bannerEl.classList.add("hidden");
  }

  function resetValley() {
    resetWorld();
    collide();
    refreshHud();
    saveProgress();
    // the account copy is reset too (or as soon as the account answers)
    if (accountState !== "ready") resetBeforeSync = true;
    storeAccount();
  }

  function setResetConfirm(open) {
    window.gameTest.inputsHandled++;
    resetOpen = !!open;
    if (resetOpen) {
      resetPanel.classList.remove("hidden");
      freeCursor();
    } else {
      resetPanel.classList.add("hidden");
    }
  }

  // ---- discovery ----
  function updatePlaceCount() {
    if (placeCountEl) placeCountEl.textContent = "Places found: " + foundCount() + " / " + PLACES.length;
  }

  function showMessage(text) {
    if (!bannerEl) return;
    bannerEl.textContent = text;
    bannerEl.classList.remove("hidden");
    bannerT = 2.8;
  }

  function showBanner(name) {
    showMessage("Discovered: " + name);
  }

  function checkPlaces() {
    for (var i = 0; i < PLACES.length; i++) {
      var p = PLACES[i];
      if (found[p.id]) continue;
      if (placeDist(p, player.x, player.z) <= p.r) {
        found[p.id] = true;
        showBanner(p.name);
        music.sfx("chime");
        updatePlaceCount();
        renderInventory();
        saveProgress();
        storeAccount();
      }
    }
  }

  var FACES = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]];
  var LIGHT = (function () {
    var x = -0.45, y = 0.8, z = -0.4, m = Math.sqrt(x * x + y * y + z * z);
    return [x / m, y / m, z / m];
  })();

  function fogStr(col, sh, dist, a) {
    var f = (dist - 22) / 28;
    f = f < 0 ? 0 : (f > 0.92 ? 0.92 : f);
    var r = Math.round(col[0] * sh * (1 - f) + HAZE[0] * f);
    var g = Math.round(col[1] * sh * (1 - f) + HAZE[1] * f);
    var b = Math.round(col[2] * sh * (1 - f) + HAZE[2] * f);
    if (a === undefined || a >= 1) return "rgb(" + r + "," + g + "," + b + ")";
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  // ---- camera + projection ----
  function setupCamera() {
    var s = Math.sin(camYaw), c = Math.cos(camYaw);
    var pitch = CAM_PITCH + lookPitch;
    cam.x = player.x - s * CAM_BACK;
    cam.z = player.z - c * CAM_BACK;
    // the camera dips lower when looking up and rises a little when looking down
    cam.y = Math.max(1.0, Math.min(7, CAM_UP + lookPitch * 2.5));
    cam.ct = c; cam.st = s;
    cam.pitch = pitch;
    cam.cp = Math.cos(pitch); cam.sp = Math.sin(pitch);
    cam.f = Math.min(W, H);
    cam.cx = W / 2; cam.cy = H / 2;
  }

  function toCam(x, y, z) {
    var dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    var x1 = dx * cam.ct - dz * cam.st;
    var z1 = dx * cam.st + dz * cam.ct;
    return [x1, dy * cam.cp + z1 * cam.sp, z1 * cam.cp - dy * cam.sp];
  }

  function projPoly(cp) {
    var out = [], n = cp.length, i, a, b, t, aIn, bIn;
    for (i = 0; i < n; i++) {
      a = cp[i]; b = cp[(i + 1) % n];
      aIn = a[2] >= NEAR; bIn = b[2] >= NEAR;
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        t = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
      }
    }
    if (out.length < 3) return null;
    var pts = [];
    for (i = 0; i < out.length; i++) {
      var s = cam.f / out[i][2];
      pts.push(cam.cx + out[i][0] * s, cam.cy - out[i][1] * s);
    }
    return pts;
  }

  function addFace(list, a, b, c, d, nx, ny, nz, col, bias) {
    var fx = (a[0] + b[0] + c[0] + d[0]) * 0.25;
    var fy = (a[1] + b[1] + c[1] + d[1]) * 0.25;
    var fz = (a[2] + b[2] + c[2] + d[2]) * 0.25;
    var vx = fx - cam.x, vy = fy - cam.y, vz = fz - cam.z;
    if (vx * nx + vy * ny + vz * nz >= 0) return;
    var pts = projPoly([toCam(a[0], a[1], a[2]), toCam(b[0], b[1], b[2]), toCam(c[0], c[1], c[2]), toCam(d[0], d[1], d[2])]);
    if (!pts) return;
    var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    var lit = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl;
    var sh = 0.45 + 0.55 * Math.max(0, lit);
    var d2 = vx * vx + vy * vy + vz * vz;
    list.push({ k: 0, pts: pts, d: d2 * (bias || 1), col: fogStr(col, sh, Math.sqrt(d2)) });
  }

  function addBoxVerts(list, v, col, topCol, bias) {
    var cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < 8; i++) { cx += v[i][0]; cy += v[i][1]; cz += v[i][2]; }
    cx /= 8; cy /= 8; cz /= 8;
    for (var f = 0; f < 6; f++) {
      var idx = FACES[f];
      var a = v[idx[0]], b = v[idx[1]], c = v[idx[2]], d = v[idx[3]];
      var nx = (a[0] + b[0] + c[0] + d[0]) * 0.25 - cx;
      var ny = (a[1] + b[1] + c[1] + d[1]) * 0.25 - cy;
      var nz = (a[2] + b[2] + c[2] + d[2]) * 0.25 - cz;
      addFace(list, a, b, c, d, nx, ny, nz, (f === 3 && topCol) ? topCol : col, bias);
    }
  }

  function addBoxW(list, cx, cy, cz, hx, hy, hz, col, topCol, bias) {
    var dx = cx - cam.x, dy = cy - cam.y, dz = cz - cam.z;
    if (dx * dx + dz * dz > boxRange * boxRange) return;
    var r = Math.max(hx, hy, hz) * 1.8;
    var zc = (dx * cam.st + dz * cam.ct) * cam.cp - dy * cam.sp;
    if (zc < -r) return;
    var v = [];
    for (var i = 0; i < 8; i++) {
      v.push([cx + ((i & 1) ? hx : -hx), cy + ((i & 2) ? hy : -hy), cz + ((i & 4) ? hz : -hz)]);
    }
    addBoxVerts(list, v, col, topCol, bias);
  }

  function botBox(list, g, cx, cy, cz, hx, hy, hz, col, px, py, rz, rx, bias) {
    var v = [];
    var cr = Math.cos(rz || 0), sr = Math.sin(rz || 0);
    var cxr = Math.cos(rx || 0), sxr = Math.sin(rx || 0);
    var i, x, y, z, dx, dy, nz;
    for (i = 0; i < 8; i++) {
      x = cx + ((i & 1) ? hx : -hx);
      y = cy + ((i & 2) ? hy : -hy);
      z = cz + ((i & 4) ? hz : -hz);
      if (rz) {
        dx = x - px; dy = y - py;
        x = px + dx * cr - dy * sr;
        y = py + dx * sr + dy * cr;
      }
      if (rx) {
        dy = y - py;
        nz = dy * sxr + z * cxr;
        y = py + dy * cxr - z * sxr;
        z = nz;
      }
      y += g.oy;
      v.push([g.px + x * g.c + z * g.s, y, g.pz - x * g.s + z * g.c]);
    }
    addBoxVerts(list, v, col, null, bias);
  }

  function addTextBB(list, text, x, y, z, size, color) {
    var cp = toCam(x, y, z);
    if (cp[2] < NEAR + 0.1) return;
    var s = cam.f / cp[2];
    var fs = size * s;
    if (fs < 6) return;
    var dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    list.push({ k: 2, text: text, color: color, fs: Math.min(fs, 48), sx: cam.cx + cp[0] * s, sy: cam.cy - cp[1] * s, d: (dx * dx + dy * dy + dz * dz) * 0.9 });
  }

  function resize() {
    var r = stage.getBoundingClientRect();
    W = Math.max(200, r.width);
    H = Math.max(240, r.height);
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  }

  // ---- pointer lock (desktop mouse look) ----
  function lockSupported() {
    return typeof canvas.requestPointerLock === "function" && ("pointerLockElement" in document);
  }

  function isLocked() {
    return lockSupported() && document.pointerLockElement === canvas;
  }

  function requestLock() {
    if (!lockSupported() || isLocked()) return;
    try {
      var p = canvas.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(function () { /* refused: drag-to-turn still works */ });
    } catch (err) { /* refused: drag-to-turn still works */ }
  }

  function onLockChange() {
    locked = isLocked();
    if (lockHint) {
      if (locked) lockHint.classList.remove("hidden");
      else lockHint.classList.add("hidden");
    }
    if (locked) lookers = {};
  }

  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("pointerlockerror", function () {
    locked = false;
    if (lockHint) lockHint.classList.add("hidden");
  });

  document.addEventListener("mousemove", function (e) {
    if (!locked || state !== "play") return;
    var mx = e.movementX || 0, my = e.movementY || 0;
    if (mx > MOUSE_MAX_STEP) mx = MOUSE_MAX_STEP;
    else if (mx < -MOUSE_MAX_STEP) mx = -MOUSE_MAX_STEP;
    if (my > MOUSE_MAX_STEP) my = MOUSE_MAX_STEP;
    else if (my < -MOUSE_MAX_STEP) my = -MOUSE_MAX_STEP;
    if (mx !== 0 || my !== 0) {
      camYaw += mx * MOUSE_TURN;
      lookPitch = clampPitch(lookPitch + my * MOUSE_TURN);
      window.gameTest.inputsHandled++;
    }
  });

  function startGame() {
    if (state === "play") return;
    state = "play";
    overlay.classList.add("hidden");
    startBtn.blur();
    music.start();
    music.setHum(dcNoise());
  }

  // ---- pistol ----
  function updateGunBtn() {
    gunBtn.textContent = gunOn ? "Pistol: Equipped" : "Pistol: Holstered";
    if (gunOn) gunBtn.classList.add("on");
    else gunBtn.classList.remove("on");
  }

  function updateTreeCount() {
    treeCountEl.textContent = "Trees cleared: " + cleared;
  }

  function setGun(on) {
    window.gameTest.inputsHandled++;
    if (state !== "play") startGame();
    gunOn = !!on;
    gunKick = 0;
    updateGunBtn();
  }

  function armRx() { return -1.45 - gunKick * 0.35; }

  // point in the right arm's hanging frame (relative to shoulder pivot) -> world
  function gunLocal(dy, lz) {
    var rx = armRx(), c = Math.cos(rx), s = Math.sin(rx);
    var y = 1.32 + dy * c - lz * s;
    var z = dy * s + lz * c;
    var x = 0.45;
    var cy = Math.cos(player.yaw), sy = Math.sin(player.yaw);
    return [player.x + x * cy + z * sy, y, player.z - x * sy + z * cy];
  }

  function rayRect(ox, oz, dx, dz, o) {
    var tmin = 0, tmax = 1e9, t1, t2, sw;
    if (Math.abs(dx) < 1e-9) {
      if (ox < o.x0 || ox > o.x1) return -1;
    } else {
      t1 = (o.x0 - ox) / dx; t2 = (o.x1 - ox) / dx;
      if (t1 > t2) { sw = t1; t1 = t2; t2 = sw; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    if (Math.abs(dz) < 1e-9) {
      if (oz < o.z0 || oz > o.z1) return -1;
    } else {
      t1 = (o.z0 - oz) / dz; t2 = (o.z1 - oz) / dz;
      if (t1 > t2) { sw = t1; t1 = t2; t2 = sw; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    }
    if (tmax < tmin) return -1;
    return tmin;
  }

  function castAim() {
    var dx = Math.sin(camYaw), dz = Math.cos(camYaw), ox = player.x, oz = player.z;
    var best = SHOT_RANGE, hit = null, i;
    for (i = 0; i < TREES.length; i++) {
      var t = TREES[i];
      var vx = t.x - ox, vz = t.z - oz;
      var proj = vx * dx + vz * dz;
      if (proj <= 0 || proj > best + 2) continue;
      var rr = 0.8 * t.s;
      var perp2 = vx * vx + vz * vz - proj * proj;
      if (perp2 > rr * rr) continue;
      var d = proj - Math.sqrt(rr * rr - perp2);
      if (d < 0) d = 0;
      if (d < best) { best = d; hit = t; }
    }
    for (i = 0; i < BLOCKERS.length; i++) {
      var bd = rayRect(ox, oz, dx, dz, BLOCKERS[i]);
      if (bd >= 0 && bd < best) { best = bd; hit = null; }
    }
    aim.tree = hit;
    aim.d = best;
    aim.x = ox + dx * best;
    aim.z = oz + dz * best;
  }

  function blowUp(t) {
    var i;
    if (!removeTree(t)) return;

    var s = t.s, cy = 1.6 * s, leaf = t.kind ? LEAF_B : LEAF_A;
    for (i = 0; i < 22; i++) {
      var a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5, trunk = i < 5;
      PARTS.push({
        x: t.x + Math.cos(a) * 0.3, z: t.z + Math.sin(a) * 0.3,
        y: trunk ? 0.6 * s : cy + (Math.random() - 0.5) * s,
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 3 + Math.random() * 6,
        sz: (0.1 + Math.random() * 0.18) * s,
        col: trunk ? TRUNK : (i % 3 ? leaf : LEAF_A2),
        life: 1 + Math.random() * 0.6, age: 0
      });
    }
    if (PARTS.length > 220) PARTS.splice(0, PARTS.length - 220);
    FX.push({ x: t.x, y: cy, z: t.z, t: 0, dur: 0.55, r0: 0.6 * s, r1: 2.3 * s, kind: 1 });
    FX.push({ x: t.x, y: cy, z: t.z, t: -0.15, dur: 1.3, r0: 0.8 * s, r1: 2.6 * s, kind: 2 });
    shake = 0.35;
    cleared++;
    updateTreeCount();
    addItem(player, "wood", 1);
    saveProgress();
    scheduleStore();
    music.sfx("boom");
  }

  function fire() {
    if (!gunOn || state !== "play" || gunCool > 0) return;
    window.gameTest.inputsHandled++;
    gunCool = SHOT_COOLDOWN;
    castAim();
    var m = gunLocal(-1.0, 0.04);
    var hy = aim.tree ? 1.3 * aim.tree.s : GUN_Y;
    TRACERS.push({ a: m, b: [aim.x, hy, aim.z], t: 0.09 });
    FX.push({ x: m[0], y: m[1], z: m[2], t: 0, dur: 0.07, r0: 0.12, r1: 0.26, kind: 0 });
    gunKick = 1;
    music.sfx("shot");
    if (aim.tree) blowUp(aim.tree);
  }

  // ---- rocket launching ----
  // the camera looks along camYaw; the rocket counts as looked at when it sits near the middle of the view
  function lookingAtRocket() {
    var dx = ROCKET.x - player.x, dz = ROCKET.z - player.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d > RK_LOOK_DIST) return false;
    if (d < 0.01) return true;
    var dot = (dx * Math.sin(camYaw) + dz * Math.cos(camYaw)) / d;
    if (dot <= 0) return false;
    var ang = Math.acos(Math.min(1, dot));
    return ang < Math.max(0.2, Math.atan2(2.4, d));
  }

  function tryLaunch() {
    if (state !== "play") return;
    if (!lookingAtRocket()) {
      showMessage("Look at the rocket on the launch pad to launch it");
      return;
    }
    if (rocket.mode === 1) {
      showMessage("The rocket is already on its way up");
      return;
    }
    if (rocket.mode === 2) {
      showMessage("The rocket is reloading: " + Math.max(1, Math.ceil(rocket.t)) + "s left");
      return;
    }
    rocket.mode = 1;
    rocket.y = 0;
    rocket.v = 0;
    rocket.t = RK_RELOAD;
    rocket.fxT = 0;
    showMessage("Liftoff!");
    music.sfx("boom");
  }

  function updateRocket(dt) {
    rocketLook = state === "play" && lookingAtRocket();
    if (rocket.mode === 0) return;
    rocket.t -= dt;
    if (rocket.mode === 1) {
      var age = RK_RELOAD - rocket.t;
      // engines build up for a moment, then the rocket climbs faster and faster
      if (age > 0.9) {
        rocket.v += (3 + age * 3.5) * dt;
        rocket.y += rocket.v * dt;
      }
      var dx = ROCKET.x - player.x, dz = ROCKET.z - player.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < 34 && rocket.y < 60) shake = Math.max(shake, 0.14 * (1 - d / 34));
      rocket.fxT -= dt;
      if (rocket.fxT <= 0) {
        rocket.fxT = 0.06;
        FX.push({ x: ROCKET.x + (Math.random() - 0.5) * 0.4, y: rocket.y + 0.9, z: ROCKET.z + (Math.random() - 0.5) * 0.4, t: 0, dur: 0.35, r0: 0.5, r1: 1.3, kind: 1 });
        if (rocket.y < 25) {
          var a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 2.5;
          FX.push({ x: ROCKET.x + Math.cos(a) * sp, y: 0.6, z: ROCKET.z + Math.sin(a) * sp, t: 0, dur: 2.4, r0: 0.9, r1: 2.8, kind: 2 });
        } else if (Math.random() < 0.5) {
          FX.push({ x: ROCKET.x, y: rocket.y - 1, z: ROCKET.z, t: 0, dur: 2.0, r0: 0.6, r1: 2.0, kind: 4 });
        }
        if (FX.length > 260) FX.splice(0, FX.length - 260);
      }
      if (rocket.y > RK_GONE_Y) rocket.mode = 2;
    }
    if (rocket.t <= 0) {
      rocket.mode = 0;
      rocket.y = 0;
      rocket.v = 0;
      rocket.t = 0;
      showMessage("A new rocket stands on the pad, ready to launch");
      FX.push({ x: ROCKET.x, y: 1.2, z: ROCKET.z, t: 0, dur: 2.0, r0: 0.8, r1: 2.2, kind: 4 });
    }
  }

  // ---- movement ----
  function approachAngle(a, target, k) {
    var d = target - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * Math.min(1, k);
  }

  function collide() {
    var R = PLAYER_R, i, dx, dz, d2, d;
    for (i = 0; i < RECTS.length; i++) {
      var o = RECTS[i];
      var qx = Math.max(o.x0, Math.min(o.x1, player.x));
      var qz = Math.max(o.z0, Math.min(o.z1, player.z));
      dx = player.x - qx; dz = player.z - qz; d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-8) {
        d = Math.sqrt(d2);
        var push = (R - d) / d;
        player.x += dx * push; player.z += dz * push;
      } else {
        var l = player.x - o.x0, r = o.x1 - player.x, b = player.z - o.z0, t = o.z1 - player.z;
        var m = Math.min(l, r, b, t);
        if (m === l) player.x = o.x0 - R;
        else if (m === r) player.x = o.x1 + R;
        else if (m === b) player.z = o.z0 - R;
        else player.z = o.z1 + R;
      }
    }
    for (i = 0; i < CIRCS.length; i++) {
      var c = CIRCS[i], rr = R + c.r;
      dx = player.x - c.x; dz = player.z - c.z; d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      if (d2 < 1e-8) { dx = 1; dz = 0; d = 1; } else d = Math.sqrt(d2);
      player.x = c.x + dx / d * rr;
      player.z = c.z + dz / d * rr;
    }
    dx = player.x - POND.x; dz = player.z - POND.z;
    d = Math.sqrt(dx * dx + dz * dz);
    var lim = pondR(Math.atan2(dz, dx)) + R * 0.4;
    if (d < lim) {
      if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
      player.x = POND.x + dx / d * lim;
      player.z = POND.z + dz / d * lim;
    }
    var e = 0.3 + R;
    player.x = Math.max(WORLD.x0 + e, Math.min(WORLD.x1 - e, player.x));
    player.z = Math.max(WORLD.z0 + e, Math.min(WORLD.z1 - e, player.z));
  }

  function updateMovement(dt) {
    var turn = 0;
    if (keys.q) turn -= 1;
    if (keys.e) turn += 1;
    camYaw += turn * TURN_SPEED * dt;

    var tilt = 0;
    if (keys.r) tilt -= 1;
    if (keys.v) tilt += 1;
    if (tilt !== 0) lookPitch = clampPitch(lookPitch + tilt * TILT_SPEED * dt);

    var fwd = 0, str = 0;
    if (keys.w || keys.arrowup) fwd += 1;
    if (keys.s || keys.arrowdown) fwd -= 1;
    if (keys.d || keys.arrowright) str += 1;
    if (keys.a || keys.arrowleft) str -= 1;
    if (stick) {
      var sm = Math.sqrt(stick.dx * stick.dx + stick.dy * stick.dy);
      if (sm > 0.12) { fwd -= stick.dy; str += stick.dx; }
    }
    var m = Math.sqrt(fwd * fwd + str * str);
    if (m > 1) { fwd /= m; str /= m; m = 1; }
    var moving = m > 0.05;
    if (moving) {
      var s = Math.sin(camYaw), c = Math.cos(camYaw);
      var vx = s * fwd + c * str, vz = c * fwd - s * str;
      player.x += vx * MOVE_SPEED * dt;
      player.z += vz * MOVE_SPEED * dt;
      collide();
      if (!gunOn) player.yaw = approachAngle(player.yaw, Math.atan2(vx, vz), dt * 12);
      player.walk += dt * 9 * m;
    }
    if (gunOn) player.yaw = approachAngle(player.yaw, camYaw, dt * 14);
    player.walkAmt += ((moving ? m : 0) - player.walkAmt) * Math.min(1, dt * 10);
  }

  // how loud the datacenter is where the player stands (never fully silent)
  function dcNoise() {
    var dx = Math.max(DC_R.x0 - player.x, 0, player.x - DC_R.x1);
    var dz = Math.max(DC_R.z0 - player.z, 0, player.z - DC_R.z1);
    var d = Math.sqrt(dx * dx + dz * dz);
    var near = Math.max(0, 1 - d / 26);
    return 0.2 + 0.8 * near * near;
  }

  function updateDatacenter(dt) {
    dcPuffT -= dt;
    if (dcPuffT <= 0) {
      dcPuffT = 0.3;
      var u = DC_UNITS[Math.floor(Math.random() * DC_UNITS.length) % DC_UNITS.length];
      FX.push({ x: u[0] + (Math.random() - 0.5) * 0.6, y: DC.h + 1.1, z: u[1] + (Math.random() - 0.5) * 0.5, t: 0, dur: 2.2, r0: 0.35, r1: 1.3, kind: 4 });
    }
  }

  // the fueled rocket vents a little cold vapor now and then
  function updateLaunchSite(dt) {
    ventT -= dt;
    if (ventT > 0) return;
    ventT = 0.5;
    if (rocket.mode !== 0) return;
    var dx = ROCKET.x - player.x, dz = ROCKET.z - player.z;
    if (dx * dx + dz * dz > 46 * 46) return;
    var side = Math.random() < 0.5 ? -1 : 1;
    if (Math.random() < 0.7) {
      FX.push({ x: ROCKET.x + side * (0.9 + Math.random() * 0.4), y: 1.0, z: ROCKET.z + (Math.random() - 0.5) * 1.2, t: 0, dur: 1.8, r0: 0.3, r1: 1.1, kind: 4 });
    } else {
      FX.push({ x: ROCKET.x + side * 0.75, y: 6.85, z: ROCKET.z, t: 0, dur: 1.6, r0: 0.2, r1: 0.8, kind: 4 });
    }
  }

  function updateEffects(dt) {
    var i;
    if (gunCool > 0) gunCool -= dt;
    gunKick = Math.max(0, gunKick - dt * 7);
    shake = Math.max(0, shake - dt * 1.2);
    for (i = PARTS.length - 1; i >= 0; i--) {
      var p = PARTS[i];
      p.age += dt;
      if (p.age > p.life) { PARTS.splice(i, 1); continue; }
      p.vy -= 16 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < p.sz) {
        p.y = p.sz;
        p.vy *= -0.35;
        p.vx *= 0.6; p.vz *= 0.6;
      }
    }
    for (i = FX.length - 1; i >= 0; i--) {
      FX[i].t += dt;
      if (FX[i].t > FX[i].dur) FX.splice(i, 1);
    }
    for (i = TRACERS.length - 1; i >= 0; i--) {
      TRACERS[i].t -= dt;
      if (TRACERS[i].t <= 0) TRACERS.splice(i, 1);
    }
    if (bannerT > 0) {
      bannerT -= dt;
      if (bannerT <= 0) hideBanner();
    }
  }

  function update(dt) {
    glowT += dt;
    if (state === "play") {
      updateMovement(dt);
      checkPlaces();
      music.setHum(dcNoise());
    }
    updateEffects(dt);
    updateDatacenter(dt);
    updateLaunchSite(dt);
    updateRocket(dt);
    if (gunOn) castAim();
  }

  // ---- drawing ----
  function groundPoly(pts, col, a) {
    var cp = [], n = pts.length, i;
    for (i = 0; i < n; i++) cp.push(toCam(pts[i][0], pts[i][1], pts[i][2]));
    var s = projPoly(cp);
    if (!s) return;
    var h = pts[Math.floor(n / 2)];
    var mx = (pts[0][0] + h[0]) * 0.5 - cam.x, mz = (pts[0][2] + h[2]) * 0.5 - cam.z, my = cam.y;
    ctx.fillStyle = fogStr(col, 1, Math.sqrt(mx * mx + mz * mz + my * my), a);
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    for (var j = 2; j < s.length; j += 2) ctx.lineTo(s[j], s[j + 1]);
    ctx.closePath();
    ctx.fill();
  }

  function drawGroundItem(g, maxD) {
    if (maxD) {
      var dx = g.x - player.x, dz = g.z - player.z;
      if (dx * dx + dz * dz > maxD * maxD) return;
    }
    groundPoly(g.pts, g.col, g.a);
  }

  function drawGround() {
    var i;
    for (i = 0; i < GROUND.length; i++) drawGroundItem(GROUND[i], GROUND[i].r ? 50 : 0);

    // pond shimmer
    var k = 0.55 + Math.sin(glowT * 1.3) * 0.08;
    var rip = [];
    for (i = 0; i < POND_PTS.length; i += 2) {
      var p = POND_PTS[i];
      rip.push([POND.x + (p[0] - POND.x) * k, 0.025, POND.z + (p[2] - POND.z) * k]);
    }
    groundPoly(rip, [120, 176, 210], 0.35);

    for (i = 0; i < FLOWERS.length; i++) drawGroundItem(FLOWERS[i], 26);
    for (i = 0; i < SHADOWS.length; i++) drawGroundItem(SHADOWS[i], 40);

    var bob = player.walkAmt * 0.05;
    var sr = 0.6 * (1 - bob), sh = [];
    for (i = 0; i < 12; i++) {
      var a = i / 12 * Math.PI * 2;
      sh.push([player.x + Math.cos(a) * sr, 0.03, player.z + Math.sin(a) * sr]);
    }
    groundPoly(sh, [0, 0, 0], 0.32);
  }

  function addBot(list) {
    var wa = player.walkAmt, ws = Math.sin(player.walk);
    var bob = Math.sin(glowT * 2.4) * 0.025 * (1 - wa) + Math.abs(Math.cos(player.walk)) * 0.07 * wa;
    var g = { px: player.x, pz: player.z, c: Math.cos(player.yaw), s: Math.sin(player.yaw), oy: bob };
    var legSwing = ws * 0.7 * wa;
    botBox(list, g, -0.15, 0.36, 0, 0.11, 0.36, 0.13, AV_LEG, -0.15, 0.72, 0, legSwing);
    botBox(list, g, 0.15, 0.36, 0, 0.11, 0.36, 0.13, AV_LEG, 0.15, 0.72, 0, -legSwing);
    botBox(list, g, 0, 1.05, 0, 0.33, 0.33, 0.2, AV_BODY);
    botBox(list, g, 0, 1.1, 0.215, 0.11, 0.08, 0.02, AV_GOLD);
    botBox(list, g, 0, 1.08, -0.26, 0.2, 0.22, 0.06, AV_DARK);
    botBox(list, g, 0, 1.15, -0.325, 0.07, 0.05, 0.01, (Math.sin(glowT * 4) > 0) ? AV_GOLD : AV_EYE);
    var idle = 0.08 + Math.sin(glowT * 2.4) * 0.03;
    var armSwing = ws * 0.55 * wa;
    if (gunOn) {
      var rx = armRx();
      botBox(list, g, 0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, 0.45, 1.32, 0, rx);
      // generic handgun held in the right hand (barrel + grip)
      botBox(list, g, 0.45, 0.52, 0.04, 0.06, 0.18, 0.07, GUN_DARK, 0.45, 1.32, 0, rx);
      botBox(list, g, 0.45, 0.68, -0.08, 0.05, 0.05, 0.1, GUN_GRIP, 0.45, 1.32, 0, rx);
    } else {
      botBox(list, g, 0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, 0.45, 1.32, idle, armSwing);
    }
    botBox(list, g, -0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, -0.45, 1.32, -idle, -armSwing);
    botBox(list, g, 0, 1.62, 0, 0.27, 0.27, 0.27, AV_HEAD);
    botBox(list, g, 0, 1.64, 0.28, 0.22, 0.09, 0.02, AV_DARK);
    botBox(list, g, -0.1, 1.64, 0.305, 0.05, 0.04, 0.012, AV_EYE);
    botBox(list, g, 0.1, 1.64, 0.305, 0.05, 0.04, 0.012, AV_EYE);
    botBox(list, g, 0, 1.98, 0, 0.025, 0.09, 0.025, AV_DARK);
    botBox(list, g, 0, 2.11, 0, 0.06, 0.06, 0.06, AV_GOLD);
  }

  function addTree(list, t) {
    var s = t.s, x = t.x, z = t.z;
    var dx = x - cam.x, dz = z - cam.z;
    if (dx * dx + dz * dz > DRAW_DIST * DRAW_DIST) return;
    addBoxW(list, x, 0.6 * s, z, 0.17 * s, 0.6 * s, 0.17 * s, TRUNK);
    if (t.kind === 0) {
      addBoxW(list, x, 1.2 * s + 0.7 * s, z, 0.85 * s, 0.7 * s, 0.85 * s, LEAF_A, LEAF_A2);
      addBoxW(list, x, 2.6 * s + 0.3 * s, z, 0.5 * s, 0.3 * s, 0.5 * s, LEAF_A2);
    } else {
      addBoxW(list, x, 1.0 * s + 0.45 * s, z, 0.9 * s, 0.45 * s, 0.9 * s, LEAF_B);
      addBoxW(list, x, 1.9 * s + 0.4 * s, z, 0.62 * s, 0.4 * s, 0.62 * s, LEAF_B);
      addBoxW(list, x, 2.7 * s + 0.35 * s, z, 0.34 * s, 0.35 * s, 0.34 * s, LEAF_B);
    }
  }

  // a parked, unbranded vehicle built from a few boxes
  function addCar(list, c) {
    var dx = c.x - cam.x, dz = c.z - cam.z;
    if (dx * dx + dz * dz > DRAW_DIST * DRAW_DIST) return;
    var K = c.k, d = c.dir, wz = K.hl - 0.65, i, p, col, top;
    addBoxW(list, c.x, K.wh / 2, c.z + wz, K.hw + 0.03, K.wh / 2, K.wh * 0.95, TIRE);
    addBoxW(list, c.x, K.wh / 2, c.z - wz, K.hw + 0.03, K.wh / 2, K.wh * 0.95, TIRE);
    for (i = 0; i < K.parts.length; i++) {
      p = K.parts[i];
      col = c.col; top = null;
      if (p[5] === 1) { col = CAR_GLASS; top = c.col; }
      else if (p[5] === 2) top = CAR_BED;
      else if (p[5] === 3) col = CAR_TRIM;
      addBoxW(list, c.x, (p[1] + p[2]) / 2, c.z + p[0] * d, K.hw - p[3], (p[2] - p[1]) / 2, p[4], col, top);
    }
  }

  // the venture capital bank: a stately stone hall with columns, a portico and a gold growth chart on the roof
  function addBank(list) {
    var b = BANK, fz = b.z - b.hz, top = b.h, base = 0.25;
    var wz0 = fz + 0.7, wz1 = b.z + b.hz - 0.1;
    var wallHy = (top - base) / 2, wallY = base + wallHy;
    var dx = b.x - cam.x, dz = b.z - cam.z;
    if (dx * dx + dz * dz > DRAW_DIST * DRAW_DIST) return;
    // plinth and front steps
    addBoxW(list, b.x, base / 2, b.z, b.hx, base / 2, b.hz, BANK_STONE2, BANK_STONE);
    addBoxW(list, b.x, 0.08, fz - 0.22, b.hx - 0.5, 0.08, 0.22, BANK_STONE2, BANK_STONE, 0.95);
    // main hall, set back behind the portico
    addBoxW(list, b.x, wallY, (wz0 + wz1) / 2, b.hx - 0.15, wallHy, (wz1 - wz0) / 2, BANK_STONE);
    // heavy bronze doors and tall windows on the front wall
    addBoxW(list, b.x, base + 0.75, wz0 - 0.04, 0.42, 0.75, 0.04, BANK_DOOR, null, 0.85);
    addBoxW(list, b.x, base + 1.53, wz0 - 0.05, 0.48, 0.04, 0.05, BANK_GOLD, null, 0.84);
    addBoxW(list, b.x - 1.35, base + 1.15, wz0 - 0.03, 0.24, 0.6, 0.03, BANK_WIN, null, 0.85);
    addBoxW(list, b.x + 1.35, base + 1.15, wz0 - 0.03, 0.24, 0.6, 0.03, BANK_WIN, null, 0.85);
    // side windows
    for (var k = -1; k <= 1; k += 2) {
      var sx = b.x + k * (b.hx - 0.15) + k * 0.03;
      addBoxW(list, sx, base + 1.15, b.z + 0.1, 0.03, 0.6, 0.28, BANK_WIN, null, 0.85);
      addBoxW(list, sx, base + 1.15, b.z + 1.1, 0.03, 0.6, 0.28, BANK_WIN, null, 0.85);
    }
    // portico columns with bases and capitals
    var cols = [-1.95, -0.75, 0.75, 1.95], cz = fz + 0.3;
    for (var i = 0; i < cols.length; i++) {
      var cx = b.x + cols[i];
      addBoxW(list, cx, wallY, cz, 0.16, wallHy, 0.16, BANK_COL, null, 0.95);
      addBoxW(list, cx, base + 0.08, cz, 0.24, 0.08, 0.24, BANK_STONE2, null, 0.94);
      addBoxW(list, cx, top - 0.08, cz, 0.24, 0.08, 0.24, BANK_STONE2, null, 0.94);
    }
    // entablature with the name plate
    addBoxW(list, b.x, top + 0.2, b.z, b.hx + 0.1, 0.2, b.hz + 0.1, BANK_STONE2, BANK_STONE);
    addBoxW(list, b.x, top + 0.2, fz - 0.12, b.hx - 0.3, 0.14, 0.03, BANK_PLATE, null, 0.85);
    addTextBB(list, "VENTURE CAPITAL BANK", b.x, top + 0.2, fz - 0.17, 0.17, "rgb(240,206,110)");
    // stepped pediment roof
    addBoxW(list, b.x, top + 0.55, b.z, b.hx - 0.15, 0.15, b.hz, BANK_ROOF);
    addBoxW(list, b.x, top + 0.82, b.z, b.hx - 0.85, 0.12, b.hz - 0.2, BANK_ROOF);
    addBoxW(list, b.x, top + 1.03, b.z, b.hx - 1.55, 0.09, b.hz - 0.4, BANK_ROOF);
    // gold growth chart on the roof (always going up)
    var pulse = 0.04 * Math.sin(glowT * 2);
    addBoxW(list, b.x - 0.4, top + 1.12 + 0.12, b.z, 0.12, 0.12, 0.12, BANK_GOLD);
    addBoxW(list, b.x, top + 1.12 + 0.24, b.z, 0.12, 0.24, 0.12, BANK_GOLD);
    addBoxW(list, b.x + 0.4, top + 1.12 + 0.38 + pulse, b.z, 0.12, 0.38 + pulse, 0.12, BANK_GOLD);
  }

  // ---- Copperline Tower drawing: blue glass floors, a steel frame, a lit top floor and a copper crown ----
  function addSkyscraper(list) {
    var s = SKY, dx = s.x - cam.x, dz = s.z - cam.z, d2 = dx * dx + dz * dz;
    if (d2 > 88 * 88) return;
    var near = d2 < 34 * 34, fl = s.h / s.floors, i, k, y0, gcol;
    var ex = s.hx - 0.02, ez = s.hz - 0.02;
    // tall enough to show on the skyline from across the valley
    boxRange = 90;
    // stone plinth
    addBoxW(list, s.x, 0.1, s.z, s.hx + 0.2, 0.1, s.hz + 0.2, SKY_PLINTH, SKY_PLINTH_TOP);
    for (i = 0; i < s.floors; i++) {
      y0 = i * fl;
      if (i === 0) gcol = SKY_LOBBY;
      else if (i === s.floors - 1) gcol = SKY_LIT;
      else gcol = i % 2 ? SKY_GLASS2 : SKY_GLASS;
      addBoxW(list, s.x, y0 + fl / 2, s.z, s.hx - 0.06, fl / 2, s.hz - 0.06, gcol, null, 1.03);
      // steel floor band
      addBoxW(list, s.x, y0 + fl, s.z, s.hx + 0.03, 0.07, s.hz + 0.03, SKY_STEEL, SKY_STEEL_TOP, 0.97);
      if (near) {
        // corner columns and center mullions, floor by floor
        for (k = 0; k < 4; k++) {
          addBoxW(list, s.x + ((k & 1) ? ex : -ex), y0 + fl / 2, s.z + ((k & 2) ? ez : -ez), 0.1, fl / 2, 0.1, SKY_STEEL, null, 0.96);
        }
        addBoxW(list, s.x, y0 + fl / 2, s.z - s.hz + 0.04, 0.05, fl / 2, 0.05, SKY_STEEL, null, 0.96);
        addBoxW(list, s.x, y0 + fl / 2, s.z + s.hz - 0.04, 0.05, fl / 2, 0.05, SKY_STEEL, null, 0.96);
      }
    }
    if (!near) {
      for (k = 0; k < 4; k++) {
        addBoxW(list, s.x + ((k & 1) ? ex : -ex), s.h / 2, s.z + ((k & 2) ? ez : -ez), 0.1, s.h / 2, 0.1, SKY_STEEL, null, 0.96);
      }
    } else {
      // glass entrance doors
      addBoxW(list, s.x, 0.6, s.z - s.hz - 0.01, 0.45, 0.6, 0.04, SKY_DOOR, null, 0.9);
      addBoxW(list, s.x, 1.25, s.z - s.hz - 0.03, 0.6, 0.05, 0.08, SKY_COPPER, null, 0.89);
    }
    // copper crown, rooftop plant and a spire with a blinking light
    addBoxW(list, s.x, s.h + 0.35, s.z, s.hx - 0.25, 0.28, s.hz - 0.2, SKY_COPPER, SKY_COPPER_TOP);
    addBoxW(list, s.x, s.h + 0.9, s.z, s.hx - 0.8, 0.28, s.hz - 0.45, SKY_STEEL, SKY_STEEL_TOP);
    addBoxW(list, s.x, s.h + 1.3, s.z, 0.35, 0.12, 0.35, SKY_COPPER, SKY_COPPER_TOP);
    addBoxW(list, s.x, s.h + 2.7, s.z, 0.05, 1.3, 0.05, SKY_STEEL);
    addBoxW(list, s.x, s.h + 4.08, s.z, 0.1, 0.1, 0.1, Math.sin(glowT * 2.6) > 0.2 ? BEACON_ON : BEACON_OFF);
    boxRange = DRAW_DIST;
    // the name, lit up on the top floor
    var ty = s.h - fl / 2;
    if (cam.z < s.z - s.hz) addTextBB(list, "COPPERLINE TOWER", s.x, ty, s.z - s.hz - 0.15, 0.32, "rgb(255,196,140)");
    else if (cam.z > s.z + s.hz) addTextBB(list, "COPPERLINE TOWER", s.x, ty, s.z + s.hz + 0.15, 0.32, "rgb(255,196,140)");
  }

  // ---- rocket launch facility drawing ----
  function addLaunchSite(list) {
    var rx = ROCKET.x, rz = ROCKET.z, i, k, s;
    var dx = rx - cam.x, dz = rz - cam.z;
    if (dx * dx + dz * dz > (DRAW_DIST + 10) * (DRAW_DIST + 10)) return;

    // launch mount, hold-down clamps and engine bells
    addBoxW(list, rx, 0.35, rz, 1.6, 0.35, 1.6, RK_STEEL, RK_STEEL_TOP);
    for (k = 0; k < 4; k++) {
      var sx = (k & 1) ? 1 : -1, sz = (k & 2) ? 1 : -1;
      addBoxW(list, rx + sx * 0.98, 0.95, rz + sz * 0.98, 0.12, 0.25, 0.12, RK_DARK);
      if (rocket.mode === 0) addBoxW(list, rx + sx * 0.35, 0.92, rz + sz * 0.35, 0.22, 0.22, 0.22, RK_DARK);
    }

    // the rocket body, stacked from the base up to the nose cone (it rises when launched)
    if (rocket.mode !== 2) {
      var oy = rocket.y;
      if (rocket.mode === 1) {
        for (k = 0; k < 4; k++) {
          addBoxW(list, rx + ((k & 1) ? 0.35 : -0.35), 0.92 + oy, rz + ((k & 2) ? 0.35 : -0.35), 0.22, 0.22, 0.22, RK_DARK);
        }
      }
      for (i = 0; i < ROCKET_SEGS.length; i++) {
        s = ROCKET_SEGS[i];
        addBoxW(list, rx, (s[0] + s[1]) / 2 + oy, rz, s[2], (s[1] - s[0]) / 2, s[2], s[3]);
      }
      // fins and a round window on the upper stage
      addBoxW(list, rx - 1.05, 1.72 + oy, rz, 0.3, 0.58, 0.05, RK_RED);
      addBoxW(list, rx + 1.05, 1.72 + oy, rz, 0.3, 0.58, 0.05, RK_RED);
      addBoxW(list, rx, 1.72 + oy, rz - 1.05, 0.05, 0.58, 0.3, RK_RED);
      addBoxW(list, rx, 1.72 + oy, rz + 1.05, 0.05, 0.58, 0.3, RK_RED);
      addBoxW(list, rx, 8.3 + oy, rz - 0.64, 0.22, 0.22, 0.02, RK_WINDOW, null, 0.9);
      addBoxW(list, rx + 0.64, 8.3 + oy, rz, 0.02, 0.22, 0.22, RK_WINDOW, null, 0.9);
    }

    // service tower: posts, cross beams, swing arms, lightning mast and beacon
    var tx = TOWER.x, tz = TOWER.z, th = TOWER.h, seg = th / 3, lv = th / 6;
    addBoxW(list, tx, 0.1, tz, 0.75, 0.1, 0.75, RK_STEEL, RK_STEEL_TOP);
    for (k = 0; k < 4; k++) {
      var px = tx + ((k & 1) ? 0.55 : -0.55), pz = tz + ((k & 2) ? 0.55 : -0.55);
      for (i = 0; i < 3; i++) addBoxW(list, px, seg * (i + 0.5), pz, 0.07, seg / 2, 0.07, TOWER_RED);
    }
    for (i = 1; i <= 6; i++) {
      var y = i * lv - 0.06;
      addBoxW(list, tx, y, tz - 0.55, 0.55, 0.05, 0.05, TOWER_GRAY);
      addBoxW(list, tx, y, tz + 0.55, 0.55, 0.05, 0.05, TOWER_GRAY);
      addBoxW(list, tx - 0.55, y, tz, 0.05, 0.05, 0.55, TOWER_GRAY);
      addBoxW(list, tx + 0.55, y, tz, 0.05, 0.05, 0.55, TOWER_GRAY);
    }
    addBoxW(list, tx, th + 0.05, tz, 0.7, 0.05, 0.7, TOWER_GRAY);
    var armX0 = tx + 0.62, armX1 = rx - 0.62;
    addBoxW(list, (armX0 + armX1) / 2, 7.4, rz, (armX1 - armX0) / 2, 0.08, 0.15, TOWER_GRAY);
    addBoxW(list, (armX0 + armX1) / 2, 10.1, rz, (armX1 - armX0) / 2 + 0.02, 0.08, 0.15, TOWER_GRAY);
    addBoxW(list, tx, th + 0.7, tz, 0.04, 0.6, 0.04, RK_DARK);
    addBoxW(list, tx, th + 1.38, tz, 0.09, 0.09, 0.09, Math.sin(glowT * 3) > 0.3 ? BEACON_ON : BEACON_OFF);

    // control bunker with a slit window facing the pad and a slowly turning tracking dish
    var b = BUNKER;
    addBoxW(list, b.x, b.h / 2, b.z, b.hx, b.h / 2, b.hz, BUNKER_COL, BUNKER_TOP);
    addBoxW(list, b.x - b.hx - 0.02, 0.85, b.z, 0.02, 0.14, 0.7, BUNKER_GLASS, null, 0.88);
    addBoxW(list, b.x + 0.6, 0.55, b.z + b.hz + 0.02, 0.3, 0.55, 0.02, DC_DOOR, null, 0.88);
    addBoxW(list, b.x + 0.8, b.h + 0.45, b.z - 0.3, 0.03, 0.45, 0.03, RK_DARK);
    var dy = glowT * 0.3;
    var dg = { px: b.x + 0.8, pz: b.z - 0.3, c: Math.cos(dy), s: Math.sin(dy), oy: 0 };
    botBox(list, dg, 0, b.h + 1.0, 0, 0.36, 0.36, 0.03, TANK_WHITE, 0, b.h + 1.0, 0, 0.6);

    // fuel tanks and the feed line running to the launch mount
    for (i = 0; i < TANKS.length; i++) {
      var t = TANKS[i];
      addBoxW(list, t[0], 0.45, t[1], 0.6, 0.45, 0.6, TANK_WHITE);
      addBoxW(list, t[0], 1.05, t[1], 0.6, 0.15, 0.6, TANK_BAND);
      addBoxW(list, t[0], 1.7, t[1], 0.6, 0.5, 0.6, TANK_WHITE);
      addBoxW(list, t[0], 2.3, t[1], 0.4, 0.1, 0.4, TANK_WHITE);
    }
    var lineZ = TANKS[0][1] - 0.65, lastX = TANKS[TANKS.length - 1][0], mountZ = rz + 1.6;
    addBoxW(list, (rx + lastX) / 2, 0.12, lineZ, (lastX - rx) / 2, 0.12, 0.1, RK_STEEL);
    addBoxW(list, rx, 0.12, (lineZ + mountZ) / 2, 0.1, 0.12, (lineZ - mountZ) / 2, RK_STEEL);

    // name board
    addBoxW(list, LSIGN.x, 0.7, LSIGN.z, 0.08, 0.7, 0.08, TOWER_GRAY);
    addBoxW(list, LSIGN.x, 1.4, LSIGN.z, 0.05, 0.28, 0.85, RK_WHITE);
    addTextBB(list, "LAUNCH SITE", LSIGN.x, 1.4, LSIGN.z, 0.2, "rgb(255,120,90)");
  }

  // ---- datacenter drawing ----
  // side: 0 south, 1 north, 2 west, 3 east; u runs along the wall, out away from it
  function dcPos(side, u, out) {
    if (side === 0) return [DC.x + u, DC_R.z0 - out];
    if (side === 1) return [DC.x - u, DC_R.z1 + out];
    if (side === 2) return [DC_R.x0 - out, DC.z - u];
    return [DC_R.x1 + out, DC.z + u];
  }

  function dcSideVisible(side) {
    if (side === 0) return cam.z < DC_R.z0;
    if (side === 1) return cam.z > DC_R.z1;
    if (side === 2) return cam.x < DC_R.x0;
    return cam.x > DC_R.x1;
  }

  function dcBox(list, side, u, y, out, hu, hy, ho, col, bias) {
    var p = dcPos(side, u, out);
    if (side < 2) addBoxW(list, p[0], y, p[1], hu, hy, ho, col, null, bias);
    else addBoxW(list, p[0], y, p[1], ho, hy, hu, col, null, bias);
  }

  function dcRack(list, side, u, idx) {
    dcBox(list, side, u, 2.1, 0.03, 0.45, 1.3, 0.03, DC_GLASS, 0.88);
    for (var r = 0; r < 4; r++) {
      for (var c = 0; c < 2; c++) {
        var k = idx * 7 + r * 3 + c;
        var lit = Math.sin(glowT * (2.3 + (k % 5) * 0.9) + idx * 1.7 + r * 2.1 + c) > 0.1;
        var col = lit ? ((r + c) % 3 === 0 ? DC_LED_B : DC_LED_G) : DC_LED_OFF;
        dcBox(list, side, u - 0.18 + c * 0.36, 1.2 + r * 0.6, 0.07, 0.07, 0.05, 0.02, col, 0.82);
      }
    }
  }

  function dcFan(list, side, u, idx) {
    var fy = 2.8;
    dcBox(list, side, u, fy, 0.05, 1.0, 1.0, 0.05, DC_VENT, 0.88);
    var p = dcPos(side, u, 0.12);
    var g = { px: p[0], pz: p[1], c: Math.cos(DC_YAW[side]), s: Math.sin(DC_YAW[side]), oy: 0 };
    var a = glowT * 14 + idx * 0.7;
    botBox(list, g, 0, fy, 0, 0.85, 0.09, 0.025, DC_BLADE, 0, fy, a, 0, 0.8);
    botBox(list, g, 0, fy, 0, 0.85, 0.09, 0.025, DC_BLADE, 0, fy, a + Math.PI / 2, 0, 0.8);
    botBox(list, g, 0, fy, 0.03, 0.14, 0.14, 0.03, DC_TRIM, 0, fy, 0, 0, 0.78);
  }

  function addDatacenter(list) {
    var h = DC.h, side, i, row;
    for (side = 0; side < 4; side++) {
      if (!dcSideVisible(side)) continue;
      var L = DC_HALF[side], n = side < 2 ? 6 : 4, seg = 2 * L / n, nr = DC_N[side];
      for (i = 0; i < n; i++) {
        var ua = -L + i * seg, ub = ua + seg;
        var pa = dcPos(side, ua, 0), pb = dcPos(side, ub, 0);
        var col = i % 2 ? DC_WALL2 : DC_WALL;
        for (row = 0; row < 2; row++) {
          var ya = row * h / 2, yb = ya + h / 2;
          addFace(list, [pa[0], ya, pa[1]], [pb[0], ya, pb[1]], [pb[0], yb, pb[1]], [pa[0], yb, pa[1]], nr[0], 0, nr[1], col, 1.08);
        }
      }
      dcBox(list, side, 0, h - 0.15, 0.03, L, 0.15, 0.03, DC_TRIM, 0.9);
      dcBox(list, side, 0, 0.15, 0.03, L, 0.15, 0.03, DC_STRIPE, 0.9);
      if (side === 0) {
        dcBox(list, side, 0, 1.2, 0.04, 0.8, 1.2, 0.04, DC_DOOR, 0.88);
        dcBox(list, side, 0, h - 0.8, 0.04, 2.4, 0.38, 0.04, DC_TRIM, 0.93);
        addTextBB(list, "DATACENTER", DC.x, h - 0.8, DC_R.z0 - 0.12, 0.42, "rgb(120,230,255)");
        dcRack(list, side, -3.6, 0); dcRack(list, side, -2.3, 1);
        dcRack(list, side, 2.3, 2); dcRack(list, side, 3.6, 3);
      } else if (side === 1) {
        dcRack(list, side, -3.0, 4); dcRack(list, side, -1.2, 5);
        dcRack(list, side, 1.2, 6); dcRack(list, side, 3.0, 7);
      } else {
        dcFan(list, side, -1.4, side * 2);
        dcFan(list, side, 1.4, side * 2 + 1);
      }
    }
    // rooftop cooling units
    for (i = 0; i < DC_UNITS.length; i++) {
      var u = DC_UNITS[i];
      addBoxW(list, u[0], h + 0.45, u[1], 1.0, 0.45, 1.1, DC_UNIT, DC_UNIT_TOP);
      addBoxW(list, u[0], h + 1.0, u[1], 0.32, 0.12, 0.32, DC_FAN);
    }
  }

  function addParticles(list) {
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i];
      var left = p.life - p.age;
      var sz = p.sz * (left < 0.3 ? Math.max(0.1, left / 0.3) : 1);
      addBoxW(list, p.x, p.y, p.z, sz, sz, sz, p.col);
    }
  }

  function addFx(list) {
    for (var i = 0; i < FX.length; i++) {
      var f = FX[i];
      if (f.t < 0) continue;
      var p = f.t / f.dur;
      var y = f.y + (f.kind === 2 ? p * 2.2 : (f.kind === 4 ? p * 3 : 0));
      var cp = toCam(f.x, y, f.z);
      if (cp[2] < NEAR + 0.05) continue;
      var s = cam.f / cp[2];
      var e = 1 - (1 - p) * (1 - p);
      var r = (f.r0 + (f.r1 - f.r0) * e) * s;
      var dx = f.x - cam.x, dy = y - cam.y, dz = f.z - cam.z, d = dx * dx + dy * dy + dz * dz;
      var sx = cam.cx + cp[0] * s, sy = cam.cy - cp[1] * s, col, a;
      if (f.kind === 0) {
        col = "rgba(255,236,150," + (1 - p).toFixed(2) + ")";
        list.push({ k: 3, sx: sx, sy: sy, r: r, col: col, d: d * 0.95 });
      } else if (f.kind === 1) {
        a = (0.95 * (1 - p)).toFixed(2);
        col = "rgba(255," + Math.round(220 - 160 * p) + "," + Math.round(120 - 100 * p) + "," + a + ")";
        list.push({ k: 3, sx: sx, sy: sy, r: r, col: col, d: d * 0.97 });
        list.push({ k: 3, sx: sx, sy: sy, r: r * 0.55 * (1 - p * 0.6), col: "rgba(255,250,210," + a + ")", d: d * 0.96 });
      } else if (f.kind === 4) {
        col = "rgba(236,240,244," + (0.45 * (1 - p)).toFixed(2) + ")";
        list.push({ k: 3, sx: sx, sy: sy, r: r, col: col, d: d * 0.99 });
      } else {
        col = "rgba(84,80,74," + (0.45 * (1 - p)).toFixed(2) + ")";
        list.push({ k: 3, sx: sx, sy: sy, r: r, col: col, d: d * 0.98 });
      }
    }
  }

  function buildScene(list) {
    var i, c;
    for (i = 0; i < TREES.length; i++) addTree(list, TREES[i]);
    for (i = 0; i < CARS.length; i++) addCar(list, CARS[i]);
    for (i = 0; i < ROCKS.length; i++) {
      c = ROCKS[i];
      addBoxW(list, c.x, c.h, c.z, c.s, c.h, c.s, c.col);
    }
    for (i = 0; i < RIDGE.length; i++) {
      c = RIDGE[i];
      addBoxW(list, c[0], c[3], c[1], c[2], c[3], c[2], c[4]);
    }
    for (i = 0; i < WALLS.length; i++) {
      c = WALLS[i];
      addBoxW(list, c[0], c[3], c[1], c[2], c[3], c[4], STONE, STONE_TOP);
    }
    addDatacenter(list);
    addBank(list);
    addLaunchSite(list);
    addSkyscraper(list);
    addBoxW(list, SIGN.x, 0.7, SIGN.z, 0.08, 0.7, 0.08, WOOD);
    addBoxW(list, SIGN.x, 1.35, SIGN.z, 0.75, 0.25, 0.05, WOOD);
    addTextBB(list, "MOSSVALE", SIGN.x, 1.35, SIGN.z, 0.2, "rgb(250,240,214)");
    addBot(list);
    addParticles(list);
    addFx(list);
  }

  function byDepth(a, b) { return b.d - a.d; }

  function drawList(list) {
    ctx.lineJoin = "round";
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.k === 0) {
        var p = it.pts;
        ctx.fillStyle = it.col;
        ctx.strokeStyle = "rgba(10,16,12,0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (var j = 2; j < p.length; j += 2) ctx.lineTo(p[j], p[j + 1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (it.k === 3) {
        if (it.r < 0.5) continue;
        ctx.fillStyle = it.col;
        ctx.beginPath();
        ctx.arc(it.sx, it.sy, Math.min(it.r, 2000), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.font = "bold " + Math.round(it.fs) + "px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(40,26,14,0.8)";
        ctx.fillText(it.text, it.sx + 1, it.sy + 1);
        ctx.fillStyle = it.color;
        ctx.fillText(it.text, it.sx, it.sy);
      }
    }
  }

  function projSeg(a3, b3) {
    var a = toCam(a3[0], a3[1], a3[2]), b = toCam(b3[0], b3[1], b3[2]), k;
    if (a[2] < NEAR && b[2] < NEAR) return null;
    if (a[2] < NEAR) {
      k = (NEAR - a[2]) / (b[2] - a[2]);
      a = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, NEAR];
    } else if (b[2] < NEAR) {
      k = (NEAR - b[2]) / (a[2] - b[2]);
      b = [b[0] + (a[0] - b[0]) * k, b[1] + (a[1] - b[1]) * k, NEAR];
    }
    var sa = cam.f / a[2], sb = cam.f / b[2];
    return [cam.cx + a[0] * sa, cam.cy - a[1] * sa, cam.cx + b[0] * sb, cam.cy - b[1] * sb];
  }

  function drawTracers() {
    ctx.lineCap = "round";
    for (var i = 0; i < TRACERS.length; i++) {
      var tr = TRACERS[i];
      var s = projSeg(tr.a, tr.b);
      if (!s) continue;
      ctx.strokeStyle = "rgba(255,240,170," + Math.min(1, tr.t / 0.09).toFixed(2) + ")";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      ctx.lineTo(s[2], s[3]);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  function drawAim() {
    if (!gunOn || state !== "play") return;
    var hy = aim.tree ? 1.3 * aim.tree.s : GUN_Y;
    var target = [aim.x, hy, aim.z];
    var seg = projSeg(gunLocal(-1.0, 0.04), target);
    if (seg) {
      ctx.strokeStyle = aim.tree ? "rgba(255,90,70,0.45)" : "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(seg[0], seg[1]);
      ctx.lineTo(seg[2], seg[3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    var cp = toCam(target[0], target[1], target[2]);
    if (cp[2] < NEAR) return;
    var s = cam.f / cp[2];
    var x = cam.cx + cp[0] * s, y = cam.cy - cp[1] * s;
    var col = aim.tree ? "rgb(255,90,70)" : "rgba(255,255,255,0.9)";
    var r = aim.tree ? 11 : 9;
    for (var pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? "rgba(0,0,0,0.45)" : col;
      ctx.lineWidth = pass === 0 ? 4 : 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - r - 6, y); ctx.lineTo(x - r + 3, y);
      ctx.moveTo(x + r - 3, y); ctx.lineTo(x + r + 6, y);
      ctx.moveTo(x, y - r - 6); ctx.lineTo(x, y - r + 3);
      ctx.moveTo(x, y + r - 3); ctx.lineTo(x, y + r + 6);
      ctx.stroke();
    }
  }

  // a small prompt while the rocket is in view: ready to launch, flying, or reloading
  function drawRocketHint() {
    if (state !== "play" || !rocketLook) return;
    var txt = rocket.mode === 0 ? "Press L to launch the rocket" : (rocket.mode === 1 ? "Liftoff!" : "Rocket reloading: " + Math.max(1, Math.ceil(rocket.t)) + "s");
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var w = ctx.measureText(txt).width + 22, x = W / 2, y = H - 48;
    ctx.fillStyle = "rgba(12,13,16,0.65)";
    ctx.fillRect(x - w / 2, y - 13, w, 26);
    ctx.fillStyle = rocket.mode === 0 ? "rgb(255,200,120)" : "rgb(232,232,232)";
    ctx.fillText(txt, x, y);
  }

  function drawCompass() {
    var r = 20, cx = W - r - 12, cy = r + 12;
    ctx.fillStyle = "rgba(12,16,14,0.5)";
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.fill();
    var nx = -Math.sin(camYaw), ny = -Math.cos(camYaw);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgb(230,90,80)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + nx * (r - 7), cy + ny * (r - 7));
    ctx.stroke();
    ctx.strokeStyle = "rgb(220,220,220)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - nx * (r - 9), cy - ny * (r - 9));
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.fillStyle = "rgb(255,240,220)";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", cx + nx * (r - 1), cy + ny * (r - 1));
  }

  function drawStick() {
    if (!stick) return;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, STICK_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.beginPath();
    ctx.arc(stick.ox + stick.dx * STICK_R, stick.oy + stick.dy * STICK_R, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw() {
    setupCamera();
    var hy = cam.cy - Math.tan(cam.pitch) * cam.f;
    var hc = Math.max(1, Math.min(H, hy));
    var sky = ctx.createLinearGradient(0, hc - H * 0.6, 0, hc);
    sky.addColorStop(0, "rgb(104,156,214)");
    sky.addColorStop(1, "rgb(" + HAZE[0] + "," + HAZE[1] + "," + HAZE[2] + ")");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    var gy = Math.max(0, Math.min(H, hy));
    if (gy < H) {
      var gr = ctx.createLinearGradient(0, gy, 0, Math.max(gy + 1, H));
      gr.addColorStop(0, "rgb(176,192,198)");
      gr.addColorStop(0.12, "rgb(162,166,164)");
      gr.addColorStop(1, "rgb(" + GROUND_COL[0] + "," + GROUND_COL[1] + "," + GROUND_COL[2] + ")");
      ctx.fillStyle = gr;
      ctx.fillRect(0, gy, W, H - gy);
    }

    var shaking = shake > 0;
    if (shaking) {
      ctx.save();
      ctx.translate((Math.random() - 0.5) * shake * 16, (Math.random() - 0.5) * shake * 16);
    }

    drawGround();

    var list = [];
    buildScene(list);
    list.sort(byDepth);
    drawList(list);
    drawTracers();

    if (shaking) ctx.restore();

    drawAim();
    drawStick();
    drawRocketHint();
    drawCompass();
  }

  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    update(dt);
    music.tick();
    draw();
    requestAnimationFrame(frame);
  }

  // ---- input ----
  var MOVE_KEYS = { w: 1, a: 1, s: 1, d: 1, q: 1, e: 1, r: 1, v: 1, arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1 };

  document.addEventListener("keydown", function (e) {
    var key = String(e.key || "").toLowerCase();
    if (key === "escape" && resetOpen) {
      e.preventDefault();
      setResetConfirm(false);
      return;
    }
    if (key === "i") {
      e.preventDefault();
      if (!e.repeat) setInventory(!invOpen);
      return;
    }
    if (key === "escape" && invOpen) {
      e.preventDefault();
      setInventory(false);
      return;
    }
    if (MOVE_KEYS[key]) {
      e.preventDefault();
      if (state !== "play") startGame();
      if (!keys[key]) {
        keys[key] = true;
        window.gameTest.inputsHandled++;
      }
      return;
    }
    if (key === "g") {
      e.preventDefault();
      if (!e.repeat) setGun(!gunOn);
      return;
    }
    if (key === "l") {
      e.preventDefault();
      if (!e.repeat) {
        window.gameTest.inputsHandled++;
        if (state !== "play") startGame();
        tryLaunch();
      }
      return;
    }
    if (key === "f" || key === " ") {
      e.preventDefault();
      if (state !== "play") {
        window.gameTest.inputsHandled++;
        startGame();
      } else if (!e.repeat) {
        if (!gunOn) setGun(true);
        else fire();
      }
      return;
    }
    if (key === "m") {
      e.preventDefault();
      toggleMusic();
    } else if (key === "enter" && state !== "play") {
      e.preventDefault();
      window.gameTest.inputsHandled++;
      startGame();
    }
  });

  document.addEventListener("keyup", function (e) {
    var key = String(e.key || "").toLowerCase();
    if (MOVE_KEYS[key]) keys[key] = false;
  });

  window.addEventListener("blur", function () {
    keys = {};
    stick = null; stickId = null; lookers = {};
  });

  startBtn.addEventListener("click", function () {
    window.gameTest.inputsHandled++;
    startGame();
  });

  musicBtn.addEventListener("click", function () { toggleMusic(); musicBtn.blur(); });
  gunBtn.addEventListener("click", function () { setGun(!gunOn); gunBtn.blur(); });
  invBtn.addEventListener("click", function () { setInventory(!invOpen); invBtn.blur(); });
  invClose.addEventListener("click", function () { setInventory(false); invClose.blur(); });
  resetBtn.addEventListener("click", function () { setResetConfirm(!resetOpen); resetBtn.blur(); });
  resetNo.addEventListener("click", function () { setResetConfirm(false); resetNo.blur(); });
  resetYes.addEventListener("click", function () {
    resetValley();
    setResetConfirm(false);
    resetYes.blur();
  });

  function setStick(x, y) {
    var dx = (x - stick.ox) / STICK_R, dy = (y - stick.oy) / STICK_R;
    var m = Math.sqrt(dx * dx + dy * dy);
    if (m > 1) { dx /= m; dy /= m; }
    stick.dx = dx; stick.dy = dy;
  }

  canvas.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    var lx = e.clientX - r.left, ly = e.clientY - r.top;
    window.gameTest.inputsHandled++;
    if (state !== "play") startGame();
    if (e.pointerType === "mouse" && locked) {
      fire();
      return;
    }
    if (e.pointerType === "mouse" && !locked && !invOpen && !resetOpen) requestLock();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.pointerType !== "mouse" && lx < r.width / 2 && stickId === null) {
      stickId = e.pointerId;
      stick = { ox: lx, oy: ly, dx: 0, dy: 0 };
    } else if (!locked) {
      lookers[e.pointerId] = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() };
    }
  });

  canvas.addEventListener("pointermove", function (e) {
    if (e.pointerId === stickId && stick) {
      var r = canvas.getBoundingClientRect();
      setStick(e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (locked) return;
    var l = lookers[e.pointerId];
    if (l) {
      camYaw += (e.clientX - l.x) * DRAG_TURN;
      lookPitch = clampPitch(lookPitch + (e.clientY - l.y) * DRAG_TURN);
      l.x = e.clientX;
      l.y = e.clientY;
    }
  });

  function endPointer(e) {
    if (e.pointerId === stickId) { stickId = null; stick = null; }
    var l = lookers[e.pointerId];
    delete lookers[e.pointerId];
    // a quick tap (not a drag) on the view fires the pistol
    if (l && e.type === "pointerup" && gunOn && state === "play") {
      var mx = e.clientX - l.sx, my = e.clientY - l.sy;
      if (mx * mx + my * my < 64 && performance.now() - l.t < 350) fire();
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // session end: keep the account copy up to date (only stores if something changed)
  window.addEventListener("pagehide", storeAccount);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) storeAccount();
  });

  // restore this browser's saved valley before the first frame
  if (loadProgress() && overlayTitle) overlayTitle.textContent = "Welcome back to Mossvale";

  window.addEventListener("resize", resize);
  resize();
  updateMusicBtn();
  updateGunBtn();
  updateInvBtn();
  updateTreeCount();
  updatePlaceCount();
  renderInventory();
  requestAnimationFrame(frame);
  // the account copy loads in the background; the game never waits for it
  loadAccount();
})();
