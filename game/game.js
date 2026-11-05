(function () {
  "use strict";

  var GOAL = "Sort each shape into its matching bin before it reaches the end. Three mistakes ends the round.";
  window.gameTest = { inputsHandled: 0, goal: GOAL };

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
  var binRight = document.getElementById("binRight");

  goalEl.textContent = GOAL;

  var TYPES = [
    { name: "circle", color: "hsl(28, 92%, 60%)", side: -1 },
    { name: "square", color: "hsl(180, 60%, 45%)", side: 1 }
  ];

  var SCALE = 2;
  var W = 300, H = 400;

  var state = "ready";
  var score = 0, best = 0, miss = 0;
  var shape = null;
  var spawnDelay = 0;
  var fliers = [];
  var flash = 0, flashGood = true;
  var msg = "", msgT = 0;
  var beltOffset = 0;
  var lastType = -1, sameCount = 0;

  function resize() {
    var r = stage.getBoundingClientRect();
    W = Math.max(200, r.width);
    H = Math.max(240, r.height);
    canvas.width = Math.round(W * SCALE);
    canvas.height = Math.round(H * SCALE);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  }

  function endY() { return H * 0.68; }
  function size() { return Math.min(W, H) * 0.1; }
  function speed() { return (0.2 + Math.min(score, 60) * 0.017) * H; }

  function binRect(dir) {
    var bw = W * 0.36, bh = H * 0.2;
    var y = H * 0.78;
    var x = dir < 0 ? W * 0.04 : W * 0.96 - bw;
    return { x: x, y: y, w: bw, h: bh };
  }

  function updateHud() {
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
    missEl.textContent = String(miss);
  }

  function spawn() {
    var t = Math.random() < 0.5 ? 0 : 1;
    if (t === lastType) {
      sameCount++;
      if (sameCount >= 3) { t = 1 - t; sameCount = 0; }
    } else {
      sameCount = 0;
    }
    lastType = t;
    shape = { type: t, x: W / 2, y: -size() };
  }

  function startRound() {
    score = 0; miss = 0; shape = null; fliers = [];
    spawnDelay = 0.5; msg = ""; msgT = 0; flash = 0;
    lastType = -1; sameCount = 0;
    state = "play";
    overlay.classList.add("hidden");
    startBtn.blur();
    updateHud();
  }

  function endRound() {
    state = "over";
    if (score > best) best = score;
    updateHud();
    overlayTitle.textContent = "Round over";
    overlayText.textContent = "You sorted " + score + " shapes. Session best: " + best + ".";
    startBtn.textContent = "Play again";
    overlay.classList.remove("hidden");
  }

  function showMsg(text, good) {
    msg = text; msgT = 0.7;
    flash = 0.35; flashGood = good;
  }

  function mistake(text) {
    miss++;
    showMsg(text, false);
    updateHud();
    if (miss >= 3) endRound();
  }

  function pressVisual(dir) {
    var b = dir < 0 ? binLeft : binRight;
    b.classList.add("pressed");
    setTimeout(function () { b.classList.remove("pressed"); }, 110);
  }

  function sort(dir) {
    if (state !== "play") return;
    window.gameTest.inputsHandled++;
    pressVisual(dir);
    if (!shape) return;
    var t = TYPES[shape.type];
    var r = binRect(dir);
    fliers.push({ type: shape.type, sx: shape.x, sy: shape.y, tx: r.x + r.w / 2, ty: r.y + r.h * 0.45, t: 0, good: t.side === dir, fall: false });
    shape = null;
    spawnDelay = Math.max(0.08, 0.3 - score * 0.004);
    if (t.side === dir) {
      score++;
      if (score > best) best = score;
      showMsg("+1", true);
      updateHud();
    } else {
      mistake("Wrong bin!");
    }
  }

  function update(dt) {
    if (state === "play") {
      var sp = speed();
      beltOffset = (beltOffset + sp * dt) % 40;
      if (shape) {
        shape.y += sp * dt;
        if (shape.y >= endY()) {
          fliers.push({ type: shape.type, sx: shape.x, sy: shape.y, tx: shape.x, ty: H + size() * 2, t: 0, good: false, fall: true });
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
  }

  function drawShape(type, x, y, s, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TYPES[type].color;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (TYPES[type].name === "circle") {
      ctx.arc(x, y, s, 0, Math.PI * 2);
    } else {
      ctx.rect(x - s * 0.9, y - s * 0.9, s * 1.8, s * 1.8);
    }
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawBin(dir) {
    var r = binRect(dir);
    var type = dir < 0 ? 0 : 1;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.strokeStyle = TYPES[type].color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
    drawShape(type, r.x + r.w * 0.22, r.y + r.h * 0.5, Math.min(r.h, r.w) * 0.16, 0.9);
    ctx.fillStyle = "rgb(233,230,223)";
    ctx.font = "bold " + Math.round(Math.min(r.h * 0.22, r.w * 0.13)) + "px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(dir < 0 ? "CIRCLES" : "SQUARES", r.x + r.w * 0.4, r.y + r.h * 0.5);
  }

  function draw() {
    ctx.fillStyle = "rgb(28,31,37)";
    ctx.fillRect(0, 0, W, H);

    if (flash > 0) {
      ctx.fillStyle = flashGood ? "rgba(80,200,120," + (flash * 0.5) + ")" : "rgba(230,70,70," + (flash * 0.8) + ")";
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
    var ay = H * 0.74;
    ctx.beginPath();
    ctx.moveTo(W * 0.4, ay); ctx.lineTo(W * 0.24, ay);
    ctx.moveTo(W * 0.28, ay - 6); ctx.lineTo(W * 0.24, ay); ctx.lineTo(W * 0.28, ay + 6);
    ctx.moveTo(W * 0.6, ay); ctx.lineTo(W * 0.76, ay);
    ctx.moveTo(W * 0.72, ay - 6); ctx.lineTo(W * 0.76, ay); ctx.lineTo(W * 0.72, ay + 6);
    ctx.stroke();

    drawBin(-1);
    drawBin(1);

    if (shape) drawShape(shape.type, shape.x, shape.y, size(), 1);

    for (var i = 0; i < fliers.length; i++) {
      var f = fliers[i];
      var p = f.t;
      var x = f.sx + (f.tx - f.sx) * p;
      var yy = f.sy + (f.ty - f.sy) * p - (f.fall ? 0 : Math.sin(p * Math.PI) * H * 0.08);
      drawShape(f.type, x, yy, size() * (1 - p * 0.45), 1 - p * 0.5);
    }

    if (msgT > 0) {
      ctx.globalAlpha = Math.min(1, msgT * 2);
      ctx.fillStyle = msg === "+1" ? "rgb(120,230,150)" : "rgb(255,120,120)";
      ctx.font = "bold " + Math.round(Math.min(W, H) * 0.08) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg, W / 2, H * 0.12);
      ctx.globalAlpha = 1;
    }
  }

  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    update(dt);
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

  binLeft.addEventListener("click", function () { sort(-1); binLeft.blur(); });
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
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      var r = canvas.getBoundingClientRect();
      sort(e.clientX - r.left < r.width / 2 ? -1 : 1);
    }
  });
  canvas.addEventListener("pointercancel", function () { down = null; });

  window.addEventListener("resize", resize);
  resize();
  updateHud();
  requestAnimationFrame(frame);
})();
