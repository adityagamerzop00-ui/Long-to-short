
      /* UI sound engine: its own AudioContext, wired only to the speakers, never to the recorder's graph. */
      (function () {
        var d = document, U = { ctx: null, out: null, nz: null, on: true, vol: 0.4, lastTock: 0, popT: 0 };
        try { U.on = localStorage.getItem("uiSnd") !== "off"; } catch (e) {}
        function start() {
          if (!U.ctx) {
            var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
            try { U.ctx = new AC(); U.out = U.ctx.createGain(); U.out.gain.value = U.vol; U.out.connect(U.ctx.destination); } catch (e) { U.ctx = null; return; }
          }
          if (U.ctx.state === "suspended") U.ctx.resume().catch(function () {});
        }
        ["pointerdown", "keydown", "touchstart"].forEach(function (t) { d.addEventListener(t, start, true); });
        function env(g, t, peak, dur) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
        function tone(f1, f2, dur, type, peak, at, lp) {
          var c = U.ctx, t = c.currentTime + (at || 0), o = c.createOscillator(), g = c.createGain(), n = o;
          o.type = type || "sine"; o.frequency.setValueAtTime(f1, t);
          if (f2 && f2 !== f1) o.frequency.exponentialRampToValueAtTime(f2, t + dur * 0.8);
          if (lp) { var f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; o.connect(f); n = f; }
          env(g, t, peak, dur); n.connect(g); g.connect(U.out); o.start(t); o.stop(t + dur + 0.02);
        }
        function swish() {
          var c = U.ctx, t = c.currentTime, dur = 0.18;
          if (!U.nz) { U.nz = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate); var a = U.nz.getChannelData(0); for (var i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1; }
          var s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
          s.buffer = U.nz; f.type = "bandpass"; f.Q.value = 1.2;
          f.frequency.setValueAtTime(500, t); f.frequency.exponentialRampToValueAtTime(3800, t + dur);
          env(g, t, 0.22, dur); s.connect(f); f.connect(g); g.connect(U.out); s.start(t); s.stop(t + dur + 0.02);
        }
        var SND = {
          tick: function () { tone(900, 900, 0.06, "sine", 0.22); },
          tock: function (r) { tone(260 + r * 640, 0, 0.07, "triangle", 0.16); },
          swish: swish,
          chime: function () { tone(1318.5, 0, 0.14, "sine", 0.14); tone(1975.5, 0, 0.16, "sine", 0.13, 0.09); },
          on: function () { tone(480, 920, 0.11, "sine", 0.2); },
          off: function () { tone(920, 480, 0.11, "sine", 0.2); },
          pop: function () { tone(260, 780, 0.08, "sine", 0.26); },
          success: function () { [523.25, 659.25, 783.99].forEach(function (f, i) { tone(f, 0, 0.11, "triangle", 0.18, i * 0.07); }); },
          buzz: function () { tone(110, 98, 0.22, "sawtooth", 0.12, 0, 520); },
          sparkle: function () { [1568, 2093, 2637, 3136].forEach(function (f, i) { tone(f, 0, 0.09, "triangle", 0.1, i * 0.04); }); }
        };
        function play(n, x) { if (!U.on || U.vol <= 0) return; start(); if (!U.ctx || !SND[n]) return; try { SND[n](x); } catch (e) {} }
        function pop() { clearTimeout(U.popT); U.popT = setTimeout(function () { play("pop"); }, 400); }
        window.uiSound = play;

        var btn = d.getElementById("uisnd"), vol = d.getElementById("uivol");
        function paint() { btn.textContent = U.on ? "🔊" : "🔇"; btn.setAttribute("aria-pressed", U.on ? "true" : "false"); btn.setAttribute("aria-label", U.on ? "UI sounds on" : "UI sounds off"); }
        paint();
        function setVol() { U.vol = +vol.value / 100; d.getElementById("uivolv").textContent = vol.value; if (U.out) U.out.gain.setTargetAtTime(U.vol, U.ctx.currentTime, 0.02); }

        var isEdit = function (el) { return el.matches("#tstart, #tend, #bhook, .x-cap input, .x-cap textarea"); };
        d.addEventListener("click", function (e) {
          var el = e.target.closest("button, a.btn, a.x-btn, summary"); if (!el) return;
          if (el === btn) { U.on = !U.on; try { localStorage.setItem("uiSnd", U.on ? "on" : "off"); } catch (e2) {} paint(); play("tick"); return; }
          if (el.id === "welcomeDone") play("sparkle");
          else if (el.matches(".x-tpl")) play("chime");
          else if (el.matches("[data-go], [role=tab], summary")) play("swish");
          else play("tick");
        });
        d.addEventListener("input", function (e) {
          var el = e.target;
          if (el === vol) setVol();
          if (el.type === "range") {
            var now = Date.now(); if (now - U.lastTock < 60) return; U.lastTock = now;
            var lo = +el.min || 0, hi = +el.max || 100; play("tock", hi > lo ? (+el.value - lo) / (hi - lo) : 0.5);
          } else if (isEdit(el)) pop();
        });
        d.addEventListener("change", function (e) {
          var el = e.target;
          if (el.type === "checkbox" && el.getAttribute("role") === "switch") play(el.checked ? "on" : "off");
          else if (el.type === "radio" || el.tagName === "SELECT") play("chime");
          else if (el.type === "checkbox") play("tick");
          else if (isEdit(el)) pop();
        });
        var boxDown = false;
        d.addEventListener("pointerdown", function (e) { boxDown = !!(e.target.closest && e.target.closest(".x-box")); }, true);
        d.addEventListener("pointerup", function () { if (boxDown) { boxDown = false; pop(); } }, true);

        var clips = d.getElementById("clips");
        if (clips && window.MutationObserver) new MutationObserver(function (ms) {
          ms.forEach(function (m) {
            var el = m.target, old = m.oldValue || "";
            if (!el.classList || !el.classList.contains("x-clip")) return;
            if (el.classList.contains("is-done") && old.indexOf("is-done") < 0) play("success");
            if (el.classList.contains("is-failed") && old.indexOf("is-failed") < 0) play("buzz");
          });
        }).observe(clips, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
        window.addEventListener("error", function () { play("buzz"); });
      })();
    