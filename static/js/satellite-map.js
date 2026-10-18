(function initSatelliteCards() {
  // NASA GIBS Himawari-9 tiles (10-minute frames) for every [data-satellite-card] on the page.
  var GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
  var SAT_LAYERS = {
    vis: { id: 'Himawari_AHI_Band3_Red_Visible_1km', level: 7 },
    ir: { id: 'Himawari_AHI_Band13_Clean_Infrared', level: 6 },
    airmass: { id: 'Himawari_AHI_Air_Mass', level: 6 }
  };
  var FRAME_COUNT = 18; // 3 hours
  var LOCAL_OFFSET_HOURS = 8;

  function gibsUrl(layer, time, level, ext) {
    return GIBS + layer + '/default/' + time + '/GoogleMapsCompatible_Level' + level + '/{z}/{y}/{x}.' + ext;
  }

  function isoMinute(t) {
    return new Date(t).toISOString().slice(0, 19) + 'Z';
  }

  function frameTimes(endMs) {
    var out = [];
    for (var i = FRAME_COUNT - 1; i >= 0; i--) out.push(isoMinute(endMs - i * 600000));
    return out;
  }

  // GIBS publishes frames roughly 40-90 min late. Probe one tile over the plant, stepping back
  // 10 min at a time, so the loop ends on the newest frame that actually exists.
  function findLatestFrame(cfg, lat, lon, cb) {
    var z = 5;
    var n = Math.pow(2, z);
    var x = Math.floor((lon + 180) / 360 * n);
    var latR = lat * Math.PI / 180;
    var y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
    var start = Date.now() - 30 * 60000;
    var first = Math.floor(start / 600000) * 600000;
    (function tryStep(k) {
      var t = first - k * 600000;
      if (k > 12) { cb(first - 6 * 600000); return; } // give up after 2 h: fall back to ~1 h ago
      var img = new Image();
      img.onload = function () { cb(t); };
      img.onerror = function () { tryStep(k + 1); };
      img.src = gibsUrl(cfg.id, isoMinute(t), cfg.level, 'png').replace('{z}', z).replace('{y}', y).replace('{x}', x);
    })(0);
  }

  function mount(card) {
    var mapEl = card.querySelector('[data-sat-map]');
    var layerSel = card.querySelector('[data-sat-layer]');
    var slider = card.querySelector('[data-sat-slider]');
    var playBtn = card.querySelector('[data-sat-play]');
    var timeEl = card.querySelector('[data-sat-time]');
    var lat = parseFloat(card.getAttribute('data-lat'));
    var lon = parseFloat(card.getAttribute('data-lon'));
    var zoom = parseInt(card.getAttribute('data-zoom') || '7', 10);
    var map = null;
    var frames = [];
    var frameIdx = 0;
    var playTimer = null;
    var builtAt = 0;

    function updateTimeLabel() {
      var f = frames[frameIdx];
      if (!f || !timeEl) return;
      var utc = f.time.slice(0, 16).replace('T', ' ');
      var local = new Date(new Date(f.time).getTime() + LOCAL_OFFSET_HOURS * 3600000).toISOString().slice(11, 16);
      var note = f.failed > 0 && f.loaded === 0 ? ' · no image' : (f.filled > 0 ? ' · some tiles from earlier frames' : '');
      timeEl.textContent = utc + ' UTC · ' + local + ' local' + note;
    }

    function ensureFrame(i) {
      var f = frames[i];
      if (!f || f.layer) return;
      f.layer = L.tileLayer(gibsUrl(f.cfg.id, f.time, f.cfg.level, 'png'), {
        maxNativeZoom: f.cfg.level,
        maxZoom: 10,
        opacity: 0,
        attribution: 'NASA GIBS · JMA Himawari-9'
      });
      f.layer.on('tileload', function () { f.loaded++; if (i === frameIdx) updateTimeLabel(); });
      // GIBS publishes a frame tile by tile, so recent frames have holes for a while:
      // fill a missing tile with the same tile from up to 3 earlier frames (10-30 min older).
      f.layer.on('tileerror', function (e) {
        var back = (parseInt(e.tile.getAttribute('data-back') || '0', 10)) + 1;
        if (back <= 3) {
          var older = isoMinute(new Date(f.time).getTime() - back * 600000);
          e.tile.setAttribute('data-back', String(back));
          if (back === 1) f.filled++;
          e.tile.src = L.Util.template(gibsUrl(f.cfg.id, older, f.cfg.level, 'png'), e.coords);
          return;
        }
        f.failed++;
        if (i === frameIdx) updateTimeLabel();
      });
      f.layer.addTo(map);
    }

    function showFrame(i) {
      if (!map || !frames.length) return;
      frameIdx = Math.max(0, Math.min(frames.length - 1, i));
      ensureFrame(frameIdx);
      ensureFrame((frameIdx + 1) % frames.length); // preload next
      frames.forEach(function (f, j) {
        if (f.layer) f.layer.setOpacity(j === frameIdx ? 0.85 : 0);
      });
      if (slider) slider.value = String(frameIdx);
      updateTimeLabel();
    }

    function buildFrames() {
      var cfg = SAT_LAYERS[(layerSel && layerSel.value) || 'vis'];
      builtAt = Date.now();
      if (timeEl) timeEl.textContent = 'Finding latest image…';
      findLatestFrame(cfg, lat, lon, function (endMs) {
        frames.forEach(function (f) { if (f.layer) map.removeLayer(f.layer); });
        frames = frameTimes(endMs).map(function (t) {
          return { time: t, cfg: cfg, layer: null, loaded: 0, failed: 0, filled: 0 };
        });
        if (slider) {
          slider.max = String(frames.length - 1);
          slider.value = String(frames.length - 1);
        }
        showFrame(frames.length - 1);
      });
    }

    function stopPlay() {
      if (playTimer) clearInterval(playTimer);
      playTimer = null;
      if (playBtn) playBtn.textContent = 'Play';
    }

    function init() {
      if (map || typeof L === 'undefined') return;
      map = L.map(mapEl, { zoomControl: true, worldCopyJump: true }).setView([lat, lon], zoom);
      L.tileLayer(gibsUrl('BlueMarble_ShadedRelief_Bathymetry', 'default', 8, 'jpg'), {
        maxNativeZoom: 8,
        maxZoom: 10,
        attribution: 'NASA Blue Marble'
      }).addTo(map);
      map.createPane('reference');
      map.getPane('reference').style.zIndex = 450;
      map.getPane('reference').style.pointerEvents = 'none';
      L.tileLayer(gibsUrl('Coastlines_15m', 'default', 13, 'png'), { pane: 'reference', maxZoom: 10 }).addTo(map);
      if (card.getAttribute('data-rings') === 'true') {
        [25000, 50000].forEach(function (r) {
          L.circle([lat, lon], {
            radius: r, pane: 'reference', color: '#10b981', weight: 1.5, opacity: 0.8, dashArray: '4 6', fill: false
          }).addTo(map);
        });
      }
      L.circleMarker([lat, lon], {
        radius: 7, color: '#10b981', weight: 3, fillColor: '#f8fafc', fillOpacity: 1, pane: 'markerPane'
      }).addTo(map).bindTooltip('ARECO plant');

      // Visible imagery is black at night: default to infrared outside roughly 06:00–17:00 local
      var localHour = (new Date().getUTCHours() + LOCAL_OFFSET_HOURS) % 24;
      if (layerSel && (localHour < 6 || localHour >= 17)) layerSel.value = 'ir';
      buildFrames();
    }

    if (layerSel) layerSel.addEventListener('change', function () { stopPlay(); if (map) buildFrames(); });
    if (slider) slider.addEventListener('input', function () { stopPlay(); showFrame(parseInt(slider.value, 10)); });
    if (playBtn) {
      playBtn.addEventListener('click', function () {
        if (playTimer) { stopPlay(); return; }
        playBtn.textContent = 'Pause';
        playTimer = setInterval(function () { showFrame((frameIdx + 1) % frames.length); }, 700);
      });
    }

    // Start when first visible (hidden panels have no size), keep the map sized, pause when off-screen.
    function onVisible(visible) {
      if (!visible) { stopPlay(); return; }
      if (!map) { init(); return; }
      map.invalidateSize();
      if (Date.now() - builtAt > 10 * 60000 && !playTimer) buildFrames(); // pick up newer frames
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { onVisible(e.isIntersecting); });
      }).observe(mapEl);
    } else {
      init();
    }
    setInterval(function () {
      if (map && !playTimer && mapEl.offsetParent !== null && Date.now() - builtAt > 10 * 60000) buildFrames();
    }, 60000);
  }

  function start() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-satellite-card]'), mount);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
