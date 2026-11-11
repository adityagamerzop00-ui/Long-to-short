
      (function () {
        "use strict";
        var $ = function (id) { return document.getElementById(id); };
        var MIMES = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
        var unsupported = (function () {
          if (typeof window.MediaRecorder === "undefined") return true;
          var c = document.createElement("canvas");
          return typeof c.captureStream !== "function";
        })();
        var MIME = "";
        if (!unsupported) {
          for (var m = 0; m < MIMES.length; m++) {
            try { if (MediaRecorder.isTypeSupported(MIMES[m])) { MIME = MIMES[m]; break; } } catch (e) {}
          }
        }
        var EXT = MIME.indexOf("mp4") > -1 ? "mp4" : "webm";
        var BLOBTYPE = MIME ? MIME.split(";")[0] : "video/webm";
        if (unsupported) $("unsupported").classList.remove("x-hidden");

        var preview = $("preview"), rec = $("rec"), thumbv = $("thumbv");
        var S = { url: null, name: "", duration: 0, vw: 0, vh: 0, step: 1, segs: [], sig: "", busy: false, abort: false, paused: false, thumbToken: 0, built: null };
        var BOX = { A: { x: 0.68, y: 0.62, w: 0.3, h: 0.35 }, B: { x: 0.02, y: 0.03, w: 0.64, h: 0.94 }, C: { x: 0.35, y: 0, w: 0.3, h: 1 } };

        /* ---------- helpers ---------- */
        function pad(n) { return String(n).padStart(2, "0"); }
        function fmt(t, forceH) {
          t = Math.max(0, Math.round(t));
          var h = Math.floor(t / 3600), mi = Math.floor((t % 3600) / 60), s = t % 60;
          return h || forceH ? pad(h) + ":" + pad(mi) + ":" + pad(s) : pad(mi) + ":" + pad(s);
        }
        function parseTime(str) {
          str = (str || "").trim();
          if (!str) return null;
          var parts = str.split(":");
          if (parts.length > 3) return NaN;
          var total = 0;
          for (var i = 0; i < parts.length; i++) {
            if (!/^\d+(\.\d+)?$/.test(parts[i])) return NaN;
            total = total * 60 + parseFloat(parts[i]);
          }
          return total;
        }
        function eta(sec) {
          sec = Math.max(0, Math.round(sec));
          if (sec < 60) return "about " + sec + " s left";
          var mins = Math.round(sec / 60);
          if (mins < 60) return "about " + mins + " min left";
          return "about " + Math.floor(mins / 60) + " h " + (mins % 60) + " min left";
        }
        function dur(sec) {
          var mins = Math.round(sec / 60);
          if (sec < 60) return Math.round(sec) + " s";
          if (mins < 60) return mins + " min";
          return Math.floor(mins / 60) + " h " + (mins % 60) + " min";
        }
        function show(el, on) { el.classList.toggle("x-hidden", !on); }
        function alertMsg(el, title, text) {
          if (!title) { show(el, false); el.textContent = ""; return; }
          el.innerHTML = "";
          var s = document.createElement("strong"); s.textContent = title;
          var p = document.createElement("p"); p.textContent = text || "";
          el.appendChild(s); el.appendChild(p); show(el, true);
        }
        function once(el, ev, ms) {
          return new Promise(function (res, rej) {
            var to;
            function ok() { clean(); res(); }
            function bad() { clean(); rej(new Error("load")); }
            function clean() { el.removeEventListener(ev, ok); el.removeEventListener("error", bad); clearTimeout(to); }
            el.addEventListener(ev, ok); el.addEventListener("error", bad);
            if (ms) to = setTimeout(ok, ms);
          });
        }
        function seekTo(v, t) {
          return new Promise(function (res) {
            var done = false, to;
            function fin() {
              if (done) return; done = true;
              v.removeEventListener("seeked", fin); clearTimeout(to);
              if (v.readyState >= 2) res();
              else once(v, "canplay", 3000).then(res, res);
            }
            v.addEventListener("seeked", fin);
            to = setTimeout(fin, 8000);
            if (Math.abs(v.currentTime - t) < 0.001) t += 0.001;
            v.currentTime = t;
          });
        }
        function ready(v) { return v.readyState >= 2 ? Promise.resolve() : once(v, "loadeddata", 10000); }

        /* ---------- settings ---------- */
        function settings() {
          var len = +document.querySelector('input[name="len"]:checked').value;
          var format = document.querySelector('input[name="fmt"]:checked').value;
          var crop = +$("crop").value;
          var label = $("label").checked;
          var st = parseTime($("tstart").value), en = parseTime($("tend").value);
          var error = "";
          if (Number.isNaN(st) || Number.isNaN(en)) error = "Write times like 01:30 or 00:01:30.";
          if (st == null || Number.isNaN(st)) st = 0;
          if (en == null || Number.isNaN(en)) en = S.duration;
          st = Math.min(st, S.duration); en = Math.min(en, S.duration);
          if (!error && en - st < 10) error = "The end time must be at least 10 seconds after the start time.";
          var max = Math.round(+$("maxclips").value);
          if (!isFinite(max) || max < 1) max = 1;
          max = Math.min(200, max);
          var ratio = Math.max(20, Math.min(50, +$("ratio").value || 35));
          return {
            len: len, format: format, crop: crop, label: label, start: st, end: en, error: error, max: max,
            ratio: ratio, swap: $("swap").checked,
            boxA: Object.assign({}, BOX.A), boxB: Object.assign({}, BOX.B), boxC: Object.assign({}, BOX.C)
          };
        }
        function segments(st, en, len, max) {
          var out = [];
          for (var t = st; t < en - 0.001; t += len) {
            if (max && out.length >= max) break;
            var e = Math.min(t + len, en);
            if (e - t >= 10) out.push({ n: out.length + 1, start: t, end: e });
          }
          return out;
        }
        function outSize(format) {
          if (format !== "original" || $("bblur").checked) return { w: 1080, h: 1920 };
          var w = S.vw || 1280, h = S.vh || 720, k = Math.min(1, 1920 / Math.max(w, h));
          return { w: Math.round((w * k) / 2) * 2, h: Math.round((h * k) / 2) * 2 };
        }

        /* ---------- drawing ---------- */
        /* ---------- boost ---------- */
        var HOOKS = ["Wait for it 😳", "Ye dekh ke shock ho jaoge 😱", "Nobody expected this...", "Last tak dekhna 🔥", "This changed everything", "Bhai ye kya tha 😂"];
        function boost() {
          return { hook: $("bhook").value.trim(), pb: $("bpb").checked, pbPos: $("bpbpos").value, pbCol: $("bpbcol").value, blur: $("bblur").checked };
        }
        function drawBoost(ctx, W, H, el, len) {
          var B = boost();
          if (el == null) return;
          if (B.hook && el < 3) {
            var p = Math.min(1, el / 0.25), c1 = 1.70158, q = p - 1;
            var s = 1 + (c1 + 1) * q * q * q + c1 * q * q; // ease-out-back pop
            var fs = Math.round(W * 0.075), maxW = W * 0.84, lh = fs * 1.2;
            ctx.save();
            ctx.font = "900 " + fs + 'px "Arial Black", Impact, Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
            var words = B.hook.split(/\s+/), lines = [], ln = "";
            words.forEach(function (w) { var t = ln ? ln + " " + w : w; if (ln && ctx.measureText(t).width > maxW) { lines.push(ln); ln = w; } else ln = t; });
            lines.push(ln);
            var bw = Math.min(W * 0.94, Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; })) + fs * 0.9);
            var bh = lines.length * lh + fs * 0.6, cy = H / 3;
            ctx.translate(W / 2, cy); ctx.scale(Math.max(0.01, s), Math.max(0.01, s));
            ctx.fillStyle = "#ffd400";
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(-bw / 2, -bh / 2, bw, bh, fs * 0.3); else ctx.rect(-bw / 2, -bh / 2, bw, bh);
            ctx.fill();
            ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
            ctx.lineWidth = Math.max(2, fs * 0.16); ctx.strokeStyle = "#000"; ctx.fillStyle = "#fff";
            lines.forEach(function (l, i) {
              var y = (i - (lines.length - 1) / 2) * lh;
              ctx.strokeText(l, 0, y); ctx.fillText(l, 0, y);
            });
            ctx.restore();
          }
          if (B.pb && len > 0) {
            var h = Math.max(3, Math.round((10 * H) / 1920));
            ctx.fillStyle = B.pbCol;
            ctx.fillRect(0, B.pbPos === "top" ? 0 : H - h, W * Math.max(0, Math.min(1, el / len)), h);
          }
        }
        $("bhookAuto").addEventListener("click", function () {
          var cur = $("bhook").value, pick;
          do { pick = HOOKS[Math.floor(Math.random() * HOOKS.length)]; } while (pick === cur);
          $("bhook").value = pick; boostChanged();
        });
        function boostChanged() {
          if (S.url) { try { $("origdim").textContent = outSize("original").w + "×" + outSize("original").h; } catch (e) {} }
          if (S.step === 3) drawStylePreview();
        }
        ["bhook", "bpb", "bpbpos", "bpbcol", "bblur", "bemoji"].forEach(function (id) { $(id).addEventListener("input", boostChanged); $(id).addEventListener("change", boostChanged); });

        /* ---------- batch 3: face follow, zoom punch-ins, sound effects, emoji ---------- */
        var FF = { st: "off", fd: null, busy: false, cur: null }, MP = "https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4/";
        function ffMsg(t) { $("ffmsg").textContent = t; show($("ffmsg"), !!t); }
        function ffFail() { FF.st = "fail"; FF.fd = null; ffMsg("The face detector couldn't load, so clips use a centre crop."); }
        function ffLoad() {
          if (FF.st !== "off") return;
          FF.st = "loading"; ffMsg("Loading face detector…");
          var s = document.createElement("script");
          s.src = MP + "face_detection.js"; s.crossOrigin = "anonymous";
          s.onerror = ffFail;
          s.onload = function () {
            try {
              var fd = new window.FaceDetection({ locateFile: function (f) { return MP + f; } });
              fd.setOptions({ model: "short", minDetectionConfidence: 0.5 });
              fd.onResults(function (r) {
                var v = FF.cur; if (!v) return;
                var f = v._ff, big = null;
                (r.detections || []).forEach(function (d) { var b = d.boundingBox; if (b && (!big || b.width * b.height > big.width * big.height)) big = b; });
                var nx = big ? big.xCenter : 0.5, ny = big ? big.yCenter : 0.5;
                if (Math.abs(nx - f.tx) >= 0.02) f.tx = nx;
                if (Math.abs(ny - f.ty) >= 0.02) f.ty = ny;
                if (v.paused) { f.x = f.tx; f.y = f.ty; if (v === preview && S.url) drawCropPreview(); }
              });
              FF.fd = fd; FF.st = "ready"; ffMsg("Face detector ready. The frame follows the biggest face.");
              if (S.url) drawCropPreview();
            } catch (e) { ffFail(); }
          };
          document.head.appendChild(s);
        }
        // Returns the smoothed face centre {x, y} (0..1). Detection runs at most every 200 ms and is never awaited.
        function ffCentre(v) {
          var f = v._ff || (v._ff = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, last: 0 }), now = performance.now();
          if (FF.fd && !FF.busy && v.readyState >= 2 && now - f.last >= 200) {
            f.last = now; FF.busy = true; FF.cur = v;
            try { Promise.resolve(FF.fd.send({ image: v })).then(function () { FF.busy = false; }, function () { FF.busy = false; }); }
            catch (e) { FF.busy = false; }
          }
          if (!FF.fd) { f.tx = 0.5; f.ty = 0.5; }
          f.x += (f.tx - f.x) * 0.15; f.y += (f.ty - f.y) * 0.15;
          return f;
        }
        document.querySelectorAll('input[name="fmt"]').forEach(function (r) { r.addEventListener("change", function () { if (r.value === "face" && r.checked) ffLoad(); }); });
        var ZM = { key: null, ev: [] };
        function zoomEvents() {
          var words = (AUTO && AUTO.words) || null, key = AN || words;
          if (ZM.key === key) return ZM.ev;
          var ts = [], last = -9, i;
          if (AN) {
            var r = AN.rms, n = r.length, P = new Float64Array(n + 1);
            for (i = 0; i < n; i++) P[i + 1] = P[i] + r[i];
            for (i = 0; i < n; i++) {
              var a = Math.max(0, i - 25), b = Math.min(n, i + 26);
              if (r[i] > ((P[b] - P[a]) / (b - a)) * 1.8 && r[i] > AN.thr) ts.push(i / 10);
            }
          } else if (words) {
            words.forEach(function (w) { var t = String(w.t).trim(), l = t.replace(/[^\p{L}]/gu, ""); if (/!$/.test(t) || (l.length > 1 && l === l.toUpperCase() && l !== l.toLowerCase())) ts.push(w.s); });
          }
          ZM.ev = ts.filter(function (t) { if (t - last < 3) return false; last = t; return true; });
          ZM.key = key; return ZM.ev;
        }
        function zoomAt(t) {
          if (!$("bzoom").checked) return 1;
          var ev = zoomEvents(), z = +$("bzs").value - 1;
          for (var i = 0; i < ev.length; i++) {
            var d = t - ev[i];
            if (d >= 0 && d < 1.05) { var p = d < 0.15 ? d / 0.15 : d < 0.75 ? 1 : 1 - (d - 0.75) / 0.3; p = p * p * (3 - 2 * p); return 1 + z * p; }
          }
          return 1;
        }
        $("bzs").addEventListener("input", function () { $("bzsv").textContent = (+$("bzs").value).toFixed(2); });
        var SFX = { g: null };
        function sfxBus() {
          var c = AU.ctx;
          if (!c || !AU.dest) return null;
          if (!SFX.g) {
            SFX.g = c.createGain(); SFX.g.connect(AU.dest);
            var spk = c.createGain(); spk.gain.value = 0.3; SFX.g.connect(spk); spk.connect(c.destination);
          }
          SFX.g.gain.value = S.paused ? 0 : +$("bsfxv").value;
          return SFX.g;
        }
        function sfx(kind) {
          if (S.paused || !$("bsfx").checked) return;
          var bus = sfxBus(); if (!bus) return;
          var c = AU.ctx, t = c.currentTime;
          function voice(src, peak, a, d, filt) {
            var g = c.createGain();
            g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
            if (filt) { src.connect(filt); filt.connect(g); } else src.connect(g);
            g.connect(bus); src.start(t); src.stop(t + a + d + 0.05);
          }
          function noise(dur) {
            var b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = b.getChannelData(0);
            for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            var s = c.createBufferSource(); s.buffer = b; return s;
          }
          function osc(type, f0, f1, dur) { var o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur); return o; }
          function filt(type, f0, f1, dur) { var f = c.createBiquadFilter(); f.type = type; f.Q.value = 1.5; f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur); return f; }
          if (kind === "whoosh") voice(noise(0.7), 0.7, 0.3, 0.35, filt("bandpass", 300, 4000, 0.6));
          else if (kind === "boom") { voice(osc("sine", 140, 38, 0.6), 1, 0.01, 0.7); voice(noise(0.3), 0.5, 0.005, 0.25, filt("lowpass", 600, 150, 0.25)); }
          else if (kind === "ding") voice(osc("sine", 1200), 0.5, 0.005, 1.2);
          else voice(osc("square", 500, 900, 0.06), 0.25, 0.003, 0.07);
        }
        function sfxMute(p) { if (SFX.g) SFX.g.gain.value = p ? 0 : +$("bsfxv").value; }
        $("bsfxv").addEventListener("input", function () { sfxMute(S.paused); });
        var SFXT = ["whoosh", "boom", "ding", "pop"], sfxI = 0;
        $("bsfxt").addEventListener("click", function () {
          primeAudio();
          if (!$("bsfx").checked) $("bsfx").checked = true;
          sfx(SFXT[sfxI++ % 4]);
        });
        // Called every recorded frame while not paused: whoosh at the hook, boom/pop at each zoom.
        function sfxTick(fx, t, el) {
          if (S.paused || !$("bsfx").checked) return;
          if (!fx.h && el < 0.5 && boost().hook) { fx.h = true; sfx("whoosh"); }
          fx.h = true;
          if (!$("bzoom").checked) return;
          zoomEvents().forEach(function (e, i) { if (!fx.z[i] && t >= e && t < e + 0.15) { fx.z[i] = 1; sfx("boom"); } });
        }
        var EMO = {}, EMOSRC = { "💰": "money paisa rupee", "❤️": "love pyaar dil", "🔥": "fire aag lit", "😂": "funny hasi lol", "😱": "shock omg kya", "🏆": "win jeet champion", "😢": "sad dukh", "🍔": "food khana", "🎮": "game gaming", "💪": "power strong", "⏰": "time samay", "💡": "idea soch", "🎵": "music gaana", "⚠️": "danger khatra", "🤩": "wow waah" };
        Object.keys(EMOSRC).forEach(function (e) { EMOSRC[e].split(" ").forEach(function (k) { EMO[k] = e; }); });
        function emojiFor(w) { return $("bemoji").checked ? EMO[w.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "")] || "" : ""; }

        /* ---------- analyze audio, best moments, silence cut ---------- */
        var AN = null, MOM = [], MAXB = 400 * 1048576, mv = $("mvid"), mEnd = 0;
        function mProg(t, p) {
          show($("mprog"), true); $("mmsg").textContent = t;
          if (p != null) { $("mbar").firstChild.style.width = p + "%"; $("mbar").setAttribute("aria-valuenow", p); }
        }
        function anReset() {
          AN = null; MOM = []; S.moments = null; mEnd = 0;
          $("mlist").innerHTML = ""; [$("mprog"), $("mmake"), $("mused"), mv].forEach(function (e) { show(e, false); });
          mv.pause(); mv.removeAttribute("src");
        }
        function analyze() {
          if (AN && AN.file === S.file) return Promise.resolve(AN);
          if (!S.file) return Promise.reject(new Error("Upload a video first."));
          if (S.anP) return S.anP;
          var file = S.file, big = file.size > MAXB, Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
          mProg(big ? "File too big for full analysis. Reading the first 400 MB…" : "Reading audio…", 5);
          $("manalyze").disabled = true;
          function end() { S.anP = null; $("manalyze").disabled = false; }
          S.anP = (big ? file.slice(0, MAXB) : file).arrayBuffer().then(function (buf) {
            mProg((big ? "File too big for full analysis. " : "") + "Decoding audio…", 25);
            var ctx = new Ctx(1, 1, 8000);
            return new Promise(function (res, rej) { var p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
          }).then(function (ab) {
            mProg("Measuring loudness…", 60);
            return new Promise(function (r) { setTimeout(r, 30); }).then(function () { return ab; });
          }, function () {
            throw new Error(big ? "File too big for full analysis, and its first 400 MB couldn't be decoded. Try a smaller file, or an MP4 saved for the web." : "This video's audio couldn't be decoded here. Try Chrome, or an MP4 file.");
          }).then(function (ab) {
            if (file !== S.file) throw new Error("A new video was loaded.");
            var sr = ab.sampleRate, ch = ab.numberOfChannels, win = Math.round(sr / 10), n = Math.floor(ab.length / win), rms = new Float32Array(n), D = [], i, j, c;
            for (c = 0; c < ch; c++) D.push(ab.getChannelData(c));
            for (i = 0; i < n; i++) {
              var sum = 0;
              for (j = i * win; j < (i + 1) * win; j++) { var m = 0; for (c = 0; c < ch; c++) m += D[c][j]; m /= ch; sum += m * m; }
              rms[i] = Math.sqrt(sum / win);
            }
            var sorted = Array.prototype.slice.call(rms).sort(function (a, b) { return a - b; });
            var thr = Math.max(0.02, 0.35 * (sorted[n >> 1] || 0)), sil = [], s0 = -1;
            for (i = 0; i <= n; i++) {
              var q = i < n && rms[i] < thr;
              if (q && s0 < 0) s0 = i; else if (!q && s0 >= 0) { sil.push({ s: s0 / 10, e: i / 10 }); s0 = -1; }
            }
            AN = { rms: rms, sil: sil, thr: thr, file: file };
            mProg((big ? "File too big for full analysis: analysed the first " + fmt(n / 10) + ". " : "Analysis done. ") + sil.length + " silent gaps found.", 100);
            end(); return AN;
          }).catch(function (e) { end(); throw e; });
          return S.anP;
        }
        function scoreMoments() {
          var o = settings();
          if (o.error) { mProg(o.error, 0); return; }
          var r = AN.rms, n = r.length, N = Math.max(10, Math.min(30, Math.round(+$("mtop").value) || 15));
          $("mtop").value = N;
          var lo = Math.min(n, Math.round(o.start * 10)), hi = Math.min(n, Math.round(o.end * 10)), W = Math.min(o.len * 10, hi - lo);
          if (W < 100) { mProg("Not enough analysed audio in the chosen range.", 0); return; }
          var P = new Float64Array(n + 1), K = new Float64Array(n + 1), i, k, words = (AUTO && AUTO.words) || [], cands = [];
          for (i = 0; i < n; i++) P[i + 1] = P[i] + r[i];
          for (i = 0; i < n; i++) {
            var a = Math.max(0, i - 25), b = Math.min(n, i + 26), loc = (P[b] - P[a]) / (b - a);
            K[i + 1] = K[i] + (r[i] > loc * 1.8 && r[i] > AN.thr ? 1 : 0);
          }
          for (i = lo; i + W <= hi; i += 10) {
            var e = i + W, sc = (P[e] - P[i]) / W + 2 * (K[e] - K[i]), pk = i;
            for (k = i; k < e; k++) if (r[k] > r[pk]) pk = k;
            if (words.length) sc += words.filter(function (w) { return w.s >= i / 10 && w.s < e / 10; }).length / (W / 10);
            var st = Math.max(lo / 10, Math.min(pk / 10 - 2, hi / 10 - W / 10));
            cands.push({ s: st, e: st + W / 10, sc: sc });
          }
          cands.sort(function (x, y) { return y.sc - x.sc; });
          MOM = [];
          for (i = 0; i < cands.length && MOM.length < N; i++) {
            var cd = cands[i];
            if (!MOM.some(function (m) { return cd.s < m.e && cd.e > m.s; })) MOM.push(cd);
          }
          renderMoments();
        }
        function renderMoments() {
          var L = $("mlist"), top = MOM.length ? MOM[0].sc || 1 : 1, hrs = S.duration >= 3600;
          L.innerHTML = "";
          MOM.forEach(function (m, i) {
            m.on = true;
            var li = document.createElement("li");
            li.innerHTML = "<b>" + (i + 1) + "</b><span>" + fmt(m.s, hrs) + "–" + fmt(m.e, hrs) + "</span>" +
              '<button class="x-btn" type="button" aria-label="Preview moment ' + (i + 1) + '">▶</button>' +
              '<input type="checkbox" checked aria-label="Use moment ' + (i + 1) + '" />' +
              '<div class="x-bar" aria-hidden="true"><span style="width:' + Math.max(4, Math.round((m.sc / top) * 100)) + '%"></span></div>';
            li.querySelector("button").addEventListener("click", function () { playMoment(m); });
            li.querySelector("input").addEventListener("change", function (ev) { m.on = ev.target.checked; });
            L.appendChild(li);
          });
          show($("mmake"), MOM.length > 0);
        }
        function playMoment(m) {
          show(mv, true);
          if (mv.src !== S.url) mv.src = S.url;
          mEnd = m.e;
          ready(mv).then(function () { return seekTo(mv, m.s); }).then(function () { mv.play().catch(function () {}); }, function () {});
        }
        mv.addEventListener("timeupdate", function () { if (mEnd && mv.currentTime >= mEnd) { mv.pause(); mEnd = 0; } });
        $("manalyze").addEventListener("click", function () {
          analyze().then(scoreMoments, function (err) { mProg(err.message, 0); });
        });
        $("mmake").addEventListener("click", function () {
          var last = -1, out = [];
          MOM.filter(function (m) { return m.on; }).sort(function (a, b) { return a.s - b.s; }).forEach(function (m) {
            var s = Math.max(m.s, last);
            if (m.e - s >= 10) { out.push({ s: s, e: m.e }); last = m.e; }
          });
          if (!out.length) { mProg("Tick at least one moment first.", null); return; }
          mv.pause(); S.moments = out; S.sig = ""; show($("mused"), true);
          go(4);
        });
        $("mclear").addEventListener("click", function () { S.moments = null; S.sig = ""; show($("mused"), false); });
        $("bgap").addEventListener("input", function () { $("bgapv").textContent = (+$("bgap").value).toFixed(1); });
        function cutsFor(seg) {
          if (!$("bcut").checked || !AN) return [];
          var g = +$("bgap").value, cuts = AN.sil.map(function (r) { return { s: Math.max(r.s, seg.start), e: Math.min(r.e, seg.end) }; })
            .filter(function (r) { return r.e - r.s > g; });
          return seg.end - seg.start - cutLen(cuts) < 3 ? [] : cuts;
        }
        function cutLen(cuts) { return cuts.reduce(function (a, c) { return a + c.e - c.s; }, 0); }
        function outT(cuts, seg, t) {
          var el = t - seg.start;
          cuts.forEach(function (c) { if (t > c.s) el -= Math.min(t, c.e) - c.s; });
          return Math.max(0, el);
        }

        function drawFrame(ctx, v, W, H, o, n, el, len) {
          var vw = v.videoWidth, vh = v.videoHeight;
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, W, H);
          if (!vw || !vh) return;
          var zf = zoomAt(v.currentTime);
          if (zf > 1) { ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(zf, zf); ctx.translate(-W / 2, -H / 2); }
          if (o.format === "face") {
            if (FF.st === "off") ffLoad();
            var ft = W / H, fsw = vw, fsh = vh, fsx = 0, fsy = 0, fc = ffCentre(v);
            if (vw / vh > ft) { fsw = vh * ft; fsx = Math.max(0, Math.min(vw - fsw, fc.x * vw - fsw / 2)); }
            else { fsh = vw / ft; fsy = Math.max(0, Math.min(vh - fsh, fc.y * vh - fsh / 2)); }
            ctx.drawImage(v, fsx, fsy, fsw, fsh, 0, 0, W, H);
          } else if (o.format === "vertical") {
            var target = W / H, sx = 0, sy = 0, sw = vw, sh = vh;
            if (vw / vh > target) { sw = vh * target; sx = (vw - sw) * (o.crop / 100); }
            else { sh = vw / target; sy = (vh - sh) / 2; }
            ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
          } else if (o.format === "custom" && o.boxC) {
            drawCover(ctx, v, o.boxC, 0, 0, W, H);
          } else if (o.format === "split" && o.boxA && o.boxB) {
            var th = Math.round((H * (o.ratio || 35)) / 100);
            var top = o.swap ? o.boxB : o.boxA, bot = o.swap ? o.boxA : o.boxB;
            drawCover(ctx, v, top, 0, 0, W, th);
            drawCover(ctx, v, bot, 0, th, W, H - th);
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect(0, th - Math.max(1, Math.round(H * 0.002)), W, Math.max(2, Math.round(H * 0.004)));
          } else {
            var k = Math.min(W / vw, H / vh), dw = vw * k, dh = vh * k;
            if (W - dw > 1 || H - dh > 1) {
              if (boost().blur) {
                var kc = Math.max(W / vw, H / vh);
                ctx.save();
                ctx.filter = "blur(" + Math.max(4, Math.round((30 * W) / 1080)) + "px)";
                ctx.drawImage(v, (W - vw * kc) / 2, (H - vh * kc) / 2, vw * kc, vh * kc);
                ctx.filter = "none";
                ctx.fillStyle = "rgba(0,0,0,0.45)";
                ctx.fillRect(0, 0, W, H);
                ctx.restore();
                ctx.filter = "none";
              }
              ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
            } else ctx.drawImage(v, 0, 0, W, H);
          }
          if (zf > 1) ctx.restore();
          drawBoost(ctx, W, H, el, len);
          if (o.label && n) {
            var fs = Math.round(Math.min(W, H) * 0.05);
            var text = "Part " + n;
            ctx.font = "600 " + fs + 'px Geist, -apple-system, "Helvetica Neue", Arial, sans-serif';
            var tw = ctx.measureText(text).width, bw = tw + fs * 1.6, bh = fs * 1.9;
            var x = (W - bw) / 2, y = Math.round(H * 0.06);
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, bh / 2); else ctx.rect(x, y, bw, bh);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(text, W / 2, y + bh / 2 + fs * 0.04);
          }
        }
        /* Cover-crop a box (0..1 of the source) into a destination rect, keeping aspect. */
        function drawCover(ctx, v, b, dx, dy, dw, dh) {
          var vw = v.videoWidth, vh = v.videoHeight;
          var bx = b.x * vw, by = b.y * vh, bw = Math.max(2, b.w * vw), bh = Math.max(2, b.h * vh);
          var t = dw / dh, sx = bx, sy = by, sw = bw, sh = bh;
          if (bw / bh > t) { sw = bh * t; sx = bx + (bw - sw) / 2; }
          else { sh = bw / t; sy = by + (bh - sh) / 2; }
          ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
        }
        function drawCropPreview() {
          var o = settings(), c = $("cropcanvas");
          var picking = o.format === "custom" || o.format === "split";
          if (o.format !== "original") { c.width = 180; c.height = 320; c.classList.remove("is-wide"); }
          else { var sz = outSize("original"); c.width = 320; c.height = Math.round((320 * sz.h) / sz.w); c.classList.add("is-wide"); }
          c.classList.toggle("is-big", picking);
          var wide = S.vw / S.vh > 9 / 16 + 0.01;
          show($("cropfield"), o.format === "vertical" && wide);
          show($("splitfield"), o.format === "split");
          show($("customhint"), o.format === "custom");
          show($("picker"), picking);
          if (picking) layoutPicker(o.format);
          if (preview.readyState >= 2) {
            drawFrame(c.getContext("2d"), preview, c.width, c.height, o, 1);
            drawCaptionText(c.getContext("2d"), c.width, c.height, ST, (validCaps()[0] || {}).text || "", 0.3);
            if (picking) drawSource();
          }
        }

        /* ---------- frame picker (custom frame and split boxes) ---------- */
        function fixC() {
          // Keep box C at exactly 9:16 in source pixels.
          var b = BOX.C, ar = S.vw && S.vh ? S.vh / S.vw : 9 / 16;
          var wFromH = b.h * (9 / 16) * ar;
          if (wFromH > 1) { b.w = 1; b.h = 1 / ((9 / 16) * ar); } else b.w = wFromH;
          b.h = Math.min(1, b.h);
          b.x = Math.max(0, Math.min(1 - b.w, b.x)); b.y = Math.max(0, Math.min(1 - b.h, b.y));
        }
        function resetBoxes() {
          BOX.A = { x: 0.68, y: 0.62, w: 0.3, h: 0.35 };
          BOX.B = { x: 0.02, y: 0.03, w: 0.64, h: 0.94 };
          BOX.C = { x: 0, y: 0, w: 0.3, h: 1 };
          fixC();
          BOX.C.x = (1 - BOX.C.w) / 2; BOX.C.y = (1 - BOX.C.h) / 2;
        }
        function drawSource() {
          var c = $("srccanvas");
          var h = Math.round((640 * (S.vh || 360)) / (S.vw || 640));
          if (c.height !== h) c.height = h;
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, c.width, c.height);
          if (preview.readyState >= 2) ctx.drawImage(preview, 0, 0, c.width, c.height);
        }
        function placeBox(el, b) {
          el.style.left = b.x * 100 + "%"; el.style.top = b.y * 100 + "%";
          el.style.width = b.w * 100 + "%"; el.style.height = b.h * 100 + "%";
        }
        function layoutPicker(format) {
          var split = format === "split";
          show($("boxA"), split); show($("boxB"), split); show($("boxC"), !split); show($("splitlegend"), split);
          $("pickh").textContent = split ? "Drag box A over the webcam and box B over the main screen" : "Drag the box over the part that fills the 9:16 frame";
          placeBox($("boxA"), BOX.A); placeBox($("boxB"), BOX.B); placeBox($("boxC"), BOX.C);
        }
        var drag = null;
        function startDrag(e) {
          var box = e.target.closest(".x-box");
          if (!box || (e.button != null && e.button > 0)) return;
          e.preventDefault();
          var key = box.dataset.box, r = $("stage").getBoundingClientRect();
          document.querySelectorAll(".x-box").forEach(function (b) { b.classList.toggle("is-active", b === box); });
          drag = { key: key, el: box, h: e.target.dataset.h || "", sx: e.clientX, sy: e.clientY, r: r, b0: Object.assign({}, BOX[key]), id: e.pointerId };
          try { box.setPointerCapture(e.pointerId); } catch (err) {}
        }
        function moveDrag(e) {
          if (!drag || e.pointerId !== drag.id) return;
          e.preventDefault();
          var dx = (e.clientX - drag.sx) / drag.r.width, dy = (e.clientY - drag.sy) / drag.r.height;
          var b0 = drag.b0, b = BOX[drag.key], MIN = 0.06;
          if (!drag.h) {
            b.x = Math.max(0, Math.min(1 - b0.w, b0.x + dx));
            b.y = Math.max(0, Math.min(1 - b0.h, b0.y + dy));
          } else {
            var L = b0.x, T = b0.y, R = b0.x + b0.w, B = b0.y + b0.h;
            if (drag.h.indexOf("w") > -1) L = Math.max(0, Math.min(R - MIN, L + dx));
            if (drag.h.indexOf("e") > -1) R = Math.min(1, Math.max(L + MIN, R + dx));
            if (drag.h.indexOf("n") > -1) T = Math.max(0, Math.min(B - MIN, T + dy));
            if (drag.h.indexOf("s") > -1) B = Math.min(1, Math.max(T + MIN, B + dy));
            if (drag.key === "C") {
              // Aspect-locked: height follows the drag, width follows the 9:16 shape, anchored at the opposite corner.
              var ar = S.vh / S.vw, hh = B - T, ww = hh * (9 / 16) * ar;
              if (ww > 1) { ww = 1; hh = 1 / ((9 / 16) * ar); }
              if (drag.h.indexOf("w") > -1) L = R - ww; else R = L + ww;
              if (L < 0) { L = 0; ww = R; hh = ww / ((9 / 16) * ar); }
              if (R > 1) { R = 1; ww = 1 - L; hh = ww / ((9 / 16) * ar); }
              if (drag.h.indexOf("n") > -1) T = B - hh; else B = T + hh;
              if (T < 0 || B > 1) return;
            }
            b.x = L; b.y = T; b.w = R - L; b.h = B - T;
          }
          placeBox(drag.el, b);
          schedulePreview();
        }
        function endDrag(e) {
          if (!drag || (e && e.pointerId !== drag.id)) return;
          drag = null; updateSettings(); drawCropPreview();
        }
        var pvRaf = 0;
        function schedulePreview() {
          if (pvRaf) return;
          pvRaf = requestAnimationFrame(function () {
            pvRaf = 0;
            var o = settings(), c = $("cropcanvas");
            if (preview.readyState >= 2) drawFrame(c.getContext("2d"), preview, c.width, c.height, o, 1);
          });
        }

        /* ---------- captions and style ---------- */
        var stylev = $("stylev");
        S.caps = [];
        var TPLS = [
          { id: "bold", name: "Bold Pop", font: "Arial Black", size: 76, color: "#ffffff", hi: "#ffd400", outline: "#000000", upper: true, pos: 70 },
          { id: "karaoke", name: "Karaoke", font: "Arial Black", size: 68, color: "#ffffff", hi: "#22c55e", outline: "#000000", upper: true, pos: 70 },
          { id: "minimal", name: "Minimal", font: "system-ui", size: 54, color: "#ffffff", hi: "#ffffff", outline: "#000000", upper: false, pos: 80 },
          { id: "neon", name: "Neon", font: "Trebuchet MS", size: 70, color: "#7df9ff", hi: "#ffffff", outline: "#00e5ff", upper: true, pos: 66 },
          { id: "classic", name: "Classic", font: "Verdana", size: 52, color: "#ffffff", hi: "#ffffff", outline: "#000000", upper: false, pos: 88 },
          { id: "comic", name: "Comic", font: "Impact", size: 84, color: "#ffe600", hi: "#ffffff", outline: "#000000", upper: true, pos: 68 }
        ];
        function styleFrom(t) { return { tpl: t.id, font: t.font, size: t.size, color: t.color, hi: t.hi, outline: t.outline, upper: t.upper, pos: t.pos }; }
        var ST = styleFrom(TPLS[0]);

        function fontCss(f, px) {
          var em = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
          var fam = f === "system-ui" ? "system-ui, " + em : '"' + f + '", ' + em;
          return (f === "Arial Black" || f === "Impact" ? "400 " : "700 ") + px + "px " + fam;
        }
        function rrect(ctx, x, y, w, h, r) { if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
        function drawCaptions(ctx, W, H, st, caps, t) {
          if (!st || !caps || !caps.length) return;
          for (var i = 0; i < caps.length; i++) {
            var c = caps[i];
            if (t >= c.s && t < c.e) {
              var p = (t - c.s) / Math.max(0.01, c.e - c.s);
              if (c.w && c.w.length) {
                var n = c.text.split(/\s+/).filter(Boolean).length;
                if (n === c.w.length) { var k = 0; for (var j = 0; j < n; j++) if (t >= c.w[j].s) k = j; p = (k + 0.5) / n; }
              }
              drawCaptionText(ctx, W, H, st, c.text, p); return;
            }
          }
        }
        function drawCaptionText(ctx, W, H, st, text, p) {
          var tpl = st.tpl, fs = Math.max(6, Math.round(st.size * (Math.min(W, H) / 1080)));
          if (st.upper) text = text.toUpperCase();
          var words = text.split(/\s+/).filter(Boolean), kw = {};
          if (!words.length) return;
          words = words.map(function (w, i) { var e = emojiFor(w); if (e) { kw[i] = 1; return w + e; } return w; });
          var active = Math.min(words.length - 1, Math.floor(Math.max(0, p) * words.length));
          ctx.save();
          ctx.font = fontCss(st.font, fs);
          ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
          var space = ctx.measureText(" ").width, maxW = W * 0.86, lines = [], cur = [], curW = 0;
          words.forEach(function (w, i) {
            var ww = ctx.measureText(w).width;
            if (cur.length && curW + space + ww > maxW) { lines.push({ items: cur, w: curW }); cur = []; curW = 0; }
            curW += (cur.length ? space : 0) + ww;
            cur.push({ t: w, w: ww, i: i });
          });
          lines.push({ items: cur, w: curW });
          var lh = fs * 1.25, blockH = lh * lines.length, pad3 = H * 0.03;
          var cy = Math.max(blockH / 2 + pad3, Math.min(H - blockH / 2 - pad3, (H * st.pos) / 100));
          if (tpl === "comic") { ctx.translate(W / 2, cy); ctx.rotate(-0.06); ctx.translate(-W / 2, -cy); }
          var outlineW = { bold: 0.2, karaoke: 0.12, comic: 0.18 }[tpl] || 0;
          lines.forEach(function (L, li) {
            var y = cy - blockH / 2 + lh * (li + 0.5), x = (W - L.w) / 2;
            if (tpl === "minimal") {
              var px = fs * 0.5, ph = lh * 0.95;
              ctx.fillStyle = "rgba(0,0,0,0.6)";
              ctx.beginPath(); rrect(ctx, x - px, y - ph / 2, L.w + px * 2, ph, ph / 2); ctx.fill();
            }
            L.items.forEach(function (it) {
              var on = it.i === active, fill = tpl === "karaoke" ? (kw[it.i] && !on ? st.hi : st.color) : on || kw[it.i] ? st.hi : st.color;
              ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
              if (tpl === "karaoke" && on) {
                var bx = fs * 0.16;
                ctx.fillStyle = st.hi;
                ctx.beginPath(); rrect(ctx, x - bx, y - fs * 0.62, it.w + bx * 2, fs * 1.24, fs * 0.2); ctx.fill();
              }
              if (outlineW) { ctx.lineWidth = fs * outlineW; ctx.strokeStyle = st.outline; ctx.strokeText(it.t, x, y); }
              if (tpl === "neon") {
                ctx.shadowColor = st.outline; ctx.shadowBlur = fs * 0.6;
                ctx.fillStyle = fill; ctx.fillText(it.t, x, y);
                ctx.shadowBlur = fs * 0.25;
              }
              if (tpl === "classic") { ctx.shadowColor = st.outline; ctx.shadowBlur = fs * 0.18; ctx.shadowOffsetX = fs * 0.04; ctx.shadowOffsetY = fs * 0.07; }
              ctx.fillStyle = fill; ctx.fillText(it.t, x, y);
              x += it.w + space;
            });
          });
          ctx.restore();
        }
        function validCaps() {
          return S.caps
            .filter(function (c) { return isFinite(c.s) && isFinite(c.e) && c.e > c.s && c.text.trim(); })
            .map(function (c) { var o = { s: c.s, e: c.e, text: c.text.trim() }; if (c.w) o.w = c.w; return o; })
            .sort(function (a, b) { return a.s - b.s; });
        }
        function drawStylePreview() {
          var c = $("stylecanvas"), ctx = c.getContext("2d"), o = S.url ? settings() : { crop: 50, format: "vertical" };
          var so = Object.assign({}, o, { label: false });
          if (so.format === "original" && !boost().blur) so.format = "vertical";
          drawFrame(ctx, stylev, c.width, c.height, so, 0, 1, 3);
          var first = validCaps()[0];
          drawCaptionText(ctx, c.width, c.height, ST, first ? first.text : "Your captions look like this", 0.3);
        }
        stylev.addEventListener("loadeddata", function () { try { stylev.currentTime = 0.01; } catch (e) {} });
        stylev.addEventListener("seeked", function () { if (S.step === 3) drawStylePreview(); });

        /* template cards */
        function renderTpls() {
          var box = $("tpls");
          if (!box.children.length) {
            TPLS.forEach(function (t) {
              var b = document.createElement("button");
              b.type = "button"; b.className = "x-tpl"; b.dataset.tpl = t.id;
              var cv = document.createElement("canvas");
              cv.width = 240; cv.height = 150; cv.setAttribute("aria-hidden", "true");
              var cx = cv.getContext("2d");
              cx.fillStyle = "#2b2f36"; cx.fillRect(0, 0, 240, 150);
              var st = styleFrom(t); st.size = t.size * 3.4; st.pos = 50;
              drawCaptionText(cx, 240, 150, st, "Aa pop", 0.6);
              b.appendChild(cv);
              b.appendChild(document.createTextNode(t.name));
              b.addEventListener("click", function () { ST = styleFrom(t); syncControls(); renderTpls(); drawStylePreview(); });
              box.appendChild(b);
            });
          }
          Array.prototype.forEach.call(box.children, function (b) { b.setAttribute("aria-pressed", b.dataset.tpl === ST.tpl ? "true" : "false"); });
        }
        function syncControls() {
          $("cfont").value = ST.font; $("csize").value = ST.size; $("ccolor").value = ST.color;
          $("chi").value = ST.hi; $("cout").value = ST.outline; $("cupper").checked = ST.upper; $("cpos").value = ST.pos;
        }
        function readControls() {
          ST.font = $("cfont").value; ST.size = +$("csize").value; ST.color = $("ccolor").value;
          ST.hi = $("chi").value; ST.outline = $("cout").value; ST.upper = $("cupper").checked; ST.pos = +$("cpos").value;
          drawStylePreview();
        }
        ["cfont", "csize", "ccolor", "chi", "cout", "cupper", "cpos"].forEach(function (id) {
          $(id).addEventListener("input", readControls);
          $(id).addEventListener("change", readControls);
        });
        syncControls();

        /* caption rows */
        function fmtc(t) {
          var d = Math.round(Math.max(0, t) * 10), s10 = d % 600, m = Math.floor(d / 600) % 60, h = Math.floor(d / 36000);
          return (h ? h + ":" + pad(m) : pad(m)) + ":" + pad(Math.floor(s10 / 10)) + "." + (s10 % 10);
        }
        function capInput(cls, val, label, ph) {
          var inp = document.createElement("input");
          inp.className = "x-input " + cls; inp.type = "text"; inp.value = val; inp.placeholder = ph;
          inp.setAttribute("aria-label", label); inp.autocomplete = "off";
          return inp;
        }
        function renderCaps() {
          var ul = $("caps");
          ul.innerHTML = "";
          S.caps.forEach(function (c, i) {
            var li = document.createElement("li");
            li.className = "x-cap";
            var s = capInput("", isFinite(c.s) ? fmtc(c.s) : "", "Caption " + (i + 1) + " start", "Start");
            var e = capInput("", isFinite(c.e) ? fmtc(c.e) : "", "Caption " + (i + 1) + " end", "End");
            var tx = capInput("x-cap__text", c.text, "Caption " + (i + 1) + " text", "Caption text");
            s.inputMode = e.inputMode = "decimal";
            var del = document.createElement("button");
            del.type = "button"; del.className = "x-btn"; del.textContent = "Delete";
            del.setAttribute("aria-label", "Delete caption " + (i + 1));
            function time(inp, key) {
              inp.addEventListener("input", function () {
                var v = parseTime(inp.value);
                c[key] = v == null || Number.isNaN(v) ? NaN : v;
                inp.setAttribute("aria-invalid", isFinite(c[key]) ? "false" : "true");
                drawStylePreview();
              });
            }
            time(s, "s"); time(e, "e");
            tx.addEventListener("input", function () { c.text = tx.value; drawStylePreview(); });
            del.addEventListener("click", function () { S.caps.splice(i, 1); renderCaps(); drawStylePreview(); });
            li.appendChild(s); li.appendChild(e); li.appendChild(del); li.appendChild(tx);
            ul.appendChild(li);
          });
        }
        $("addCap").addEventListener("click", function () {
          var last = S.caps[S.caps.length - 1];
          var st = last && isFinite(last.e) ? last.e : S.url ? settings().start : 0;
          S.caps.push({ s: st, e: st + 2, text: "" });
          renderCaps();
          var rows = $("caps").querySelectorAll(".x-cap__text");
          rows[rows.length - 1].focus();
        });

        /* source tabs and SRT/VTT loading */
        document.querySelectorAll('input[name="capsrc"]').forEach(function (r) {
          r.addEventListener("change", function () {
            show($("filePane"), $("srcFile").checked);
            show($("autoPane"), $("srcAuto").checked);
            if ($("srcAuto").checked && S.url) {
              var o = settings();
              $("afrom").placeholder = fmt(o.start); $("ato").placeholder = fmt(o.end);
            }
          });
        });
        function subTime(str) {
          var v = parseTime((str || "").trim().split(/\s+/)[0].replace(",", "."));
          return v == null ? NaN : v;
        }
        function parseSubs(txt) {
          var out = [];
          txt.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/).forEach(function (b) {
            var lines = b.split("\n"), idx = -1;
            for (var i = 0; i < lines.length; i++) if (lines[i].indexOf("-->") > -1) { idx = i; break; }
            if (idx < 0) return;
            var m = lines[idx].split("-->"), s = subTime(m[0]), e = subTime(m[1]);
            var text = lines.slice(idx + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/\s+/g, " ").trim();
            if (isFinite(s) && isFinite(e) && e > s && text) out.push({ s: s, e: e, text: text });
          });
          return out;
        }
        $("subfile").addEventListener("change", function () {
          var f = $("subfile").files[0];
          if (!f) return;
          var r = new FileReader();
          r.onload = function () {
            var caps = parseSubs(String(r.result || ""));
            if (!caps.length) { $("capmsg").textContent = "No captions found in that file. Check it is an .srt or .vtt file."; return; }
            S.caps = caps;
            renderCaps(); drawStylePreview();
            $("capmsg").textContent = "Loaded " + caps.length + " caption" + (caps.length === 1 ? "" : "s") + ". Edit them below.";
          };
          r.onerror = function () { $("capmsg").textContent = "That file couldn't be read."; };
          r.readAsText(f);
          $("subfile").value = "";
        });

        /* ---------- auto captions (speech-to-text in a worker) ---------- */
        var WORKER_SRC = [
          "imp" + "ort { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';",
          "env.allowLocalModels = false;",
          "env.useBrowserCache = false;",
          "try { env.useFSCache = false; } catch (e) {}",
          "const SR = 16000, PIECE = 60 * SR;",
          "const files = {};",
          "function prog(p) {",
          "  if (!p || p.status !== 'progress' || !p.file) return;",
          "  files[p.file] = [p.loaded || 0, p.total || 0];",
          "  let l = 0, t = 0;",
          "  for (const k in files) { l += files[k][0]; t += files[k][1]; }",
          "  if (t) postMessage({ type: 'load', pct: Math.min(100, Math.round((l / t) * 100)) });",
          "}",
          "function quietCut(a, from, to) {",
          "  const F = 320; let best = to, bestE = Infinity;",
          "  for (let i = Math.max(0, from); i + F <= to; i += F) {",
          "    let e = 0; for (let j = i; j < i + F; j++) e += a[j] * a[j];",
          "    if (e < bestE) { bestE = e; best = i + (F >> 1); }",
          "  }",
          "  return best;",
          "}",
          "function evenWords(text, s, e, out) {",
          "  const ws = String(text || '').trim().split(/\\s+/).filter(Boolean);",
          "  if (!ws.length) return;",
          "  if (!(e > s)) e = s + 0.4 * ws.length;",
          "  const d = (e - s) / ws.length;",
          "  ws.forEach((w, i) => out.push({ t: w, s: s + i * d, e: s + (i + 1) * d }));",
          "}",
          "self.onmessage = async (ev) => {",
          "  const d = ev.data || {};",
          "  try {",
          "    postMessage({ type: 'status', text: 'Loading model…' });",
          "    const dtype = d.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';",
          "    const asr = await pipeline('automatic-speech-recognition', d.model, { device: d.device, dtype: dtype, progress_callback: prog });",
          "    const audio = d.audio, words = [];",
          "    let pos = 0, wordLevel = true;",
          "    postMessage({ type: 'progress', pct: 0 });",
          "    while (pos < audio.length) {",
          "      let end = Math.min(audio.length, pos + PIECE);",
          "      if (end < audio.length) end = quietCut(audio, end - 3 * SR, end);",
          "      const piece = audio.subarray(pos, end), off = pos / SR;",
          "      if (piece.length > SR * 0.3) {",
          "        const opts = { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe' };",
          "        if (d.language) opts.language = d.language;",
          "        let out = null;",
          "        if (wordLevel) {",
          "          try { out = await asr(piece, Object.assign({ return_timestamps: 'word' }, opts)); }",
          "          catch (err) { if (!/attention|alignment|timestamp/i.test(String(err && err.message))) throw err; wordLevel = false; }",
          "        }",
          "        if (!wordLevel) out = await asr(piece, Object.assign({ return_timestamps: true }, opts));",
          "        const chunks = (out && out.chunks) || [];",
          "        if (!chunks.length && out && out.text) evenWords(out.text, off, end / SR, words);",
          "        for (const c of chunks) {",
          "          const ts = c.timestamp || [];",
          "          const s = ts[0]; let e = ts[1];",
          "          if (typeof s !== 'number' || !Number.isFinite(s)) continue;",
          "          if (typeof e !== 'number' || !Number.isFinite(e) || e <= s) e = s + 0.4;",
          "          if (wordLevel) { const t = String(c.text || '').trim(); if (t) words.push({ t: t, s: s + off, e: e + off }); }",
          "          else evenWords(c.text, s + off, e + off, words);",
          "        }",
          "      }",
          "      pos = end;",
          "      postMessage({ type: 'progress', pct: Math.round((pos / audio.length) * 100) });",
          "    }",
          "    postMessage({ type: 'done', words: words, wordLevel: wordLevel });",
          "  } catch (err) {",
          "    postMessage({ type: 'error', msg: String((err && err.message) || err) });",
          "  }",
          "};"
        ].join("\n");

        var AUTO = { worker: null, wurl: null, run: 0, dog: null, words: null, wordLevel: true, busy: false };
        var AUTO_FAIL = "Auto captions couldn't start in this browser. Try Chrome, or load an SRT.";
        function autoUI(busy) {
          AUTO.busy = busy;
          show($("aprog"), busy);
          $("agen").disabled = $("amodel").disabled = $("alang").disabled = busy;
        }
        function autoProg(text, pct) {
          $("aptext").textContent = text;
          $("apct").textContent = pct == null ? "" : pct + "%";
          var v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
          $("abar").firstElementChild.style.width = v + "%";
          $("abar").setAttribute("aria-valuenow", String(v));
        }
        function killWorker() {
          clearTimeout(AUTO.dog);
          if (AUTO.worker) { try { AUTO.worker.terminate(); } catch (e) {} AUTO.worker = null; }
          if (AUTO.wurl) { try { URL.revokeObjectURL(AUTO.wurl); } catch (e) {} AUTO.wurl = null; }
        }
        function autoReset() {
          AUTO.run++; killWorker(); AUTO.words = null; autoUI(false);
          $("agen").textContent = "Generate captions";
        }

        function decodeAudio(file, from, to) {
          return file.arrayBuffer().then(function (buf) {
            var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            var ctx = new Ctx(1, 16000, 16000);
            return new Promise(function (res, rej) {
              var p = ctx.decodeAudioData(buf, res, rej);
              if (p && p.then) p.then(res, rej);
            });
          }).then(function (ab) {
            var sr = ab.sampleRate, ch = ab.numberOfChannels;
            var a = Math.max(0, Math.floor(from * sr)), b = Math.min(ab.length, Math.ceil(to * sr));
            if (b - a < sr * 0.5) throw new Error("empty");
            var mono = new Float32Array(b - a);
            for (var c = 0; c < ch; c++) {
              var d = ab.getChannelData(c);
              for (var i = 0; i < mono.length; i++) mono[i] += d[a + i] / ch;
            }
            if (sr === 16000) return mono;
            var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            var off = new Ctx(1, Math.ceil((mono.length * 16000) / sr), 16000);
            var src = off.createBufferSource(), mb = off.createBuffer(1, mono.length, sr);
            mb.getChannelData(0).set(mono);
            src.buffer = mb; src.connect(off.destination); src.start();
            return off.startRendering().then(function (r) { return r.getChannelData(0).slice(); });
          });
        }

        function runWorker(device, audio, cfg, run) {
          return new Promise(function (res, rej) {
            var w;
            try {
              AUTO.wurl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
              w = new Worker(AUTO.wurl, { type: "mod" + "ule" });
            } catch (e) { rej(e); return; }
            AUTO.worker = w;
            function pet() { clearTimeout(AUTO.dog); AUTO.dog = setTimeout(function () { rej(new Error("timeout")); }, 240000); }
            pet();
            w.onmessage = function (ev) {
              if (run !== AUTO.run) return;
              pet();
              var d = ev.data || {};
              if (d.type === "load") autoProg("Downloading model… " + d.pct + "%", d.pct);
              else if (d.type === "status") autoProg(d.text, null);
              else if (d.type === "progress") autoProg("Transcribing… " + d.pct + "%", d.pct);
              else if (d.type === "done") { clearTimeout(AUTO.dog); res(d); }
              else if (d.type === "error") { clearTimeout(AUTO.dog); rej(new Error(d.msg)); }
            };
            w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); clearTimeout(AUTO.dog); rej(new Error((e && e.message) || "worker")); };
            w.onmessageerror = function () { clearTimeout(AUTO.dog); rej(new Error("message")); };
            try { w.postMessage({ audio: audio, model: cfg.model, language: cfg.language, device: device }, [audio.buffer]); }
            catch (e) { clearTimeout(AUTO.dog); rej(e); }
          });
        }

        function groupWords(words, mode) {
          var max = mode === "1" ? 1 : mode === "3" ? 3 : 7, rows = [], cur = [];
          function flush() {
            if (!cur.length) return;
            var s = cur[0].s, e = Math.max(cur[cur.length - 1].e, s + 0.2);
            rows.push({ s: s, e: e, text: cur.map(function (w) { return w.t; }).join(" "), w: cur.map(function (w) { return { s: w.s, e: w.e }; }) });
            cur = [];
          }
          words.forEach(function (w) {
            var prev = cur[cur.length - 1];
            if (prev && (cur.length >= max || w.s - prev.e >= 0.6 || /[.!?।]$/.test(prev.t))) flush();
            cur.push(w);
          });
          flush();
          for (var i = 0; i < rows.length - 1; i++) {
            var nx = rows[i + 1].s;
            if (rows[i].e > nx || nx - rows[i].e < 0.25) rows[i].e = Math.max(rows[i].s + 0.05, nx);
          }
          return rows;
        }
        function applyAuto() {
          if (!AUTO.words) return;
          var mode = document.querySelector('input[name="wpc"]:checked').value;
          S.caps = groupWords(AUTO.words, mode);
          renderCaps(); drawStylePreview();
          $("capmsg").textContent = "Made " + S.caps.length + " caption" + (S.caps.length === 1 ? "" : "s") + " from " + AUTO.words.length + " words. Edit them below." +
            (AUTO.wordLevel ? "" : " Word timings weren't available, so highlights move at an even pace.");
        }
        document.querySelectorAll('input[name="wpc"]').forEach(function (r) { r.addEventListener("change", applyAuto); });

        function autoGenerate() {
          if (AUTO.busy) return;
          var msg = $("capmsg");
          if (!S.file) { msg.textContent = "Upload a video first."; return; }
          var from = parseTime($("afrom").value), to = parseTime($("ato").value);
          if (Number.isNaN(from) || Number.isNaN(to)) { msg.textContent = "Write the range like 01:30 or 00:01:30."; return; }
          if (from == null || to == null) { var o = settings(); if (from == null) from = o.start; if (to == null) to = o.end; }
          from = Math.max(0, Math.min(from, S.duration)); to = Math.min(to, S.duration);
          if (!(to - from >= 1)) { msg.textContent = "The range must be at least 1 second long."; return; }
          var run = ++AUTO.run, cfg = { model: $("amodel").value, language: $("alang").value };
          killWorker(); autoUI(true); msg.textContent = ""; autoProg("Reading audio…", null);
          var decoded;
          try { decoded = decodeAudio(S.file, from, to); } catch (e) { decoded = Promise.reject(e); }
          decoded.then(function (audio) {
            if (run !== AUTO.run) return;
            var gpu = !!navigator.gpu;
            var first;
            try { first = runWorker(gpu ? "webgpu" : "wasm", gpu ? audio.slice() : audio, cfg, run); } catch (e) { first = Promise.reject(e); }
            first.catch(function (err) {
              if (run !== AUTO.run || !gpu) throw err;
              killWorker();
              autoProg("Retrying without the GPU…", null);
              return runWorker("wasm", audio, cfg, run);
            }).then(function (d) {
              if (run !== AUTO.run) return;
              killWorker(); autoUI(false);
              AUTO.words = (d.words || []).map(function (w) { return { t: w.t, s: w.s + from, e: w.e + from }; });
              AUTO.wordLevel = d.wordLevel !== false;
              if (!AUTO.words.length) { AUTO.words = null; msg.textContent = "No speech found in that range."; return; }
              $("agen").textContent = "Regenerate";
              applyAuto();
            }).catch(function (err) {
              if (run !== AUTO.run) return;
              killWorker(); autoUI(false);
              msg.textContent = AUTO_FAIL;
              try { console.warn("Auto captions:", err); } catch (e) {}
            });
          }, function (err) {
            if (run !== AUTO.run) return;
            autoUI(false);
            msg.textContent = err && err.message === "empty"
              ? "That range has no audio to transcribe."
              : "The audio in this video couldn't be decoded here. The file may be too large or use an unsupported codec. Try Chrome, or load an SRT.";
          });
        }
        $("agen").addEventListener("click", autoGenerate);
        $("acancel").addEventListener("click", function () {
          AUTO.run++; killWorker(); autoUI(false);
          $("capmsg").textContent = "Cancelled.";
        });

        /* ---------- steps ---------- */
        function go(n) {
          if (S.busy && n !== 4) return;
          if (n >= 2 && !S.url) return;
          if (n >= 3) {
            var o = settings();
            if (o.error) { updateSettings(); return; }
            if (n === 4) {
              o.caps = validCaps();
              o.style = Object.assign({}, ST);
              buildIfChanged(o);
            }
          }
          S.step = n;
          [1, 2, 3, 4].forEach(function (i) { show($("step" + i), i === n); });
          if (n === 2) drawCropPreview();
          if (n === 3) { renderTpls(); drawStylePreview(); }
          updateStepper();
          window.scrollTo({ top: 0 });
          var h = $("step" + n).querySelector("h2");
          if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
        }
        function updateStepper() {
          var o = S.url ? settings() : null;
          document.querySelectorAll(".x-stepper button").forEach(function (b) {
            var n = +b.dataset.go;
            if (n === S.step) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
            var ok = n === 1 || (S.url && (n === 2 || !o.error));
            if (S.busy && n !== 4) ok = false;
            b.disabled = !ok;
          });
          $("backSettings").disabled = S.busy;
        }
        document.addEventListener("click", function (e) {
          var b = e.target.closest("[data-go]");
          if (b && !b.disabled) go(+b.dataset.go);
        });

        /* ---------- upload ---------- */
        var drop = $("drop"), fileInput = $("file");
        fileInput.addEventListener("change", function () { loadFile(fileInput.files[0]); fileInput.value = ""; });
        ["dragenter", "dragover"].forEach(function (ev) {
          drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("is-over"); });
        });
        ["dragleave", "drop"].forEach(function (ev) {
          drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("is-over"); });
        });
        drop.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
        $("another").addEventListener("click", function () { if (!S.busy) fileInput.click(); });

        function resetAll() {
          S.thumbToken++;
          S.segs.forEach(function (s) { if (s.url) URL.revokeObjectURL(s.url); });
          S.segs = []; S.sig = ""; $("clips").innerHTML = ""; $("cstatus").textContent = "";
          anReset();
          refreshDone();
          if (S.url) URL.revokeObjectURL(S.url);
          S.url = null; S.duration = 0;
          $("tstart").value = ""; $("tend").value = "";
          alertMsg($("err1")); alertMsg($("err3"));
        }

        function loadFile(file) {
          if (!file || S.busy) return;
          if (file.type && file.type.indexOf("video/") !== 0) {
            alertMsg($("err1"), "That file isn't a video", "Choose an MP4, MOV or WebM file from your device.");
            return;
          }
          resetAll();
          show($("loaded"), false); show(drop, true);
          var url = URL.createObjectURL(file);
          S.url = url; S.name = file.name; S.file = file;
          autoReset();
          preview.src = url; rec.src = url; thumbv.src = url; stylev.src = url;
          S.caps = []; renderCaps(); $("capmsg").textContent = "";
          once(preview, "loadedmetadata", 0)
            .then(function () {
              if (isFinite(preview.duration) && preview.duration > 0) return;
              // Some WebM files report no duration until the end is read.
              return new Promise(function (res) {
                var h = function () { if (isFinite(preview.duration)) { preview.removeEventListener("durationchange", h); preview.currentTime = 0; res(); } };
                preview.addEventListener("durationchange", h);
                preview.currentTime = 1e101;
                setTimeout(res, 6000);
              });
            })
            .then(function () {
              if (S.url !== url) return;
              S.duration = isFinite(preview.duration) ? preview.duration : 0;
              S.vw = preview.videoWidth; S.vh = preview.videoHeight;
              if (!S.duration || !S.vw) throw new Error("meta");
              resetBoxes();
              $("fname").textContent = S.name;
              $("fdur").textContent = fmt(S.duration, true);
              $("tend").placeholder = fmt(S.duration, true);
              $("origdim").textContent = outSize("original").w + "×" + outSize("original").h;
              if (S.duration > 2) preview.currentTime = Math.min(1, S.duration / 4);
              show(drop, false); show($("loaded"), true);
              updateSettings();
            })
            .catch(function () {
              if (S.url !== url) return;
              resetAll();
              alertMsg($("err1"), "This video won't open here", "Your browser can't read this file. Try an MP4 (H.264) file, or open this page in Chrome or Edge.");
            });
        }

        /* ---------- settings UI ---------- */
        function updateSettings() {
          if (!S.url) return;
          var o = settings();
          var full = segments(0, S.duration, o.len).length;
          var segs = o.error ? [] : segments(o.start, o.end, o.len, o.max);
          var possible = o.error ? 0 : segments(o.start, o.end, o.len).length;
          $("fclips").textContent = full;
          $("fsum").textContent = "This video makes about " + full + " clip" + (full === 1 ? "" : "s") + " of " + o.len + "s. Change the length in settings.";
          var invalid = !!o.error;
          $("tstart").setAttribute("aria-invalid", invalid && $("tstart").value ? "true" : "false");
          $("tend").setAttribute("aria-invalid", invalid && $("tend").value ? "true" : "false");
          if (invalid) {
            $("ssum").textContent = "Check the times";
            $("stime").textContent = o.error;
          } else {
            var total = segs.reduce(function (a, s) { return a + s.end - s.start; }, 0);
            var sz = outSize(o.format);
            $("ssum").textContent = segs.length + " clip" + (segs.length === 1 ? "" : "s") + " · " + sz.w + "×" + sz.h + " · ." + EXT;
            $("stime").textContent = (possible > segs.length ? "Limited to " + segs.length + " of " + possible + " possible clips by Max clips. " : "") +
              "Making all of them takes about " + dur(total) + ", since clips record in real time.";
          }
          $("toClips").disabled = invalid;
          updateStepper();
        }
        document.querySelectorAll('input[name="len"], input[name="fmt"], #label').forEach(function (el) {
          el.addEventListener("change", function () { updateSettings(); drawCropPreview(); });
        });
        $("crop").addEventListener("input", drawCropPreview);
        $("ratio").addEventListener("input", function () {
          var r = +$("ratio").value;
          $("ratiot").textContent = r + "% top / " + (100 - r) + "% bottom";
          drawCropPreview();
        });
        $("ratio").addEventListener("change", updateSettings);
        $("swap").addEventListener("change", function () { updateSettings(); drawCropPreview(); });
        $("maxclips").addEventListener("input", updateSettings);
        $("maxclips").addEventListener("change", function () {
          var v = Math.round(+$("maxclips").value);
          $("maxclips").value = String(Math.max(1, Math.min(200, isFinite(v) ? v : 200)));
          updateSettings();
        });
        $("scrub").addEventListener("input", function () {
          if (!S.duration) return;
          var t = (+$("scrub").value / 1000) * S.duration;
          $("scrubt").textContent = fmt(t);
          try { preview.currentTime = t; } catch (e) {}
        });
        var stage = $("stage");
        stage.addEventListener("pointerdown", startDrag);
        stage.addEventListener("pointermove", moveDrag);
        stage.addEventListener("pointerup", endDrag);
        stage.addEventListener("pointercancel", endDrag);
        stage.addEventListener("lostpointercapture", endDrag);
        // Live preview while the source plays.
        (function livePreview() {
          var on = false;
          function tick() {
            if (!on) return;
            if (S.step === 2) { drawSource(); schedulePreview(); }
            requestAnimationFrame(tick);
          }
          preview.addEventListener("play", function () { if (!on) { on = true; tick(); } });
          preview.addEventListener("pause", function () { on = false; if (S.step === 2) drawCropPreview(); });
        })();
        ["tstart", "tend"].forEach(function (id) { $(id).addEventListener("input", updateSettings); });
        preview.addEventListener("seeked", function () { if (S.step === 2) drawCropPreview(); });
        preview.addEventListener("loadeddata", function () { if (S.step === 2) drawCropPreview(); });

        /* ---------- clip list ---------- */
        function buildIfChanged(o) {
          var sig = [S.url, o.len, o.format, o.crop, o.label, o.start, o.end, o.max, o.ratio, o.swap, JSON.stringify([o.boxA, o.boxB, o.boxC]), JSON.stringify(o.caps || []), JSON.stringify(o.style || {}), JSON.stringify(S.moments || 0)].join("|");
          if (sig === S.sig) return;
          S.sig = sig;
          S.built = o;
          S.thumbToken++;
          S.segs.forEach(function (s) { if (s.url) URL.revokeObjectURL(s.url); });
          var hours = S.duration >= 3600;
          var list = $("clips");
          list.innerHTML = "";
          alertMsg($("err3"));
          $("cstatus").textContent = "";
          S.segs = S.moments ? S.moments.map(function (m, i) { return { n: i + 1, start: m.s, end: m.e }; }) : segments(o.start, o.end, o.len, o.max);
          var thumbW, thumbH, vert = o.format !== "original";
          if (vert) { thumbW = 72; thumbH = 128; }
          else { var sz = outSize("original"); thumbW = 128; thumbH = Math.round((128 * sz.h) / sz.w); }
          var frag = document.createDocumentFragment();
          S.segs.forEach(function (seg, i) {
            var li = document.createElement("li");
            li.className = "x-clip";
            var c = document.createElement("canvas");
            c.className = "x-thumb" + (vert ? "" : " is-wide");
            c.width = thumbW; c.height = thumbH;
            c.setAttribute("aria-hidden", "true");
            var info = document.createElement("div");
            info.className = "x-clip__info";
            var title = document.createElement("p");
            title.className = "x-clip__title";
            title.innerHTML = "Part " + seg.n + ' <span class="pill">' + Math.round(seg.end - seg.start) + "s</span>";
            var time = document.createElement("p");
            time.className = "x-clip__time";
            time.textContent = fmt(seg.start, hours) + "–" + fmt(seg.end, hours);
            var status = document.createElement("div");
            status.className = "x-clip__status";
            info.appendChild(title); info.appendChild(time); info.appendChild(status);
            var acts = document.createElement("div");
            acts.className = "x-clip__acts";
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "x-btn";
            btn.textContent = "Make clip";
            btn.setAttribute("aria-label", "Make Part " + seg.n);
            btn.addEventListener("click", function (e) { e.stopPropagation(); makeQueue([i]); });
            var out = document.createElement("div");
            out.className = "x-clip__out x-hidden";
            acts.appendChild(btn);
            li.appendChild(c); li.appendChild(info); li.appendChild(acts); li.appendChild(out);
            li.addEventListener("click", function (e) {
              if (e.target.closest("a, button, video")) return;
              if (!seg.blob && !S.busy) makeQueue([i]);
            });
            frag.appendChild(li);
            seg.el = { li: li, thumb: c, status: status, btn: btn, acts: acts, out: out };
          });
          list.appendChild(frag);
          var total = S.segs.reduce(function (a, s) { return a + s.end - s.start; }, 0);
          var fmtName = { vertical: "Vertical 1080×1920", custom: "Custom frame 1080×1920", split: "Split webcam + screen 1080×1920", original: "Original shape" }[o.format];
          $("csum").textContent = S.segs.length + " clip" + (S.segs.length === 1 ? "" : "s") + " · up to " + o.len + "s each · " + fmtName + " · saved as ." + EXT + " · about " + dur(total) + " to make them all.";
          refreshButtons();
          makeThumbs(S.thumbToken, o);
        }
        function makeThumbs(token, o) {
          var i = 0;
          ready(thumbv).then(function next() {
            if (token !== S.thumbToken || i >= S.segs.length) return;
            var seg = S.segs[i++];
            return seekTo(thumbv, Math.min(seg.start + 1, seg.end - 0.5)).then(function () {
              if (token !== S.thumbToken) return;
              var c = seg.el.thumb;
              drawFrame(c.getContext("2d"), thumbv, c.width, c.height, o, 0);
              return next();
            });
          }).catch(function () {});
        }
        function setStatus(seg, kind, p) {
          var st = seg.el.status;
          if (kind === "rec") {
            var pct = Math.round(p * 100);
            if (!st.firstChild || !st.querySelector(".x-bar")) {
              st.innerHTML = '<span class="chip chip--solid">Recording</span><div class="x-bar"><span></span></div>';
            }
            st.querySelector(".chip").textContent = "Recording " + pct + "%";
            st.querySelector(".x-bar span").style.width = pct + "%";
          } else if (kind === "done") {
            st.innerHTML = '<span class="chip chip--solid">Ready</span>';
          } else if (kind === "check") {
            st.innerHTML = '<span class="chip">Checking length…</span>';
          } else if (kind === "wait") {
            st.innerHTML = '<span class="chip">Waiting for video…</span>';
          } else if (kind === "queued") {
            st.innerHTML = '<span class="chip">Queued</span>';
          } else if (kind === "failed") {
            st.innerHTML = '<span class="x-fail">Failed - retry</span>';
            if (p) { var m = document.createElement("p"); m.className = "x-hint"; m.textContent = p; st.appendChild(m); }
          } else {
            st.innerHTML = "";
          }
          seg.el.li.classList.toggle("is-failed", kind === "failed");
        }
        function setFailed(seg, reason) {
          setStatus(seg, "failed", reason);
          seg.el.btn.textContent = "Retry";
          seg.el.btn.setAttribute("aria-label", "Retry Part " + seg.n);
          seg.failed = true;
        }
        function clipName(seg) {
          var base = (S.name.replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "clip";
          return base + "-part-" + pad(seg.n) + "." + EXT;
        }
        function triggerDownload(seg) {
          var a = document.createElement("a");
          a.href = seg.url; a.download = clipName(seg); a.rel = "noopener";
          a.style.display = "none";
          document.body.appendChild(a); a.click();
          setTimeout(function () { a.remove(); }, 1000);
        }
        function setResult(seg, blob, url) {
          if (seg.url && seg.url !== url) URL.revokeObjectURL(seg.url);
          if (seg.el.dl) { seg.el.dl.remove(); seg.el.dl = null; }
          seg.blob = blob;
          seg.url = url || URL.createObjectURL(blob);
          seg.failed = false;
          var fname = clipName(seg);
          var out = seg.el.out;
          out.innerHTML = "";
          var row = document.createElement("div");
          row.className = "x-row";
          var help = document.createElement("p");
          help.className = "x-hint x-hidden";
          help.setAttribute("aria-live", "polite");
          var dl = document.createElement("a");
          dl.className = "x-btn x-btn--primary";
          dl.href = seg.url; dl.download = fname; dl.textContent = "Download";
          dl.setAttribute("aria-label", "Download Part " + seg.n);
          dl.addEventListener("click", function (e) {
            try {
              e.stopPropagation();
              setTimeout(function () {
                help.textContent = "Download not starting? Use one of the options below.";
                show(help, true);
              }, 600);
            } catch (err) {
              help.textContent = "Download not starting? Use one of the options below.";
              show(help, true);
            }
          });
          var sh = document.createElement("button");
          sh.type = "button"; sh.className = "x-btn"; sh.textContent = "Share / Save";
          sh.setAttribute("aria-label", "Share or save Part " + seg.n);
          var file = null;
          try { file = new File([blob], fname, { type: blob.type || BLOBTYPE }); } catch (err) { file = null; }
          var canShare = false;
          try { canShare = !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (err) { canShare = false; }
          sh.addEventListener("click", function (e) {
            e.stopPropagation();
            var fail = function (err) {
              if (err && err.name === "AbortError") return;
              help.textContent = "Sharing is blocked here, use the video menu instead.";
              show(help, true);
            };
            try {
              var p = navigator.share({ files: [file], title: fname });
              if (p && p.catch) p.catch(fail);
            } catch (err) { fail(err); }
          });
          var op = document.createElement("a");
          op.className = "x-btn";
          op.href = seg.url; op.target = "_blank"; op.rel = "noopener"; op.textContent = "Open in new tab";
          op.setAttribute("aria-label", "Open Part " + seg.n + " in a new tab");
          op.addEventListener("click", function (e) { e.stopPropagation(); });
          var size = document.createElement("span");
          size.className = "x-hint";
          size.textContent = (blob.size / 1048576).toFixed(1) + " MB · ." + EXT + (seg.realDur ? " · " + seg.realDur.toFixed(1) + "s checked" : "");
          dl.className = "x-btn x-btn--primary";
          seg.el.acts.insertBefore(dl, seg.el.btn);
          seg.el.dl = dl;
          if (canShare) row.appendChild(sh);
          row.appendChild(op); row.appendChild(size);
          out.appendChild(row); out.appendChild(help);
          show(out, true);
          seg.el.li.classList.add("is-done");
          seg.el.btn.textContent = "Make again";
          seg.el.btn.setAttribute("aria-label", "Make Part " + seg.n + " again");
          setStatus(seg, "done");
          refreshDone();
        }
        function refreshDone() {
          var n = S.segs.filter(function (s) { return s.blob; }).length;
          var f = S.segs.filter(function (s) { return s.failed; }).length;
          $("donecount").textContent = n + " of " + S.segs.length + " ready" + (f ? " · " + f + " failed" : "");
          $("dlAll").disabled = !n || DLALL.busy;
        }
        var DLALL = { busy: false, stop: false };
        $("dlAll").addEventListener("click", function () {
          if (DLALL.busy) { DLALL.stop = true; return; }
          var list = S.segs.filter(function (s) { return s.blob && s.url; });
          if (!list.length) return;
          DLALL.busy = true; DLALL.stop = false;
          var i = 0;
          $("dlAll").textContent = "Stop downloads";
          (function next() {
            if (DLALL.stop || i >= list.length) {
              DLALL.busy = false; $("dlAll").textContent = "Download all"; refreshDone();
              $("cstatus").textContent = DLALL.stop ? "Downloads stopped after " + i + "." : "Sent " + i + " download" + (i === 1 ? "" : "s") + ". If only one arrived, allow multiple downloads for this site.";
              return;
            }
            var seg = list[i++];
            if (seg.url) triggerDownload(seg);
            $("cstatus").textContent = "Downloading " + i + " of " + list.length + "…";
            setTimeout(next, 900);
          })();
        });
        function refreshButtons() {
          S.segs.forEach(function (s) {
            s.el.btn.disabled = S.busy || unsupported;
            s.el.li.classList.toggle("is-locked", S.busy || unsupported);
          });
          var left = S.segs.filter(function (s) { return !s.blob; }).length;
          $("makeAll").disabled = S.busy || unsupported || !left;
          $("makeAll").textContent = left && left < S.segs.length ? "Make remaining " + left + " clips" : left ? "Make all " + left + " clips" : "All clips are made";
          show($("makeAll"), !S.busy);
          show($("progress"), S.busy);
          $("pause").textContent = S.paused ? "Resume" : "Pause";
          refreshDone();
          updateStepper();
        }

        /* ---------- audio ---------- */
        var AU = { mode: null, ctx: null, dest: null };
        function primeAudio() {
          // Called inside the tap, so the browser lets audio start.
          if (AU.mode === null) {
            var AC = window.AudioContext || window.webkitAudioContext;
            try {
              AU.ctx = new AC();
              var src = AU.ctx.createMediaElementSource(rec);
              AU.dest = AU.ctx.createMediaStreamDestination();
              src.connect(AU.dest); // not to the speakers, so recording stays silent
              AU.mode = "ctx";
            } catch (e) {
              AU.mode = "stream";
            }
          }
          if (AU.ctx && AU.ctx.state === "suspended") AU.ctx.resume().catch(function () {});
          // Unlock the hidden player for later clips in the queue.
          if (rec.paused) {
            var p = rec.play();
            if (p && p.then) p.then(function () { if (!S.recording) rec.pause(); }, function () {});
          }
        }
        function audioTracks() {
          if (AU.mode === "ctx") return AU.dest.stream.getAudioTracks();
          try {
            var s = rec.captureStream ? rec.captureStream() : rec.mozCaptureStream ? rec.mozCaptureStream() : null;
            return s ? s.getAudioTracks() : [];
          } catch (e) { return []; }
        }

        /* ---------- recording ---------- */
        var kick = null;
        document.addEventListener("visibilitychange", function () {
          if (kick) kick();
          if (S.busy && document.hidden) show($("hiddenwarn"), true);
          if (S.busy && !document.hidden) requestWake();
        });

        /* Seek strictly: wait for 'seeked', then for 'canplay' (data at the new spot). No guessing timers. */
        function seekStrict(v, t) {
          return new Promise(function (res, rej) {
            var done = false, slow;
            function clean() {
              v.removeEventListener("seeked", onSeeked); v.removeEventListener("canplay", onCan);
              v.removeEventListener("error", onErr); clearTimeout(slow);
            }
            function ok() { if (done) return; done = true; clean(); res(); }
            function onCan() { if (!v.seeking) ok(); }
            function onSeeked() { if (v.readyState >= 3) ok(); else v.addEventListener("canplay", onCan); }
            function onErr() { if (done) return; done = true; clean(); rej(new Error("The video couldn't seek to " + fmt(t) + ".")); }
            v.addEventListener("seeked", onSeeked); v.addEventListener("error", onErr);
            // Only a hard failure after a long time; a slow seek just keeps waiting.
            slow = setTimeout(function () { if (!done && v.readyState >= 3 && !v.seeking) ok(); else slow = setTimeout(onErr, 60000); }, 20000);
            if (Math.abs(v.currentTime - t) < 0.001) t += 0.001;
            v.currentTime = t;
          });
        }

        /* One canvas and one captured stream, reused for every clip in a run. */
        var RC = { canvas: null, ctx: null, vs: null, w: 0, h: 0 };
        function recCanvas(size) {
          if (!RC.canvas) { RC.canvas = document.createElement("canvas"); RC.ctx = RC.canvas.getContext("2d"); }
          if (RC.w !== size.w || RC.h !== size.h || !RC.vs || RC.vs.getVideoTracks()[0].readyState === "ended") {
            if (RC.vs) RC.vs.getTracks().forEach(function (t) { t.stop(); });
            RC.canvas.width = RC.w = size.w; RC.canvas.height = RC.h = size.h;
            RC.vs = RC.canvas.captureStream(30);
          }
          return RC;
        }
        function releaseCanvas() {
          if (RC.vs) RC.vs.getTracks().forEach(function (t) { t.stop(); });
          RC.vs = null; RC.w = RC.h = 0;
          if (RC.canvas) { RC.canvas.width = RC.canvas.height = 1; }
        }

        function record(seg, o, onProgress, onState) {
          var size = outSize(o.format), rc, cuts = cutsFor(seg), ospan = seg.end - seg.start - cutLen(cuts), skipping = false;
          var recorder, chunks = [], fx = { h: false, z: {} };
          rec.pause();
          onState("wait");
          return seekStrict(rec, seg.start).then(function () {
            rc = recCanvas(size);
            drawFrame(rc.ctx, rec, size.w, size.h, o, seg.n, 0, ospan);
            drawCaptions(rc.ctx, size.w, size.h, o.style, o.caps, rec.currentTime);
            var stream = new MediaStream(rc.vs.getVideoTracks().concat(audioTracks()));
            var bps = Math.max(2500000, Math.min(10000000, Math.round(size.w * size.h * 30 * 0.13)));
            var opts = { videoBitsPerSecond: bps, audioBitsPerSecond: 128000 };
            if (MIME) opts.mimeType = MIME;
            recorder = new MediaRecorder(stream, opts);
            recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
            return new Promise(function (resolve, reject) {
              var done = false, raf = 0, timer = 0, dog = 0, span = seg.end - seg.start;
              var stalled = false, lastT = -1, lastMove = performance.now();
              var activeMs = 0, since = 0; // time the recorder actually recorded, for the WebM Duration
              function clock(on) {
                var now = performance.now();
                if (since) activeMs += now - since;
                since = on ? now : 0;
              }
              function cancel() { cancelAnimationFrame(raf); clearTimeout(timer); }
              function holdRecorder() { if (recorder.state === "recording") { recorder.pause(); clock(false); } }
              function runRecorder() { if (recorder.state === "paused" && !stalled && !S.paused && !skipping) { recorder.resume(); clock(true); } }
              // Silence cut: hold the recorder, jump past the gap, resume only once the new frame can play.
              function skipTo(c) {
                skipping = true; holdRecorder(); rec.pause();
                seekStrict(rec, c.e).then(function () {
                  lastMove = performance.now();
                  if (done || S.paused) { skipping = false; return; }
                  return rec.play().then(function () {
                    skipping = false;
                    if (done) return;
                    var t2 = rec.currentTime;
                    drawFrame(rc.ctx, rec, size.w, size.h, o, seg.n, outT(cuts, seg, t2), ospan);
                    drawCaptions(rc.ctx, size.w, size.h, o.style, o.caps, t2);
                    runRecorder();
                  });
                }).catch(function () { c.e = c.s; skipping = false; lastMove = 0; });
              }
              function onWaiting() { if (done) return; stalled = true; holdRecorder(); onState("wait"); }
              function onPlaying() { if (done) return; stalled = false; runRecorder(); onState("rec"); }
              function onPause() {
                // A pause we did not ask for (buffer, OS, media keys): keep the recorder alive and play on.
                if (done || S.paused || S.abort || skipping) return;
                if (rec.currentTime >= seg.end - 0.04) return;
                holdRecorder();
                rec.play().catch(function () {});
              }
              function listen(on) {
                var f = on ? "addEventListener" : "removeEventListener";
                rec[f]("waiting", onWaiting); rec[f]("stalled", onWaiting); rec[f]("playing", onPlaying); rec[f]("pause", onPause);
              }
              function finish() {
                if (done) return; done = true;
                cancel(); clearInterval(dog); kick = null; S.recording = false; S.pauseHook = null;
                listen(false);
                rec.pause();
                clock(false);
                if (recorder.state !== "inactive") {
                  try { recorder.requestData(); } catch (e) {}
                  recorder.stop();
                }
              }
              function schedule() {
                cancel();
                if (document.hidden) timer = setTimeout(loop, 33);
                else raf = requestAnimationFrame(loop);
              }
              function loop() {
                if (done) return;
                if (S.abort) { finish(); return; }
                var t = rec.currentTime;
                // The only finish line: the clip's end time in the source.
                var atEnd = t >= seg.end - 0.02 || (rec.ended && t >= Math.min(seg.end, rec.duration) - 0.3);
                if (!S.paused && !stalled && rec.readyState >= 2) {
                  drawFrame(rc.ctx, rec, size.w, size.h, o, seg.n, outT(cuts, seg, t), ospan);
                  drawCaptions(rc.ctx, size.w, size.h, o.style, o.caps, t);
                  if (!skipping && recorder.state === "recording") sfxTick(fx, t, outT(cuts, seg, t));
                }
                if (atEnd) { finish(); return; }
                var cut = !skipping && !S.paused && !stalled && cuts.filter(function (c) { return t >= c.s - 0.02 && t < c.e - 0.05; })[0];
                if (cut) { skipTo(cut); schedule(); return; }
                if (t !== lastT) { lastT = t; lastMove = performance.now(); }
                onProgress(Math.min(1, outT(cuts, seg, t) / ospan));
                schedule();
              }
              // Watchdog: if time stops moving, recover the player; never stop the recorder.
              dog = setInterval(function () {
                if (done || S.paused || skipping) return;
                if (performance.now() - lastMove < 4000) return;
                lastMove = performance.now();
                holdRecorder(); stalled = true; onState("wait");
                var t = rec.currentTime;
                if (t >= seg.end - 0.3 || (rec.ended && t >= rec.duration - 0.3)) { finish(); return; }
                seekStrict(rec, t + 0.05).then(function () { return rec.play(); }).then(function () { stalled = false; runRecorder(); onState("rec"); }, function () {});
              }, 1000);
              // Queue Pause/Resume reaches into the clip being recorded.
              S.pauseHook = function (paused) {
                if (done) return;
                if (paused) { holdRecorder(); rec.pause(); onState("paused"); }
                else { lastMove = performance.now(); rec.play().then(function () { runRecorder(); onState("rec"); }, function () {}); }
              };
              recorder.onstop = function () {
                // 'stop' fires after the final dataavailable; wait one task so that last chunk is in.
                setTimeout(function () {
                  if (S.abort) { chunks = []; resolve(null); return; }
                  var blob = new Blob(chunks, { type: BLOBTYPE });
                  chunks = [];
                  resolve({ blob: blob, ms: activeMs });
                }, 0);
              };
              recorder.onerror = function (e) { finish(); reject(new Error("The recorder stopped: " + ((e.error && e.error.message) || "unknown error") + ".")); };
              S.recording = true;
              var start = function () {
                if (done) return;
                listen(true);
                recorder.start(1000);
                clock(true);
                kick = schedule;
                lastMove = performance.now();
                if (rec.readyState < 3) onWaiting(); else onState("rec");
                loop();
              };
              function playReally() {
                var p = rec.play();
                if (!p || !p.then) return once(rec, "playing", 0);
                return p.then(function () {
                  if (rec.paused) throw new Error("play() resolved but the video is still paused");
                });
              }
              playReally().then(start, function (err) {
                if (err && err.name === "NotAllowedError") {
                  // Sound was blocked: record without it rather than fail.
                  rec.muted = true;
                  $("cstatus").textContent = "Your browser blocked sound, so this clip may be silent. Tap Make again to retry with sound.";
                  return playReally().then(start);
                }
                throw err;
              }).catch(function (err) {
                S.recording = false; done = true; clearInterval(dog);
                reject(new Error("The video wouldn't play (" + ((err && err.message) || "unknown") + ")."));
              });
            });
          });
        }

        /* ---------- WebM Duration fix (EBML) ---------- */
        // MediaRecorder WebM has no Duration in Segment > Info. Insert one so players show the right length.
        function ebmlVint(b, p) {
          var first = b[p], len = 1, mask = 0x80;
          while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
          if (len > 8) return null;
          var val = first & (mask - 1), allOnes = val === mask - 1;
          for (var i = 1; i < len; i++) { val = val * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
          return { len: len, val: val, unknown: allOnes };
        }
        function ebmlId(b, p) {
          var first = b[p], len = 1, mask = 0x80;
          while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
          if (len > 4) return null;
          var id = 0;
          for (var i = 0; i < len; i++) id = id * 256 + b[p + i];
          return { len: len, id: id };
        }
        function size8(n) { var o = new Uint8Array(8); o[0] = 0x01; for (var i = 7; i >= 1; i--) { o[i] = n % 256; n = Math.floor(n / 256); } return o; }
        function fixWebmDuration(blob, ms) {
          if (!/webm/.test(blob.type) || !(ms > 0)) return Promise.resolve(blob);
          var headLen = Math.min(blob.size, 1048576);
          return blob.slice(0, headLen).arrayBuffer().then(function (ab) {
            var b = new Uint8Array(ab), p = 0;
            var h = ebmlId(b, p); if (!h || h.id !== 0x1a45dfa3) return blob;
            var hs = ebmlVint(b, p + h.len); p += h.len + hs.len + hs.val;
            var sg = ebmlId(b, p); if (!sg || sg.id !== 0x18538067) return blob;
            var segSizePos = p + sg.len, ss = ebmlVint(b, segSizePos), segData = segSizePos + ss.len;
            p = segData;
            while (p < b.length - 8) {
              var el = ebmlId(b, p); if (!el) return blob;
              var es = ebmlVint(b, p + el.len); if (!es) return blob;
              var dataStart = p + el.len + es.len;
              if (el.id === 0x1549a966) {
                var infoEnd = dataStart + es.val;
                if (es.unknown || infoEnd > b.length) return blob;
                var q = dataStart, scale = 1000000, durPos = -1;
                while (q < infoEnd) {
                  var ce = ebmlId(b, q); if (!ce) return blob;
                  var cs = ebmlVint(b, q + ce.len); if (!cs || cs.unknown) return blob;
                  var cd = q + ce.len + cs.len;
                  if (ce.id === 0x2ad7b1) { scale = 0; for (var k = 0; k < cs.val; k++) scale = scale * 256 + b[cd + k]; }
                  if (ce.id === 0x4489 && cs.val === 8) durPos = cd;
                  q = cd + cs.val;
                }
                var dv = new DataView(new ArrayBuffer(8));
                dv.setFloat64(0, (ms * 1000000) / (scale || 1000000));
                var dbytes = new Uint8Array(dv.buffer);
                if (durPos > -1) { // Duration exists: overwrite in place.
                  var copy = b.slice(); copy.set(dbytes, durPos);
                  return new Blob([copy, blob.slice(headLen)], { type: blob.type });
                }
                var durEl = new Uint8Array(11); durEl[0] = 0x44; durEl[1] = 0x89; durEl[2] = 0x88; durEl.set(dbytes, 3);
                var infoBody = b.subarray(dataStart, infoEnd);
                var newInfo = new Uint8Array(4 + 8 + infoBody.length + 11);
                newInfo.set(b.subarray(p, p + el.len), 0);
                newInfo.set(size8(infoBody.length + 11), 4);
                newInfo.set(infoBody, 12); newInfo.set(durEl, 12 + infoBody.length);
                var before = b.subarray(0, segData), parts;
                if (!ss.unknown) { // Known Segment size: grow it by the bytes we add.
                  var grow = newInfo.length - (infoEnd - p);
                  parts = [b.subarray(0, segSizePos), size8(ss.val + grow), b.subarray(segData, p)];
                } else parts = [before.subarray(0, segData), b.subarray(segData, p)];
                parts.push(newInfo, b.subarray(infoEnd), blob.slice(headLen));
                return new Blob(parts, { type: blob.type });
              }
              if (el.id === 0x1f43b675) return blob; // reached a Cluster without finding Info
              p = dataStart + es.val;
            }
            return blob;
          }).catch(function () { return blob; });
        }

        /* ---------- check the real length of an exported file ---------- */
        var probev = $("probev");
        function probeDuration(url) {
          return new Promise(function (res) {
            var done = false, to;
            function fin(d) {
              if (done) return; done = true; clearTimeout(to);
              probev.removeEventListener("loadedmetadata", onMeta); probev.removeEventListener("durationchange", onDur);
              probev.removeEventListener("timeupdate", onDur); probev.removeEventListener("error", onErr);
              probev.removeAttribute("src"); try { probev.load(); } catch (e) {}
              res(d);
            }
            function onDur() { if (isFinite(probev.duration) && probev.duration > 0) fin(probev.duration); }
            function onMeta() {
              if (isFinite(probev.duration) && probev.duration > 0) { fin(probev.duration); return; }
              // WebM without Duration reports Infinity: jump far past the end so the browser resolves it.
              probev.addEventListener("durationchange", onDur); probev.addEventListener("timeupdate", onDur);
              try { probev.currentTime = 1e101; } catch (e) {}
            }
            function onErr() { fin(0); }
            probev.addEventListener("loadedmetadata", onMeta); probev.addEventListener("error", onErr);
            to = setTimeout(function () { fin(isFinite(probev.duration) ? probev.duration : 0); }, 15000);
            probev.src = url;
          });
        }

        /* ---------- keep the screen awake ---------- */
        var wake = null;
        function requestWake() {
          try {
            if (navigator.wakeLock && !wake && !document.hidden) {
              navigator.wakeLock.request("screen").then(function (w) {
                wake = w; w.addEventListener("release", function () { if (wake === w) wake = null; });
              }, function () {});
            }
          } catch (e) {}
        }
        function releaseWake() { if (wake) { try { wake.release().catch(function () {}); } catch (e) {} wake = null; } }

        /* ---------- sequential queue: one clip at a time ---------- */
        function makeQueue(list) {
          if (S.busy || unsupported || !list.length) return;
          if ($("bcut").checked && !(AN && AN.file === S.file) && S.file) {
            $("cstatus").textContent = "Analysing audio for silence cut…";
            analyze().then(function () { makeQueue(list); }, function (err) {
              $("bcut").checked = false; makeQueue(list);
              alertMsg($("err3"), "Silence cut skipped", err.message);
            });
            return;
          }
          rec.muted = false;
          primeAudio();
          S.busy = true; S.abort = false; S.paused = false;
          alertMsg($("err3"));
          show($("hiddenwarn"), false);
          $("cstatus").textContent = "";
          refreshButtons();
          requestWake();
          var o = S.built;
          var lens = list.map(function (i) { var s = S.segs[i]; return s.end - s.start - cutLen(cutsFor(s)); });
          var total = lens.reduce(function (a, b) { return a + b; }, 0);
          var doneSec = 0, made = 0, failed = 0, k = 0, cur = 0;
          var t0 = performance.now(), pausedMs = 0, pausedAt = 0;
          list.forEach(function (i) { var s = S.segs[i]; if (!s.blob) setStatus(s, "queued"); });
          function progress(p) {
            cur = doneSec + p * lens[k];
            var pct = Math.round((cur / total) * 100);
            // Real time per media second so far (at least 1.0), applied to what is left, plus overhead per clip.
            var spent = (performance.now() - t0 - pausedMs) / 1000;
            var rate = cur > 5 ? Math.max(1, spent / cur) : 1.05;
            var left = (total - cur) * rate + (list.length - k - 1) * 2;
            $("ptext").textContent = (S.paused ? "Paused · " : "") + "Clip " + (k + 1) + " of " + list.length + " · " + pct + "%";
            $("peta").textContent = S.paused ? "" : eta(left);
            $("pbar").firstChild.style.width = pct + "%";
            $("pbar").setAttribute("aria-valuenow", pct);
          }
          S.queueProgress = function () { progress(Math.max(0, (cur - doneSec) / (lens[k] || 1))); };
          function whilePaused() {
            if (!S.paused || S.abort) return Promise.resolve();
            return new Promise(function (res) { var t = setInterval(function () { if (!S.paused || S.abort) { clearInterval(t); res(); } }, 200); });
          }
          function step() {
            if (S.abort || k >= list.length) return Promise.resolve();
            return whilePaused().then(function () {
              if (S.abort) return;
              var seg = S.segs[list[k]], span = lens[k];
              progress(0);
              setStatus(seg, "wait");
              seg.el.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
              return record(seg, o, function (p) { setStatus(seg, "rec", p); progress(p); }, function (st) {
                if (st === "wait") setStatus(seg, "wait");
                else if (st === "paused") setStatus(seg, "queued");
              }).then(function (res) {
                if (!res || !res.blob || !res.blob.size) {
                  if (S.abort) setStatus(seg, seg.blob ? "done" : "idle");
                  else { setFailed(seg, "The recorder returned an empty file."); failed++; }
                  return;
                }
                setStatus(seg, "check");
                return fixWebmDuration(res.blob, res.ms).then(function (blob) {
                  var url = URL.createObjectURL(blob);
                  return probeDuration(url).then(function (d) {
                    seg.realDur = d;
                    if (!(d >= span * 0.9)) {
                      URL.revokeObjectURL(url);
                      setFailed(seg, "The file came out " + (d ? d.toFixed(1) + "s" : "unreadable") + " instead of " + Math.round(span) + "s.");
                      failed++;
                      return;
                    }
                    setResult(seg, blob, url); made++;
                  });
                });
              }, function (err) {
                setFailed(seg, (err && err.message) || "Recording failed.");
                failed++;
                // One clip failing does not end the queue; a seek can recover on the next one.
              }).then(function () {
                doneSec += lens[k]; k++;
                return step();
              });
            });
          }
          step().catch(function (err) {
            alertMsg($("err3"), "Something went wrong", (err && err.message ? err.message + " " : "") + "Try again, or use the latest Chrome or Edge.");
          }).then(function () {
            var stopped = S.abort;
            S.busy = false; S.abort = false; S.recording = false; S.paused = false; S.pauseHook = null; S.queueProgress = null;
            rec.pause();
            releaseWake();
            releaseCanvas();
            refreshButtons();
            if (!$("cstatus").textContent || /^Paused/.test($("cstatus").textContent)) {
              $("cstatus").textContent = (stopped ? "Cancelled. " + made + " clip" + (made === 1 ? "" : "s") + " made." : "Done. " + made + " clip" + (made === 1 ? " is" : "s are") + " ready to download.") +
                (failed ? " " + failed + " failed - tap Retry on " + (failed === 1 ? "it" : "each") + "." : "");
            }
          });
          S.markPause = function (on) {
            if (on) pausedAt = performance.now();
            else if (pausedAt) { pausedMs += performance.now() - pausedAt; pausedAt = 0; }
          };
        }
        $("makeAll").addEventListener("click", function () {
          var list = [];
          S.segs.forEach(function (s, i) { if (!s.blob) list.push(i); });
          makeQueue(list);
        });
        $("pause").addEventListener("click", function () {
          if (!S.busy) return;
          S.paused = !S.paused;
          if (S.markPause) S.markPause(S.paused);
          if (S.pauseHook) S.pauseHook(S.paused);
          sfxMute(S.paused);
          $("cstatus").textContent = S.paused ? "Paused. Tap Resume to carry on from here." : "";
          if (S.paused) releaseWake(); else requestWake();
          refreshButtons();
          if (S.queueProgress) S.queueProgress();
        });
        $("stop").addEventListener("click", function () {
          S.abort = true;
          if (S.paused) { S.paused = false; }
          $("ptext").textContent = "Cancelling…";
          if (kick) kick();
        });
        /* ---------- welcome popup, every visit ---------- */
        (function welcome() {
          var dlg = $("welcome"), dim = null, fallback = false;
          function close() {
            if (fallback) {
              dlg.removeAttribute("open"); dlg.classList.remove("is-fallback");
              if (dim) { dim.remove(); dim = null; }
              document.removeEventListener("keydown", onKey);
            } else { try { dlg.close(); } catch (e) { dlg.removeAttribute("open"); } }
          }
          function onKey(e) { if (e.key === "Escape") close(); }
          try {
            if (typeof dlg.showModal !== "function") throw new Error("no dialog");
            dlg.showModal();
          } catch (e) {
            fallback = true;
            dim = document.createElement("div"); dim.className = "x-modal-dim";
            dim.addEventListener("click", close);
            document.body.appendChild(dim);
            dlg.classList.add("is-fallback"); dlg.setAttribute("open", ""); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true");
            document.addEventListener("keydown", onKey);
          }
          try { $("welcomeDone").focus(); } catch (e) {}
          $("welcomeDone").addEventListener("click", close);
          // A tap on the dimmed area (the dialog box itself, outside its content) closes it.
          dlg.addEventListener("click", function (e) { if (e.target === dlg) close(); });
        })();

        window.addEventListener("beforeunload", function (e) { if (S.busy) { e.preventDefault(); e.returnValue = ""; } });
      })();
    