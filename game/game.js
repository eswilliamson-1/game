(function () {
  "use strict";

  var GOAL = "Sort each shape into its matching bin before it reaches the end of the belt. Gold shapes are worth 3 points. Three mistakes ends the round. Walk your bot and turn the camera to look around.";
  window.gameTest = { inputsHandled: 0, goal: GOAL };

  var music = window.TechnoMusic || { start: function () {}, stop: function () {}, tick: function () {}, setMuted: function () {}, isMuted: function () { return true; } };

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var stage = document.getElementById("stage");
  var goalEl = document.getElementById("goal");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var missEl = document.getElementById("miss");
  var overlay = document.getElementById("overlay");
  var overlayTitle = document.getElementById("overlayTitle");
  var overlayText = document.getElementById("overlayText");
  var startBtn = document.getElementById("startBtn");
  var binLeft = document.getElementById("binLeft");
  var binMid = document.getElementById("binMid");
  var binRight = document.getElementById("binRight");
  var musicBtn = document.getElementById("musicBtn");

  goalEl.textContent = GOAL;

  function updateMusicBtn() {
    musicBtn.textContent = music.isMuted() ? "Music: Off" : "Music: On";
  }

  function toggleMusic() {
    window.gameTest.inputsHandled++;
    music.setMuted(!music.isMuted());
    updateMusicBtn();
  }

  // Type index = side + 1 (left = 0, middle = 1, right = 2)
  var TYPES = [
    { name: "circle", color: "hsl(28, 92%, 60%)", rgb: [245, 150, 60], side: -1, label: "CIRCLES" },
    { name: "triangle", color: "hsl(325, 70%, 62%)", rgb: [226, 90, 160], side: 0, label: "TRIANGLES" },
    { name: "square", color: "hsl(180, 60%, 45%)", rgb: [46, 184, 184], side: 1, label: "SQUARES" }
  ];

  var GOLD = "rgb(255,212,70)";
  var GOLD_CHANCE = 1 / 15;

  var SCALE = 2;
  var W = 300, H = 400;

  // ---- world layout (x right, y up, z forward) ----
  var BELT_HW = 0.8, BELT_H = 0.5, BELT_START = 17, BELT_END = 5, BELT_LEN = BELT_START - BELT_END;
  var SHAPE_Y = BELT_H + 0.95, SHAPE_R = 0.8;
  var BIN_Z = 3, BIN_HW = 1.0, BIN_HH = 0.45, BIN_HD = 0.75, BIN_GAP = 3.2;
  var ARENA = { x0: -15, x1: 15, z0: -11, z1: 23 };
  var START_X = 0, START_Z = -2;
  var PLAYER_R = 0.45, MOVE_SPEED = 5, TURN_SPEED = 2.2, DRAG_TURN = 0.0085;
  var CAM_BACK = 5.5, CAM_UP = 4.2, LOOK_AHEAD = 4, LOOK_Y = 0.5;
  var CAM_PITCH = Math.atan2(CAM_UP - LOOK_Y, CAM_BACK + LOOK_AHEAD);
  var NEAR = 0.2;
  var STICK_R = 50;

  var CRATES = [[-7, 8, 0.6], [-8.4, 8.4, 0.5], [-7.6, 9.7, 0.45], [7.5, 11, 0.7], [8.9, 10.1, 0.5], [-10, -4, 0.6], [9, -5, 0.55], [4, -8, 0.5], [-4, 15, 0.6], [5, 18, 0.7], [-12, 14, 0.6], [12, 2, 0.6]];
  var PILLARS = [[-13, -9], [13, -9], [-13, 21], [13, 21], [-13, 6], [13, 6]];

  var OBST = (function () {
    var o = [], i, c;
    o.push({ x0: -BELT_HW, x1: BELT_HW, z0: BELT_END, z1: BELT_START });
    for (i = -1; i <= 1; i++) o.push({ x0: i * BIN_GAP - BIN_HW, x1: i * BIN_GAP + BIN_HW, z0: BIN_Z - BIN_HD, z1: BIN_Z + BIN_HD });
    for (i = 0; i < CRATES.length; i++) { c = CRATES[i]; o.push({ x0: c[0] - c[2], x1: c[0] + c[2], z0: c[1] - c[2], z1: c[1] + c[2] }); }
    for (i = 0; i < PILLARS.length; i++) { c = PILLARS[i]; o.push({ x0: c[0] - 0.5, x1: c[0] + 0.5, z0: c[1] - 0.5, z1: c[1] + 0.5 }); }
    return o;
  })();

  var player = { x: START_X, z: START_Z, yaw: 0, walk: 0, walkAmt: 0 };
  var camYaw = 0;
  var cam = { x: 0, y: 0, z: 0, ct: 1, st: 0, cp: 1, sp: 0, f: 300, cx: 150, cy: 200 };
  var keys = {};
  var stick = null, stickId = null, lookers = {};

  var state = "ready";
  var score = 0, best = 0, miss = 0;
  var shape = null;
  var spawnDelay = 0;
  var fliers = [];
  var flash = 0, flashGood = true, flashGold = false;
  var msg = "", msgT = 0, msgColor = "rgb(120,230,150)", msgGold = false;
  var beltOffset = 0;
  var lastType = -1, sameCount = 0;
  var glowT = 0;

  // ---- the player's sorter bot ----
  var AV = { pointT: 0, side: 1, hop: 0, hurt: 0 };
  var FACES = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]];
  var LIGHT = (function () {
    var x = -0.45, y = 0.8, z = -0.4, m = Math.sqrt(x * x + y * y + z * z);
    return [x / m, y / m, z / m];
  })();
  var AV_BODY = [150, 122, 215], AV_HEAD = [226, 222, 210], AV_DARK = [34, 38, 50];
  var AV_EYE = [120, 230, 255], AV_LEG = [84, 90, 108], AV_GOLD = [255, 212, 70];
  var CRATE_COL = [150, 112, 72], CRATE_TOP = [178, 138, 94];
  var PILLAR_COL = [78, 84, 100], PILLAR_TOP = [100, 106, 122];
  var BELT_SIDE = [70, 75, 88], BELT_FRONT = [160, 70, 70], BIN_TOP = [22, 24, 30];

  function avatarPoint(dir) { AV.side = dir; AV.pointT = 1; }

  function updateAvatar(dt) {
    if (AV.pointT > 0) AV.pointT = Math.max(0, AV.pointT - dt / 0.45);
    if (AV.hop > 0) AV.hop = Math.max(0, AV.hop - dt / 0.35);
    if (AV.hurt > 0) AV.hurt = Math.max(0, AV.hurt - dt / 0.5);
  }

  function tint(col, h) {
    var m = h * 0.6;
    return [col[0] + (235 - col[0]) * m, col[1] + (70 - col[1]) * m, col[2] + (70 - col[2]) * m];
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

  function addFace(list, a, b, c, d, nx, ny, nz, col) {
    var fx = (a[0] + b[0] + c[0] + d[0]) * 0.25;
    var fy = (a[1] + b[1] + c[1] + d[1]) * 0.25;
    var fz = (a[2] + b[2] + c[2] + d[2]) * 0.25;
    var vx = fx - cam.x, vy = fy - cam.y, vz = fz - cam.z;
    if (vx * nx + vy * ny + vz * nz >= 0) return;
    var pts = projPoly([toCam(a[0], a[1], a[2]), toCam(b[0], b[1], b[2]), toCam(c[0], c[1], c[2]), toCam(d[0], d[1], d[2])]);
    if (!pts) return;
    var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    var lit = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / nl;
    var sh = 0.42 + 0.58 * Math.max(0, lit);
    list.push({
      k: 0, pts: pts, d: vx * vx + vy * vy + vz * vz,
      col: "rgb(" + Math.round(col[0] * sh) + "," + Math.round(col[1] * sh) + "," + Math.round(col[2] * sh) + ")"
    });
  }

  function addBoxVerts(list, v, col, topCol) {
    var cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < 8; i++) { cx += v[i][0]; cy += v[i][1]; cz += v[i][2]; }
    cx /= 8; cy /= 8; cz /= 8;
    for (var f = 0; f < 6; f++) {
      var idx = FACES[f];
      var a = v[idx[0]], b = v[idx[1]], c = v[idx[2]], d = v[idx[3]];
      var nx = (a[0] + b[0] + c[0] + d[0]) * 0.25 - cx;
      var ny = (a[1] + b[1] + c[1] + d[1]) * 0.25 - cy;
      var nz = (a[2] + b[2] + c[2] + d[2]) * 0.25 - cz;
      addFace(list, a, b, c, d, nx, ny, nz, (f === 3 && topCol) ? topCol : col);
    }
  }

  function addBoxW(list, cx, cy, cz, hx, hy, hz, col, topCol) {
    var dx = cx - cam.x, dy = cy - cam.y, dz = cz - cam.z;
    if (dx * dx + dy * dy + dz * dz > 75 * 75) return;
    var r = Math.max(hx, hy, hz) * 1.8;
    var zc = (dx * cam.st + dz * cam.ct) * cam.cp - dy * cam.sp;
    if (zc < -r) return;
    var v = [];
    for (var i = 0; i < 8; i++) {
      v.push([cx + ((i & 1) ? hx : -hx), cy + ((i & 2) ? hy : -hy), cz + ((i & 4) ? hz : -hz)]);
    }
    addBoxVerts(list, v, col, topCol);
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
      x += g.ox; y += g.oy;
      v.push([g.px + x * g.c + z * g.s, y, g.pz - x * g.s + z * g.c]);
    }
    addBoxVerts(list, v, tint(col, g.hurt), null);
  }

  function addShapeBB(list, type, x, y, z, R, alpha, gold) {
    var cp = toCam(x, y, z);
    if (cp[2] < NEAR + 0.1) return;
    var s = cam.f / cp[2];
    var dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    list.push({ k: 1, type: type, gold: gold, a: alpha, sx: cam.cx + cp[0] * s, sy: cam.cy - cp[1] * s, r: Math.min(R * s, H), d: (dx * dx + dy * dy + dz * dz) * 0.97 });
  }

  function addTextBB(list, text, x, y, z, size, color) {
    var cp = toCam(x, y, z);
    if (cp[2] < NEAR + 0.1) return;
    var s = cam.f / cp[2];
    var fs = size * s;
    if (fs < 6) return;
    var dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    list.push({ k: 2, text: text, color: color, fs: Math.min(fs, 60), sx: cam.cx + cp[0] * s, sy: cam.cy - cp[1] * s, d: dx * dx + dy * dy + dz * dz });
  }

  function resize() {
    var r = stage.getBoundingClientRect();
    W = Math.max(200, r.width);
    H = Math.max(240, r.height);
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  }

  function rate() { return (0.2 + Math.min(score, 60) * 0.017) / 0.74; }

  function shapePos(p) { return { x: 0, y: SHAPE_Y, z: BELT_START - p * BELT_LEN }; }

  function updateHud() {
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
    missEl.textContent = String(miss);
  }

  function spawn() {
    var n = TYPES.length;
    var t = Math.floor(Math.random() * n);
    if (t >= n) t = n - 1;
    if (t === lastType) {
      sameCount++;
      if (sameCount >= 2) {
        t = (t + 1 + Math.floor(Math.random() * (n - 1))) % n;
        sameCount = 0;
      }
    } else {
      sameCount = 0;
    }
    lastType = t;
    shape = { type: t, p: 0, gold: Math.random() < GOLD_CHANCE };
  }

  function startRound() {
    score = 0; miss = 0; shape = null; fliers = [];
    spawnDelay = 0.5; msg = ""; msgT = 0; flash = 0;
    lastType = -1; sameCount = 0;
    AV.pointT = 0; AV.hop = 0; AV.hurt = 0;
    player.x = START_X; player.z = START_Z; player.yaw = 0;
    camYaw = 0;
    state = "play";
    overlay.classList.add("hidden");
    startBtn.blur();
    updateHud();
    music.start();
  }

  function endRound() {
    state = "over";
    music.stop();
    if (score > best) best = score;
    updateHud();
    overlayTitle.textContent = "Round over";
    overlayText.textContent = "You scored " + score + " points. Session best: " + best + ".";
    startBtn.textContent = "Play again";
    overlay.classList.remove("hidden");
  }

  function showMsg(text, good, gold) {
    msg = text; msgT = gold ? 0.9 : 0.7;
    msgGold = !!gold;
    msgColor = gold ? GOLD : (good ? "rgb(120,230,150)" : "rgb(255,120,120)");
    flash = 0.35; flashGood = good; flashGold = !!gold;
  }

  function mistake(text) {
    miss++;
    AV.hurt = 1;
    showMsg(text, false, false);
    updateHud();
    if (miss >= 3) endRound();
  }

  function binButton(dir) {
    return dir < 0 ? binLeft : (dir > 0 ? binRight : binMid);
  }

  function pressVisual(dir) {
    var b = binButton(dir);
    b.classList.add("pressed");
    setTimeout(function () { b.classList.remove("pressed"); }, 110);
  }

  function sort(dir) {
    if (state !== "play") return;
    window.gameTest.inputsHandled++;
    pressVisual(dir);
    avatarPoint(dir);
    if (!shape) return;
    var t = TYPES[shape.type];
    var gold = !!shape.gold;
    var sp = shapePos(shape.p);
    fliers.push({ type: shape.type, gold: gold, sx: sp.x, sy: sp.y, sz: sp.z, tx: dir * BIN_GAP, ty: BIN_HH * 2 + 0.15, tz: BIN_Z, t: 0, fall: false });
    shape = null;
    spawnDelay = Math.max(0.08, 0.3 - score * 0.004);
    if (t.side === dir) {
      score += gold ? 3 : 1;
      if (score > best) best = score;
      AV.hop = 1;
      showMsg(gold ? "+3" : "+1", true, gold);
      updateHud();
    } else {
      mistake("Wrong bin!");
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
    var R = PLAYER_R;
    for (var i = 0; i < OBST.length; i++) {
      var o = OBST[i];
      var qx = Math.max(o.x0, Math.min(o.x1, player.x));
      var qz = Math.max(o.z0, Math.min(o.z1, player.z));
      var dx = player.x - qx, dz = player.z - qz, d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-8) {
        var d = Math.sqrt(d2), push = (R - d) / d;
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
    player.x = Math.max(ARENA.x0 + R, Math.min(ARENA.x1 - R, player.x));
    player.z = Math.max(ARENA.z0 + R, Math.min(ARENA.z1 - R, player.z));
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
      player.yaw = approachAngle(player.yaw, Math.atan2(vx, vz), dt * 12);
      player.walk += dt * 9 * m;
    }
    player.walkAmt += ((moving ? m : 0) - player.walkAmt) * Math.min(1, dt * 10);
  }

  function update(dt) {
    glowT += dt;
    updateMovement(dt);
    if (state === "play") {
      var r = rate();
      beltOffset = (beltOffset + r * BELT_LEN * dt) % BELT_LEN;
      if (shape) {
        shape.p += r * dt;
        if (shape.p >= 1) {
          var sp = shapePos(1);
          fliers.push({ type: shape.type, gold: !!shape.gold, sx: sp.x, sy: sp.y, sz: sp.z, tx: 0, ty: 0.25, tz: BELT_END - 0.7, t: 0, fall: true });
          shape = null;
          spawnDelay = 0.4;
          mistake("Missed!");
        }
      } else {
        spawnDelay -= dt;
        if (spawnDelay <= 0 && state === "play") spawn();
      }
    }
    for (var i = fliers.length - 1; i >= 0; i--) {
      fliers[i].t += dt / 0.35;
      if (fliers[i].t >= 1) fliers.splice(i, 1);
    }
    if (flash > 0) flash = Math.max(0, flash - dt);
    if (msgT > 0) msgT = Math.max(0, msgT - dt);
    updateAvatar(dt);
  }

  // ---- drawing ----
  function drawShape(type, x, y, s, alpha, gold) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TYPES[type].color;
    if (gold) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = Math.max(1.5, Math.min(5, s * 0.25));
      ctx.shadowColor = "rgba(255,205,60,0.9)";
      ctx.shadowBlur = s * (0.7 + 0.3 * Math.sin(glowT * 6));
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = Math.max(1, Math.min(3, s * 0.12));
    }
    ctx.lineJoin = "round";
    ctx.beginPath();
    var name = TYPES[type].name;
    if (name === "circle") {
      ctx.arc(x, y, s, 0, Math.PI * 2);
    } else if (name === "triangle") {
      ctx.moveTo(x, y - s * 1.1);
      ctx.lineTo(x + s * 1.08, y + s * 0.8);
      ctx.lineTo(x - s * 1.08, y + s * 0.8);
      ctx.closePath();
    } else {
      ctx.rect(x - s * 0.9, y - s * 0.9, s * 1.8, s * 1.8);
    }
    ctx.fill();
    ctx.stroke();
    if (gold) {
      ctx.shadowBlur = 0;
      ctx.shadowColor = "rgba(0,0,0,0)";
    }
    ctx.globalAlpha = 1;
  }

  function seg(ax, ay, az, bx, by, bz) {
    var a = toCam(ax, ay, az), b = toCam(bx, by, bz), t;
    if (a[2] < NEAR && b[2] < NEAR) return;
    if (a[2] < NEAR) {
      t = (NEAR - a[2]) / (b[2] - a[2]);
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR];
    } else if (b[2] < NEAR) {
      t = (NEAR - b[2]) / (a[2] - b[2]);
      b = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, NEAR];
    }
    var sa = cam.f / a[2], sb = cam.f / b[2];
    ctx.moveTo(cam.cx + a[0] * sa, cam.cy - a[1] * sa);
    ctx.lineTo(cam.cx + b[0] * sb, cam.cy - b[1] * sb);
  }

  function groundPoly(pts, style) {
    var cp = [];
    for (var i = 0; i < pts.length; i++) cp.push(toCam(pts[i][0], pts[i][1], pts[i][2]));
    var s = projPoly(cp);
    if (!s) return;
    ctx.fillStyle = style;
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    for (var j = 2; j < s.length; j += 2) ctx.lineTo(s[j], s[j + 1]);
    ctx.closePath();
    ctx.fill();
  }

  function drawGround() {
    var x, z;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath();
    for (x = ARENA.x0 + 1; x < ARENA.x1; x += 2) seg(x, 0, ARENA.z0, x, 0, ARENA.z1);
    for (z = ARENA.z0 + 1; z < ARENA.z1; z += 2) seg(ARENA.x0, 0, z, ARENA.x1, 0, z);
    ctx.stroke();

    ctx.strokeStyle = "rgba(240,192,64,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    seg(ARENA.x0, 0, ARENA.z0, ARENA.x1, 0, ARENA.z0);
    seg(ARENA.x1, 0, ARENA.z0, ARENA.x1, 0, ARENA.z1);
    seg(ARENA.x1, 0, ARENA.z1, ARENA.x0, 0, ARENA.z1);
    seg(ARENA.x0, 0, ARENA.z1, ARENA.x0, 0, ARENA.z0);
    ctx.stroke();

    // belt surface with moving stripes
    var y = BELT_H;
    groundPoly([[-BELT_HW, y, BELT_END], [BELT_HW, y, BELT_END], [BELT_HW, y, BELT_START], [-BELT_HW, y, BELT_START]], "rgb(48,52,62)");
    for (var k = 0; k < BELT_LEN; k++) {
      var sz = BELT_END + (((k - beltOffset) % BELT_LEN) + BELT_LEN) % BELT_LEN;
      var ez = Math.min(BELT_START, sz + 0.18);
      if (ez - sz < 0.02) continue;
      groundPoly([[-BELT_HW, y + 0.005, sz], [BELT_HW, y + 0.005, sz], [BELT_HW, y + 0.005, ez], [-BELT_HW, y + 0.005, ez]], "rgba(255,255,255,0.09)");
    }
    groundPoly([[-BELT_HW, y + 0.01, BELT_END], [BELT_HW, y + 0.01, BELT_END], [BELT_HW, y + 0.01, BELT_END + 0.15], [-BELT_HW, y + 0.01, BELT_END + 0.15]], "rgb(230,80,80)");

    // bot shadow
    var hopY = AV.hop > 0 ? Math.sin((1 - AV.hop) * Math.PI) * 0.35 : 0;
    var sr = 0.6 * (1 - hopY * 0.8), sh = [];
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * Math.PI * 2;
      sh.push([player.x + Math.cos(a) * sr, 0.01, player.z + Math.sin(a) * sr]);
    }
    groundPoly(sh, "rgba(0,0,0," + (0.35 - hopY * 0.4) + ")");
  }

  function addBelt(list) {
    var y = BELT_H, z0, z1, s;
    for (s = 0; s < 6; s++) {
      z0 = BELT_END + s * 2; z1 = z0 + 2;
      addFace(list, [-BELT_HW, 0, z0], [-BELT_HW, 0, z1], [-BELT_HW, y, z1], [-BELT_HW, y, z0], -1, 0, 0, BELT_SIDE);
      addFace(list, [BELT_HW, 0, z0], [BELT_HW, 0, z1], [BELT_HW, y, z1], [BELT_HW, y, z0], 1, 0, 0, BELT_SIDE);
    }
    addFace(list, [-BELT_HW, 0, BELT_END], [BELT_HW, 0, BELT_END], [BELT_HW, y, BELT_END], [-BELT_HW, y, BELT_END], 0, 0, -1, BELT_FRONT);
    addFace(list, [-BELT_HW, 0, BELT_START], [BELT_HW, 0, BELT_START], [BELT_HW, y, BELT_START], [-BELT_HW, y, BELT_START], 0, 0, 1, BELT_SIDE);
  }

  function addBot(list) {
    var hopY = AV.hop > 0 ? Math.sin((1 - AV.hop) * Math.PI) * 0.35 : 0;
    var shake = AV.hurt > 0 ? Math.sin(glowT * 55) * 0.07 * AV.hurt : 0;
    var wa = player.walkAmt, ws = Math.sin(player.walk);
    var bob = Math.sin(glowT * 2.4) * 0.025 * (1 - wa) + Math.abs(Math.cos(player.walk)) * 0.07 * wa;
    var g = {
      px: player.x, pz: player.z,
      c: Math.cos(player.yaw), s: Math.sin(player.yaw),
      ox: shake, oy: hopY + bob, hurt: AV.hurt
    };
    var legSwing = ws * 0.7 * wa;
    // legs
    botBox(list, g, -0.15, 0.36, 0, 0.11, 0.36, 0.13, AV_LEG, -0.15, 0.72, 0, legSwing);
    botBox(list, g, 0.15, 0.36, 0, 0.11, 0.36, 0.13, AV_LEG, 0.15, 0.72, 0, -legSwing);
    // torso, chest panel, back pack with light
    botBox(list, g, 0, 1.05, 0, 0.33, 0.33, 0.2, AV_BODY);
    botBox(list, g, 0, 1.1, 0.215, 0.11, 0.08, 0.02, AV_GOLD);
    botBox(list, g, 0, 1.08, -0.26, 0.2, 0.22, 0.06, AV_DARK);
    botBox(list, g, 0, 1.15, -0.325, 0.07, 0.05, 0.01, (Math.sin(glowT * 4) > 0) ? AV_GOLD : AV_EYE);
    // arms
    var armAmt = Math.min(1, AV.pointT * 2.5);
    var idle = 0.08 + Math.sin(glowT * 2.4) * 0.03;
    var armSwing = ws * 0.55 * wa;
    var rRaise = AV.side >= 0 ? armAmt : 0;
    var lRaise = AV.side <= 0 ? armAmt : 0;
    botBox(list, g, 0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, 0.45, 1.32, idle + rRaise * 0.5, -rRaise * 1.45 + armSwing * (1 - rRaise));
    botBox(list, g, -0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, -0.45, 1.32, -idle - lRaise * 0.5, -lRaise * 1.45 - armSwing * (1 - lRaise));
    // head, visor, eyes
    botBox(list, g, 0, 1.62, 0, 0.27, 0.27, 0.27, AV_HEAD);
    botBox(list, g, 0, 1.64, 0.28, 0.22, 0.09, 0.02, AV_DARK);
    botBox(list, g, -0.1, 1.64, 0.305, 0.05, 0.04, 0.012, AV_EYE);
    botBox(list, g, 0.1, 1.64, 0.305, 0.05, 0.04, 0.012, AV_EYE);
    // antenna
    botBox(list, g, 0, 1.98, 0, 0.025, 0.09, 0.025, AV_DARK);
    botBox(list, g, 0, 2.11, 0, 0.06, 0.06, 0.06, AV_GOLD);
  }

  function buildScene(list) {
    var i, c, d;
    addBelt(list);
    for (d = -1; d <= 1; d++) {
      var t = TYPES[d + 1], col = t.rgb;
      var bx = d * BIN_GAP;
      addBoxW(list, bx, BIN_HH, BIN_Z, BIN_HW, BIN_HH, BIN_HD, [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8], BIN_TOP);
      addShapeBB(list, d + 1, bx, 1.9 + Math.sin(glowT * 2 + d) * 0.08, BIN_Z, 0.36, 0.95, false);
      addTextBB(list, t.label, bx, 1.3, BIN_Z, 0.26, "rgb(233,230,223)");
    }
    for (i = 0; i < CRATES.length; i++) {
      c = CRATES[i];
      addBoxW(list, c[0], c[2], c[1], c[2], c[2], c[2], CRATE_COL, CRATE_TOP);
    }
    for (i = 0; i < PILLARS.length; i++) {
      c = PILLARS[i];
      addBoxW(list, c[0], 2, c[1], 0.5, 2, 0.5, PILLAR_COL, PILLAR_TOP);
      addBoxW(list, c[0], 4.15, c[1], 0.62, 0.15, 0.62, AV_GOLD);
    }
    addBot(list);
    if (shape) {
      var sp = shapePos(shape.p);
      addShapeBB(list, shape.type, sp.x, sp.y, sp.z, SHAPE_R, 1, shape.gold);
    }
    for (i = 0; i < fliers.length; i++) {
      var f = fliers[i], p = f.t;
      var x = f.sx + (f.tx - f.sx) * p;
      var y = f.fall ? f.sy + (f.ty - f.sy) * p * p : f.sy + (f.ty - f.sy) * p + Math.sin(p * Math.PI) * 1.6;
      var z = f.sz + (f.tz - f.sz) * p;
      addShapeBB(list, f.type, x, y, z, SHAPE_R * (1 - p * 0.45), 1 - p * 0.5, f.gold);
    }
  }

  function byDepth(a, b) { return b.d - a.d; }

  function drawList(list) {
    ctx.lineJoin = "round";
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.k === 0) {
        var p = it.pts;
        ctx.fillStyle = it.col;
        ctx.strokeStyle = "rgba(10,12,16,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (var j = 2; j < p.length; j += 2) ctx.lineTo(p[j], p[j + 1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (it.k === 1) {
        drawShape(it.type, it.sx, it.sy, it.r, it.a, it.gold);
      } else {
        ctx.fillStyle = it.color;
        ctx.font = "bold " + Math.round(it.fs) + "px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(it.text, it.sx, it.sy);
      }
    }
  }

  function drawIncoming() {
    if (state !== "play") return;
    var pw = 86, ph = 74, px = 8, py = 8;
    ctx.fillStyle = "rgba(12,13,16,0.6)";
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = "rgb(201,196,184)";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("INCOMING", px + 8, py + 11);
    if (shape) {
      drawShape(shape.type, px + pw / 2, py + 37, 13, 1, shape.gold);
      var bw = pw - 16;
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillRect(px + 8, py + ph - 11, bw, 5);
      ctx.fillStyle = shape.p > 0.75 ? "rgb(230,80,80)" : "rgb(120,230,150)";
      ctx.fillRect(px + 8, py + ph - 11, bw * Math.min(1, shape.p), 5);
    } else {
      ctx.textAlign = "center";
      ctx.fillText("...", px + pw / 2, py + 37);
    }
  }

  function drawStick() {
    if (!stick) return;
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, STICK_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(stick.ox + stick.dx * STICK_R, stick.oy + stick.dy * STICK_R, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw() {
    setupCamera();
    var hy = cam.cy - Math.tan(CAM_PITCH) * cam.f;
    var hc = Math.max(1, Math.min(H, hy));
    var sky = ctx.createLinearGradient(0, hc - H * 0.6, 0, hc);
    sky.addColorStop(0, "rgb(20,22,28)");
    sky.addColorStop(1, "rgb(48,54,70)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    var gy = Math.max(0, Math.min(H, hy));
    ctx.fillStyle = "rgb(33,36,44)";
    ctx.fillRect(0, gy, W, H - gy);

    drawGround();

    var list = [];
    buildScene(list);
    list.sort(byDepth);
    drawList(list);

    if (flash > 0) {
      if (flashGold) ctx.fillStyle = "rgba(255,200,60," + (flash * 0.5) + ")";
      else ctx.fillStyle = flashGood ? "rgba(80,200,120," + (flash * 0.5) + ")" : "rgba(230,70,70," + (flash * 0.8) + ")";
      ctx.fillRect(0, 0, W, H);
    }

    drawStick();
    drawIncoming();

    if (msgT > 0) {
      ctx.globalAlpha = Math.min(1, msgT * 2);
      ctx.fillStyle = msgColor;
      var fs = Math.min(W, H) * (msgGold ? 0.11 : 0.08);
      ctx.font = "bold " + Math.round(fs) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (msgGold) {
        ctx.shadowColor = "rgba(255,205,60,0.9)";
        ctx.shadowBlur = fs * 0.5;
      }
      ctx.fillText(msg, W / 2, H * 0.12);
      if (msgGold) {
        ctx.shadowBlur = 0;
        ctx.shadowColor = "rgba(0,0,0,0)";
      }
      ctx.globalAlpha = 1;
    }
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
      if (!keys[key]) {
        keys[key] = true;
        window.gameTest.inputsHandled++;
      }
      return;
    }
    if (key === "j" || key === "1") {
      e.preventDefault();
      if (!e.repeat) sort(-1);
    } else if (key === "k" || key === "2") {
      e.preventDefault();
      if (!e.repeat) sort(0);
    } else if (key === "l" || key === "3") {
      e.preventDefault();
      if (!e.repeat) sort(1);
    } else if (key === "m") {
      e.preventDefault();
      toggleMusic();
    } else if ((key === "enter" || key === " ") && state !== "play") {
      e.preventDefault();
      window.gameTest.inputsHandled++;
      startRound();
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
    if (state === "play") return;
    window.gameTest.inputsHandled++;
    startRound();
  });

  musicBtn.addEventListener("click", function () { toggleMusic(); musicBtn.blur(); });

  binLeft.addEventListener("click", function () { sort(-1); binLeft.blur(); });
  binMid.addEventListener("click", function () { sort(0); binMid.blur(); });
  binRight.addEventListener("click", function () { sort(1); binRight.blur(); });

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
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    window.gameTest.inputsHandled++;
    if (e.pointerType !== "mouse" && lx < r.width / 2 && stickId === null) {
      stickId = e.pointerId;
      stick = { ox: lx, oy: ly, dx: 0, dy: 0 };
    } else {
      lookers[e.pointerId] = { x: e.clientX };
    }
  });

  canvas.addEventListener("pointermove", function (e) {
    if (e.pointerId === stickId && stick) {
      var r = canvas.getBoundingClientRect();
      setStick(e.clientX - r.left, e.clientY - r.top);
      return;
    }
    var l = lookers[e.pointerId];
    if (l) {
      camYaw += (e.clientX - l.x) * DRAG_TURN;
      l.x = e.clientX;
    }
  });

  function endPointer(e) {
    if (e.pointerId === stickId) { stickId = null; stick = null; }
    delete lookers[e.pointerId];
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  window.addEventListener("resize", resize);
  resize();
  updateHud();
  updateMusicBtn();
  requestAnimationFrame(frame);
})();
