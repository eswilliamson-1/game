(function () {
  "use strict";

  var GOAL = "Sort each shape into its matching bin before it reaches the end. Gold shapes are worth 3 points. Three mistakes ends the round.";
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
    { name: "circle", color: "hsl(28, 92%, 60%)", side: -1, label: "CIRCLES" },
    { name: "triangle", color: "hsl(325, 70%, 62%)", side: 0, label: "TRIANGLES" },
    { name: "square", color: "hsl(180, 60%, 45%)", side: 1, label: "SQUARES" }
  ];

  var GOLD = "rgb(255,212,70)";
  var GOLD_CHANCE = 1 / 15;

  var SCALE = 2;
  var W = 300, H = 400;

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

  // ---- 3D avatar (the player's sorter bot) ----
  var AV = { yaw: 0, pointT: 0, side: 1, hop: 0, hurt: 0 };
  var AV_FACES = [[4, 5, 7, 6], [1, 0, 2, 3], [5, 1, 3, 7], [0, 4, 6, 2], [6, 7, 3, 2], [0, 1, 5, 4]];
  var AV_D = 5, AV_PITCH = 0.32;
  var AV_L = (function () {
    var x = -0.45, y = 0.75, z = 0.6, m = Math.sqrt(x * x + y * y + z * z);
    return [x / m, y / m, z / m];
  })();
  var AV_BODY = [150, 122, 215], AV_HEAD = [226, 222, 210], AV_DARK = [34, 38, 50];
  var AV_EYE = [120, 230, 255], AV_LEG = [84, 90, 108], AV_GOLD = [255, 212, 70];

  function avatarPoint(dir) { AV.side = dir; AV.pointT = 1; }

  function updateAvatar(dt) {
    if (AV.pointT > 0) AV.pointT = Math.max(0, AV.pointT - dt / 0.45);
    if (AV.hop > 0) AV.hop = Math.max(0, AV.hop - dt / 0.35);
    if (AV.hurt > 0) AV.hurt = Math.max(0, AV.hurt - dt / 0.5);
    var target;
    if (state === "play") target = AV.pointT > 0 ? AV.side * 0.85 : 0;
    else target = Math.sin(glowT * 0.9) * 0.7;
    AV.yaw += (target - AV.yaw) * Math.min(1, dt * 14);
  }

  function tint(col, h) {
    var m = h * 0.6;
    return [col[0] + (235 - col[0]) * m, col[1] + (70 - col[1]) * m, col[2] + (70 - col[2]) * m];
  }

  function addBox(list, g, cx, cy, cz, hx, hy, hz, col, px, py, rz, rx) {
    var v = [];
    var cz1 = Math.cos(rz || 0), sz1 = Math.sin(rz || 0);
    var cx1 = Math.cos(rx || 0), sx1 = Math.sin(rx || 0);
    var i, x, y, z, dx, dy;
    for (i = 0; i < 8; i++) {
      x = cx + ((i & 1) ? hx : -hx);
      y = cy + ((i & 2) ? hy : -hy);
      z = cz + ((i & 4) ? hz : -hz);
      if (rz) {
        dx = x - px; dy = y - py;
        x = px + dx * cz1 - dy * sz1;
        y = py + dx * sz1 + dy * cz1;
      }
      if (rx) {
        dy = y - py;
        var nz = dy * sx1 + z * cx1;
        y = py + dy * cx1 - z * sx1;
        z = nz;
      }
      x += g.ox; y += g.oy;
      var x1 = x * g.cyaw + z * g.syaw;
      var z1 = -x * g.syaw + z * g.cyaw;
      var y1 = y - 1;
      v.push([x1, y1 * g.cp - z1 * g.sp, y1 * g.sp + z1 * g.cp]);
    }
    var c = tint(col, g.hurt);
    for (var f = 0; f < 6; f++) {
      var idx = AV_FACES[f];
      var a = v[idx[0]], b = v[idx[1]], d = v[idx[2]];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
      var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nzz = ux * wy - uy * wx;
      if (nx * (-a[0]) + ny * (-a[1]) + nzz * (AV_D - a[2]) <= 0) continue;
      var nl = Math.sqrt(nx * nx + ny * ny + nzz * nzz) || 1;
      var lit = (nx * AV_L[0] + ny * AV_L[1] + nzz * AV_L[2]) / nl;
      var shade = 0.38 + 0.62 * Math.max(0, lit);
      var zsum = 0, pts = [];
      for (var j = 0; j < 4; j++) {
        var p = v[idx[j]];
        zsum += p[2];
        var sc = AV_D / (AV_D - p[2]);
        pts.push(g.scrX + p[0] * sc * g.k, g.scrY - p[1] * sc * g.k);
      }
      list.push({
        pts: pts,
        z: zsum / 4,
        col: "rgb(" + Math.round(c[0] * shade) + "," + Math.round(c[1] * shade) + "," + Math.round(c[2] * shade) + ")"
      });
    }
  }

  function drawAvatar() {
    var k = Math.min(H * 0.08, W * 0.085);
    var hopY = AV.hop > 0 ? Math.sin((1 - AV.hop) * Math.PI) * 0.28 : 0;
    var shake = AV.hurt > 0 ? Math.sin(glowT * 55) * 0.07 * AV.hurt : 0;
    var bob = Math.sin(glowT * 2.4) * 0.025;
    var g = {
      ox: shake, oy: hopY + bob,
      cyaw: Math.cos(AV.yaw), syaw: Math.sin(AV.yaw),
      cp: Math.cos(AV_PITCH), sp: Math.sin(AV_PITCH),
      k: k, scrX: W * 0.16, scrY: H * 0.64 - k, hurt: AV.hurt
    };

    // floor shadow
    var fsc = AV_D / (AV_D + g.sp);
    var footY = g.scrY + g.cp * fsc * k;
    ctx.fillStyle = "rgba(0,0,0," + (0.35 - hopY * 0.6) + ")";
    ctx.beginPath();
    ctx.ellipse(g.scrX, footY, k * 0.55 * (1 - hopY), k * 0.17 * (1 - hopY), 0, 0, Math.PI * 2);
    ctx.fill();

    var list = [];
    var armAmt = Math.min(1, AV.pointT * 2.5);
    var idle = 0.08 + Math.sin(glowT * 2.4) * 0.03;
    var near = -AV.side; // the arm closer to the viewer when turned

    // legs
    addBox(list, g, -0.15, 0.36, 0, 0.11, 0.36, 0.13, AV_LEG);
    addBox(list, g, 0.15, 0.36, 0, 0.11, 0.36, 0.13, AV_LEG);
    // torso + chest panel
    addBox(list, g, 0, 1.05, 0, 0.33, 0.33, 0.2, AV_BODY);
    addBox(list, g, 0, 1.1, 0.215, 0.11, 0.08, 0.02, AV_GOLD);
    // arms
    var rRx, lRx;
    if (AV.side === 0) {
      rRx = -armAmt * 1.2;
      lRx = -armAmt * 1.2;
    } else {
      rRx = (near > 0) ? -armAmt * 1.45 : 0;
      lRx = (near < 0) ? -armAmt * 1.45 : 0;
    }
    addBox(list, g, 0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, 0.45, 1.32, idle, rRx);
    addBox(list, g, -0.45, 1.03, 0, 0.1, 0.32, 0.11, AV_BODY, -0.45, 1.32, -idle, lRx);
    // head, visor, eyes
    addBox(list, g, 0, 1.62, 0, 0.27, 0.27, 0.27, AV_HEAD);
    addBox(list, g, 0, 1.64, 0.28, 0.22, 0.09, 0.02, AV_DARK);
    addBox(list, g, -0.1, 1.64, 0.305, 0.05, 0.04, 0.012, AV_EYE);
    addBox(list, g, 0.1, 1.64, 0.305, 0.05, 0.04, 0.012, AV_EYE);
    // antenna
    addBox(list, g, 0, 1.98, 0, 0.025, 0.09, 0.025, AV_DARK);
    addBox(list, g, 0, 2.11, 0, 0.06, 0.06, 0.06, AV_GOLD);

    list.sort(function (a, b) { return a.z - b.z; });
    ctx.lineJoin = "round";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(10,12,16,0.35)";
    for (var i = 0; i < list.length; i++) {
      var p = list[i].pts;
      ctx.fillStyle = list[i].col;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]);
      ctx.lineTo(p[6], p[7]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function resize() {
    var r = stage.getBoundingClientRect();
    W = Math.max(200, r.width);
    H = Math.max(240, r.height);
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  }

  function endY() { return H * 0.66; }
  function size() { return Math.min(W, H) * 0.1; }
  function speed() { return (0.2 + Math.min(score, 60) * 0.017) * H; }

  function binRect(dir) {
    var bw = W * 0.3, bh = H * 0.2;
    var y = H * 0.78;
    var x = W / 2 - bw / 2 + dir * W * 0.325;
    return { x: x, y: y, w: bw, h: bh };
  }

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
    shape = { type: t, x: W / 2, y: -size(), gold: Math.random() < GOLD_CHANCE };
  }

  function startRound() {
    score = 0; miss = 0; shape = null; fliers = [];
    spawnDelay = 0.5; msg = ""; msgT = 0; flash = 0;
    lastType = -1; sameCount = 0;
    AV.pointT = 0; AV.hop = 0; AV.hurt = 0;
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
    var r = binRect(dir);
    fliers.push({ type: shape.type, gold: gold, sx: shape.x, sy: shape.y, tx: r.x + r.w / 2, ty: r.y + r.h * 0.45, t: 0, good: t.side === dir, fall: false });
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

  function update(dt) {
    glowT += dt;
    if (state === "play") {
      var sp = speed();
      beltOffset = (beltOffset + sp * dt) % 40;
      if (shape) {
        shape.y += sp * dt;
        if (shape.y >= endY()) {
          fliers.push({ type: shape.type, gold: !!shape.gold, sx: shape.x, sy: shape.y, tx: shape.x, ty: H + size() * 2, t: 0, good: false, fall: true });
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
      fliers[i].t += dt / 0.3;
      if (fliers[i].t >= 1) fliers.splice(i, 1);
    }
    if (flash > 0) flash = Math.max(0, flash - dt);
    if (msgT > 0) msgT = Math.max(0, msgT - dt);
    updateAvatar(dt);
  }

  function drawShape(type, x, y, s, alpha, gold) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TYPES[type].color;
    if (gold) {
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 5;
      ctx.shadowColor = "rgba(255,205,60,0.9)";
      ctx.shadowBlur = s * (0.7 + 0.3 * Math.sin(glowT * 6));
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 3;
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

  function drawBin(dir) {
    var r = binRect(dir);
    var type = dir + 1;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.strokeStyle = TYPES[type].color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
    drawShape(type, r.x + r.w * 0.5, r.y + r.h * 0.38, Math.min(r.h, r.w) * 0.17, 0.9, false);
    ctx.fillStyle = "rgb(233,230,223)";
    ctx.font = "bold " + Math.round(Math.min(r.h * 0.18, r.w * 0.115)) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(TYPES[type].label, r.x + r.w / 2, r.y + r.h * 0.8);
  }

  function draw() {
    ctx.fillStyle = "rgb(28,31,37)";
    ctx.fillRect(0, 0, W, H);

    if (flash > 0) {
      if (flashGold) ctx.fillStyle = "rgba(255,200,60," + (flash * 0.5) + ")";
      else ctx.fillStyle = flashGood ? "rgba(80,200,120," + (flash * 0.5) + ")" : "rgba(230,70,70," + (flash * 0.8) + ")";
      ctx.fillRect(0, 0, W, H);
    }

    var bw = W * 0.34, bx = W / 2 - bw / 2, ey = endY();
    ctx.fillStyle = "rgb(44,48,57)";
    ctx.fillRect(bx, 0, bw, ey + size() * 0.6);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 6;
    for (var y = -40 + beltOffset; y < ey + size(); y += 40) {
      ctx.beginPath();
      ctx.moveTo(bx, y);
      ctx.lineTo(bx + bw, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgb(70,75,88)";
    ctx.fillRect(bx - 4, 0, 4, ey + size() * 0.6);
    ctx.fillRect(bx + bw, 0, 4, ey + size() * 0.6);

    ctx.strokeStyle = "rgb(230,80,80)";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(bx - 10, ey + size() * 0.6);
    ctx.lineTo(bx + bw + 10, ey + size() * 0.6);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 4;
    var ay = H * 0.745;
    var dy0 = Math.max(H * 0.725, ey + size() * 0.6 + 6), dy1 = H * 0.77;
    ctx.beginPath();
    ctx.moveTo(W * 0.4, ay); ctx.lineTo(W * 0.24, ay);
    ctx.moveTo(W * 0.28, ay - 6); ctx.lineTo(W * 0.24, ay); ctx.lineTo(W * 0.28, ay + 6);
    ctx.moveTo(W * 0.6, ay); ctx.lineTo(W * 0.76, ay);
    ctx.moveTo(W * 0.72, ay - 6); ctx.lineTo(W * 0.76, ay); ctx.lineTo(W * 0.72, ay + 6);
    if (dy1 - dy0 > 6) {
      ctx.moveTo(W / 2, dy0); ctx.lineTo(W / 2, dy1);
      ctx.moveTo(W / 2 - 6, dy1 - 6); ctx.lineTo(W / 2, dy1); ctx.lineTo(W / 2 + 6, dy1 - 6);
    }
    ctx.stroke();

    drawBin(-1);
    drawBin(0);
    drawBin(1);

    drawAvatar();

    if (shape) drawShape(shape.type, shape.x, shape.y, size(), 1, shape.gold);

    for (var i = 0; i < fliers.length; i++) {
      var f = fliers[i];
      var p = f.t;
      var x = f.sx + (f.tx - f.sx) * p;
      var yy = f.sy + (f.ty - f.sy) * p - (f.fall ? 0 : Math.sin(p * Math.PI) * H * 0.08);
      drawShape(f.type, x, yy, size() * (1 - p * 0.45), 1 - p * 0.5, f.gold);
    }

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

  document.addEventListener("keydown", function (e) {
    var k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") {
      e.preventDefault();
      sort(-1);
    } else if (k === "ArrowRight" || k === "d" || k === "D") {
      e.preventDefault();
      sort(1);
    } else if (k === "ArrowDown" || k === "s" || k === "S") {
      e.preventDefault();
      sort(0);
    } else if (k === "m" || k === "M") {
      e.preventDefault();
      toggleMusic();
    } else if ((k === "Enter" || k === " ") && state !== "play") {
      e.preventDefault();
      window.gameTest.inputsHandled++;
      startRound();
    }
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

  var down = null;
  canvas.addEventListener("pointerdown", function (e) {
    down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.preventDefault();
  });
  canvas.addEventListener("pointerup", function (e) {
    if (!down || down.id !== e.pointerId) return;
    var dx = e.clientX - down.x, dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) {
      sort(dx < 0 ? -1 : 1);
    } else if (dy > 30 && dy > Math.abs(dx)) {
      sort(0);
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      var r = canvas.getBoundingClientRect();
      var rel = (e.clientX - r.left) / (r.width || 1);
      sort(rel < 1 / 3 ? -1 : (rel > 2 / 3 ? 1 : 0));
    }
  });
  canvas.addEventListener("pointercancel", function () { down = null; });

  window.addEventListener("resize", resize);
  resize();
  updateHud();
  updateMusicBtn();
  requestAnimationFrame(frame);
})();
