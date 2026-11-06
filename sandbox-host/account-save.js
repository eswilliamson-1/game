// Uploaded by the deploy script. The AI builder can't change this file.
// It is the game's only link to the voting site. The site holds the player's save
// and never tells the game who the player is. Outside the site, nothing is saved.
(function () {
  var SITE = "https://vote.ewpages.com";
  var MAX_CHARS = 32000;
  var WAIT_MS = 4000;
  var embedded = window.parent !== window;
  var waiting = {};
  var nextId = 1;

  function ask(message, fallback) {
    if (!embedded) return Promise.resolve(fallback);
    return new Promise(function (resolve) {
      var id = nextId++;
      var finish = function (value) {
        clearTimeout(timer);
        delete waiting[id];
        resolve(value);
      };
      var timer = setTimeout(function () { finish(fallback); }, WAIT_MS);
      waiting[id] = finish;
      message.id = id;
      window.parent.postMessage(message, SITE);
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== SITE) return;
    var reply = event.data;
    if (reply && reply.type === "game-save:reply" && waiting[reply.id]) waiting[reply.id](reply.value);
  });

  window.gameSave = Object.freeze({
    load: function () {
      return ask({ type: "game-save:load" }, null);
    },
    store: function (text) {
      if (typeof text !== "string" || text.length > MAX_CHARS) return Promise.resolve(false);
      return ask({ type: "game-save:store", data: text }, false);
    },
  });
})();
