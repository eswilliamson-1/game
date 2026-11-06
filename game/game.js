(function () {
  "use strict";

  var GOAL = "Explore Mossvale: find the old cottage, the pond, and the rocky ridge. Equip your pistol (G or the Pistol button) to blast trees out of your way.";
  window.gameTest = { inputsHandled: 0, goal: GOAL };

  var music = window.TechnoMusic || { start: function () {}, stop: function () {}, tick: function () {}, setMuted: function () {}, isMuted: function () { return true; }, sfx: function () {} };
  if (typeof music.sfx !== "function") music.sfx = function () {};

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var stage = document.getElementById("stage");
  var goalEl = document.getElementById("goal");
  var overlay = document.getElementById("overlay");
  var startBtn = document.getElementById("startBtn");
  var musicBtn = document.getElementById("musicBtn");
  var gunBtn = document.getElementById("gunBtn");
  var treeCountEl = document.getElementById("treeCount");
  var lockHint = document.getElementById("lockHint");

  goalEl.textContent = GOAL;

  function updateMusicBtn() {
    musicBtn.textContent = music.isMuted() ? "Music: Off" : "Music: On";
  }

  function toggleMusic() {
    window.gameTest.inputsHandled++;
    music.setMuted(!music.isMuted());
    updateMusicBtn();
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
  var NEAR = 0.2;
  var STICK_R = 50;
  var DRAW_DIST = 52;
  var SHOT_RANGE = 30, GUN_Y = 1.36, SHOT_COOLDOWN = 0.3;

  // ---- colors ----
  var HAZE = [184, 206, 216];
  var GRASS = [88, 138, 70];
  var PATH_COL = [170, 142, 100], SHORE_COL = [198, 182, 132], WATER_COL = [64, 124, 168];
  var TRUNK = [112, 80, 52], LEAF_A = [66, 132, 66], LEAF_A2 = [92, 156, 78], LEAF_B = [46, 104, 64];
  var ROCK_COLS = [[128, 128, 124], [112, 114, 116], [140, 134, 124]];
  var STONE = [124, 122, 116], STONE_TOP = [146, 144, 136];
  var HUT_WALL = [200, 174, 132], HUT_ROOF = [152, 72, 58], HUT_DOOR = [92, 62, 40], HUT_WIN = [130, 178, 205];
  var WOOD = [134, 98, 62];
  var AV_BODY = [150, 122, 215], AV_HEAD = [226, 222, 210], AV_DARK = [34, 38, 50];
  var AV_EYE = [120, 230, 255], AV_LEG = [84, 90, 108], AV_GOLD = [255, 212, 70];
  var GUN_DARK = [58, 62, 70], GUN_GRIP = [96, 74, 54];

  // ---- deterministic random so the world is always the same ----
  var seed = 20240611;
  function rnd() {
    seed = (seed + 0x6D2B79F5) | 0;
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
  var PATH_HW = 0.9;
  var PATHS = [[0, -31, 0, 2], [0, 2, 8, 5.5], [0, 2, -6, 2.5], [-6, 2.5, -9, 6.5], [0, 2, 12, -4], [12, -4, 24, -10]];
  var POND = { x: -15, z: 13, r: 5.6 };
  function pondR(a) { return POND.r + 0.7 * Math.sin(3 * a + 0.5) + 0.4 * Math.sin(5 * a + 1.3); }
  var HUT = { x: 8, z: 9, hx: 2.4, hz: 2, h: 1.7 };
  var SIGN = { x: 2, z: -1 };

  var RECTS = [], CIRCS = [], TREES = [], ROCKS = [], RIDGE = [], WALLS = [];
  var BLOCKERS = [];
  var GROUND = [], FLOWERS = [], SHADOWS = [];
  var POND_PTS = [];

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
    if (x > HUT.x - HUT.hx - m - 1 && x < HUT.x + HUT.hx + m + 1 && z > HUT.z - HUT.hz - m - 1.5 && z < HUT.z + HUT.hz + m + 1) return false;
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

  (function buildWorld() {
    var i, x, z, s, h, rc;
    rc = { x0: HUT.x - HUT.hx, x1: HUT.x + HUT.hx, z0: HUT.z - HUT.hz, z1: HUT.z + HUT.hz };
    RECTS.push(rc);
    BLOCKERS.push(rc);
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
      ROCKS.push({ x: x, z: z, s: s, h: h, col: ROCK_COLS[Math.floor(rnd() * 3) % 3] });
      rc = { x0: x - s, x1: x + s, z0: z - s, z1: z + s };
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
      var shad = { pts: blobPts(x + 0.25, z - 0.2, 1.1 * s, 8, 0.015, 0), col: [20, 40, 20], a: 0.22, x: x, z: z };
      TREES.push({ x: x, z: z, s: s, kind: kind, circ: circ, shadow: shad });
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

    // meadow patches
    for (i = 0; i < 14; i++) {
      x = WORLD.x0 + 4 + rnd() * (WORLD.x1 - WORLD.x0 - 8);
      z = WORLD.z0 + 4 + rnd() * (WORLD.z1 - WORLD.z0 - 8);
      var r = 2 + rnd() * 3;
      GROUND.push({ pts: blobPts(x, z, r, 10, 0.004, 0.5), col: i % 2 ? [104, 154, 78] : [74, 120, 60], a: 1, x: x, z: z, r: r });
    }

    // paths with rounded joints
    for (i = 0; i < PATHS.length; i++) {
      var p = PATHS[i];
      var dx = p[2] - p[0], dz = p[3] - p[1], l = Math.sqrt(dx * dx + dz * dz) || 1;
      var nx = -dz / l * PATH_HW, nz = dx / l * PATH_HW, y = 0.008;
      GROUND.push({ pts: [[p[0] + nx, y, p[1] + nz], [p[2] + nx, y, p[3] + nz], [p[2] - nx, y, p[3] - nz], [p[0] - nx, y, p[1] - nz]], col: PATH_COL, a: 1, x: (p[0] + p[2]) / 2, z: (p[1] + p[3]) / 2, r: 0 });
      GROUND.push({ pts: blobPts(p[2], p[3], PATH_HW, 10, 0.009, 0), col: PATH_COL, a: 1, x: p[2], z: p[3], r: 1 });
    }

    // pond: sandy shore then water
    var shore = [];
    for (i = 0; i < 24; i++) {
      var a = i / 24 * Math.PI * 2, rr = pondR(a);
      shore.push([POND.x + Math.cos(a) * (rr + 1.0), 0.01, POND.z + Math.sin(a) * (rr + 1.0)]);
      POND_PTS.push([POND.x + Math.cos(a) * rr, 0.02, POND.z + Math.sin(a) * rr]);
    }
    GROUND.push({ pts: shore, col: SHORE_COL, a: 1, x: POND.x, z: POND.z, r: 0 });
    GROUND.push({ pts: POND_PTS, col: WATER_COL, a: 1, x: POND.x, z: POND.z, r: 0 });

    // little flower clusters
    var fcols = [[240, 214, 90], [232, 140, 182], [244, 244, 236]];
    for (i = 0; i < 40 && FLOWERS.length < 70; i++) {
      x = WORLD.x0 + 3 + rnd() * (WORLD.x1 - WORLD.x0 - 6);
      z = WORLD.z0 + 3 + rnd() * (WORLD.z1 - WORLD.z0 - 6);
      if (!isClear(x, z, 0)) continue;
      var fc = fcols[i % 3];
      for (var k = 0; k < 7; k++) {
        var fx = x + (rnd() - 0.5) * 2.4, fz = z + (rnd() - 0.5) * 2.4, fs = 0.09;
        FLOWERS.push({ pts: [[fx - fs, 0.02, fz - fs], [fx + fs, 0.02, fz - fs], [fx + fs, 0.02, fz + fs], [fx - fs, 0.02, fz + fs]], col: fc, a: 1, x: fx, z: fz });
      }
    }
  })();

  var player = { x: START_X, z: START_Z, yaw: 0, walk: 0, walkAmt: 0 };
  var camYaw = 0;
  var cam = { x: 0, y: 0, z: 0, ct: 1, st: 0, cp: 1, sp: 0, f: 300, cx: 150, cy: 200 };
  var keys = {};
  var stick = null, stickId = null, lookers = {};
  var locked = false;
  var state = "ready";
  var glowT = 0;

  // ---- pistol state ----
  var gunOn = false, gunCool = 0, gunKick = 0, shake = 0, cleared = 0;
  var PARTS = [], FX = [], TRACERS = [];
  var aim = { tree: null, d: SHOT_RANGE, x: 0, z: 0 };

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
    cam.x = player.x - s * CAM_BACK;
    cam.z = player.z - c * CAM_BACK;
    cam.y = CAM_UP;
    cam.ct = c; cam.st = s;
    cam.cp = Math.cos(CAM_PITCH); cam.sp = Math.sin(CAM_PITCH);
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
    if (dx * dx + dz * dz > DRAW_DIST * DRAW_DIST) return;
    var r = Math.max(hx, hy, hz) * 1.8;
    var zc = (dx * cam.st + dz * cam.ct) * cam.cp - dy * cam.sp;
    if (zc < -r) return;
    var v = [];
    for (var i = 0; i < 8; i++) {
      v.push([cx + ((i & 1) ? hx : -hx), cy + ((i & 2) ? hy : -hy), cz + ((i & 4) ? hz : -hz)]);
    }
    addBoxVerts(list, v, col, topCol, bias);
  }

  function botBox(list, g, cx, cy, cz, hx, hy, hz, col, px, py, rz, rx) {
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
    addBoxVerts(list, v, col, null);
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
    var mx = e.movementX || 0;
    if (mx > MOUSE_MAX_STEP) mx = MOUSE_MAX_STEP;
    else if (mx < -MOUSE_MAX_STEP) mx = -MOUSE_MAX_STEP;
    if (mx !== 0) {
      camYaw += mx * MOUSE_TURN;
      window.gameTest.inputsHandled++;
    }
  });

  function startGame() {
    if (state === "play") return;
    state = "play";
    overlay.classList.add("hidden");
    startBtn.blur();
    music.start();
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
    var idx = TREES.indexOf(t), i;
    if (idx < 0) return;
    TREES.splice(idx, 1);
    var ci = CIRCS.indexOf(t.circ);
    if (ci >= 0) CIRCS.splice(ci, 1);
    // leave a scorch mark where the tree stood
    t.shadow.col = [44, 34, 24];
    t.shadow.a = 0.45;
    t.shadow.pts = blobPts(t.x, t.z, 0.85 * t.s, 9, 0.016, 0.45);

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
  }

  function update(dt) {
    glowT += dt;
    if (state === "play") updateMovement(dt);
    updateEffects(dt);
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

  function addHut(list) {
    var h = HUT, fz = h.z - h.hz;
    addBoxW(list, h.x, h.h / 2, h.z, h.hx, h.h / 2, h.hz, HUT_WALL, HUT_WALL);
    addBoxW(list, h.x, h.h + 0.22, h.z, h.hx + 0.35, 0.22, h.hz + 0.35, HUT_ROOF);
    addBoxW(list, h.x, h.h + 0.66, h.z, h.hx - 0.1, 0.22, h.hz - 0.45, HUT_ROOF);
    addBoxW(list, h.x, h.h + 1.06, h.z, h.hx - 0.55, 0.18, h.hz - 1.05, HUT_ROOF);
    addBoxW(list, h.x + 1.3, h.h + 1.1, h.z + 0.8, 0.24, 0.6, 0.24, STONE, STONE_TOP);
    addBoxW(list, h.x, 0.62, fz - 0.04, 0.45, 0.62, 0.04, HUT_DOOR, null, 0.85);
    addBoxW(list, h.x - 1.45, 1.0, fz - 0.03, 0.35, 0.28, 0.03, HUT_WIN, null, 0.85);
    addBoxW(list, h.x + 1.45, 1.0, fz - 0.03, 0.35, 0.28, 0.03, HUT_WIN, null, 0.85);
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
      var y = f.y + (f.kind === 2 ? p * 2.2 : 0);
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
      } else {
        col = "rgba(84,80,74," + (0.45 * (1 - p)).toFixed(2) + ")";
        list.push({ k: 3, sx: sx, sy: sy, r: r, col: col, d: d * 0.98 });
      }
    }
  }

  function buildScene(list) {
    var i, c;
    for (i = 0; i < TREES.length; i++) addTree(list, TREES[i]);
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
    addHut(list);
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
    var hy = cam.cy - Math.tan(CAM_PITCH) * cam.f;
    var hc = Math.max(1, Math.min(H, hy));
    var sky = ctx.createLinearGradient(0, hc - H * 0.6, 0, hc);
    sky.addColorStop(0, "rgb(104,156,214)");
    sky.addColorStop(1, "rgb(" + HAZE[0] + "," + HAZE[1] + "," + HAZE[2] + ")");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    var gy = Math.max(0, Math.min(H, hy));
    var gr = ctx.createLinearGradient(0, gy, 0, H);
    gr.addColorStop(0, "rgb(170,196,190)");
    gr.addColorStop(0.12, "rgb(116,158,100)");
    gr.addColorStop(1, "rgb(" + GRASS[0] + "," + GRASS[1] + "," + GRASS[2] + ")");
    ctx.fillStyle = gr;
    ctx.fillRect(0, gy, W, H - gy);

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
  var MOVE_KEYS = { w: 1, a: 1, s: 1, d: 1, q: 1, e: 1, arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1 };

  document.addEventListener("keydown", function (e) {
    var key = String(e.key || "").toLowerCase();
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
    if (e.pointerType === "mouse" && !locked) requestLock();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.pointerType !== "mouse" && lx < r.width / 2 && stickId === null) {
      stickId = e.pointerId;
      stick = { ox: lx, oy: ly, dx: 0, dy: 0 };
    } else if (!locked) {
      lookers[e.pointerId] = { x: e.clientX, sx: e.clientX, sy: e.clientY, t: performance.now() };
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
      l.x = e.clientX;
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

  window.addEventListener("resize", resize);
  resize();
  updateMusicBtn();
  updateGunBtn();
  updateTreeCount();
  requestAnimationFrame(frame);
})();
