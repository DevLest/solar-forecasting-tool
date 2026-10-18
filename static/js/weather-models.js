(function initWeatherModels() {
  var panel = document.getElementById('panel-weather-models');
  if (!panel) return;

  var dateSel = document.getElementById('wm-date');
  var btnRefresh = document.getElementById('wm-btn-refresh');
  var spinner = document.getElementById('wm-spinner');
  var statusEl = document.getElementById('wm-status');
  var runsEl = document.getElementById('wm-runs');
  var spreadEl = document.getElementById('wm-spread');
  var tableBody = document.getElementById('wm-table-body');
  var btnCopy = document.getElementById('wm-btn-copy');
  var plantNote = document.getElementById('wm-plant-note');
  var kpi = {
    blend: document.getElementById('wm-kpi-blend'),
    peak: document.getElementById('wm-kpi-peak'),
    models: document.getElementById('wm-kpi-models'),
    cloud: document.getElementById('wm-kpi-cloud')
  };

  var COLORS = {
    blend: 'rgb(16, 185, 129)',
    gfs: 'rgb(56, 189, 248)',
    ecmwf: 'rgb(249, 115, 22)',
    clear: 'rgba(148, 163, 184, 0.7)',
    cap: 'rgba(244, 63, 94, 0.6)'
  };
  var HOURS = [];
  for (var h = 1; h <= 24; h++) HOURS.push((h < 10 ? '0' : '') + h);

  var payload = null;
  var chartMw = null;
  var chartGhi = null;
  var pollTimer = null;
  var loaded = false;

  function setStatus(msg, busy) {
    if (statusEl) statusEl.textContent = msg || '';
    if (spinner) spinner.classList.toggle('hidden', !busy);
    if (btnRefresh) btnRefresh.disabled = !!busy;
  }

  function fmt(v, d) {
    return v == null || isNaN(v) ? '—' : Number(v).toFixed(d == null ? 1 : d);
  }

  function runLabel(iso) {
    if (!iso) return '—';
    return iso.slice(0, 10) + ' ' + iso.slice(11, 13) + 'Z';
  }

  function localLabel(iso, offsetHours) {
    var t = new Date(iso.replace('Z', ':00Z'));
    if (isNaN(t.getTime())) return iso;
    var l = new Date(t.getTime() + offsetHours * 3600000);
    return l.toISOString().slice(0, 16).replace('T', ' ');
  }

  function dayLabel(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function slice24(arr) {
    return (arr || []).slice(1, 25);
  }

  function load(date) {
    var url = '/api/nwp-forecast' + (date ? '?date=' + encodeURIComponent(date) : '');
    return fetch(url)
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      })
      .then(function (ref) {
        if (!ref.ok || !ref.j.ok) {
          setStatus((ref.j && ref.j.error) || 'Could not load forecast.', false);
          return;
        }
        payload = ref.j;
        render();
        var st = payload.status || {};
        if (st.refreshing) {
          setStatus('Downloading the latest GFS and ECMWF runs in the background (about 3–5 minutes)…', true);
          schedulePoll();
        } else {
          setStatus(st.last_error ? 'Last download failed: ' + st.last_error : '', false);
        }
      })
      .catch(function () {
        setStatus('Network error while loading the forecast.', false);
      });
  }

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      load(dateSel && dateSel.value);
    }, 15000);
  }

  function render() {
    if (!payload.has_data) {
      if (runsEl) runsEl.textContent = 'No model data downloaded yet.';
      return;
    }
    var plant = payload.plant || {};
    if (plantNote) {
      plantNote.textContent = fmt(plant.dc_mwp, 1) + ' MWp DC × PR ' + fmt(plant.performance_ratio, 2) +
        ', capped at ' + fmt(plant.ac_max_mw, 0) + ' MW AC';
    }

    var day = payload.day;
    var models = (day && day.models) || {};
    var parts = [];
    ['gfs', 'ecmwf'].forEach(function (k) {
      var m = models[k];
      if (!m) return;
      var s = k.toUpperCase() + ' run ' + runLabel(m.run);
      if (m.error) s += ' (' + m.error + ')';
      parts.push(s);
    });
    if (payload.generated_at) {
      parts.push('downloaded ' + localLabel(payload.generated_at, plant.utc_offset_hours || 8) + ' local');
    }
    if (runsEl) runsEl.textContent = parts.join(' · ');

    if (dateSel) {
      var current = day ? day.date : '';
      dateSel.innerHTML = '';
      (payload.dates || []).forEach(function (d) {
        var o = document.createElement('option');
        o.value = d;
        o.textContent = dayLabel(d);
        if (d === current) o.selected = true;
        dateSel.appendChild(o);
      });
    }
    if (!day) return;

    renderKpis(day);
    renderCharts(day, plant);
    renderTable(day);
  }

  function renderKpis(day) {
    var g = day.models.gfs || {};
    var e = day.models.ecmwf || {};
    var blend = day.blend_mw || [];
    var peak = blend.length ? Math.max.apply(null, blend) : null;
    if (kpi.blend) kpi.blend.textContent = day.blend_energy_mwh != null ? fmt(day.blend_energy_mwh, 0) + ' MWh' : '—';
    if (kpi.peak) kpi.peak.textContent = peak != null ? fmt(peak, 1) + ' MW' : '—';
    if (kpi.models) kpi.models.textContent = fmt(g.energy_mwh, 0) + ' / ' + fmt(e.energy_mwh, 0);

    // Daytime = hours where clear-sky irradiance is meaningful
    var clouds = [];
    day.clear_sky_ghi.forEach(function (cs, i) {
      if (cs < 100) return;
      [g.cloud, e.cloud].forEach(function (arr) {
        if (arr && arr[i] != null) clouds.push(arr[i]);
      });
    });
    var avgCloud = clouds.length ? clouds.reduce(function (a, b) { return a + b; }, 0) / clouds.length : null;
    if (kpi.cloud) kpi.cloud.textContent = avgCloud != null ? fmt(avgCloud, 0) + ' %' : '—';

    if (spreadEl) {
      var show = false;
      if (g.energy_mwh && e.energy_mwh) {
        var mean = (g.energy_mwh + e.energy_mwh) / 2;
        var pct = Math.abs(g.energy_mwh - e.energy_mwh) / mean * 100;
        if (pct >= 20) {
          show = true;
          spreadEl.textContent = 'GFS and ECMWF disagree by ' + fmt(pct, 0) +
            '% on daily energy. Expect more uncertainty than usual; check the satellite loop on the day.';
        }
      }
      spreadEl.classList.toggle('hidden', !show);
    }
  }

  function lineDs(label, data, color, opts) {
    var ds = {
      label: label,
      data: data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.25,
      fill: false,
      spanGaps: false
    };
    for (var k in opts || {}) ds[k] = opts[k];
    return ds;
  }

  function axisStyle(title) {
    return {
      ticks: { color: '#64748b' },
      grid: { color: 'rgba(51, 65, 85, 0.5)' },
      title: title ? { display: true, text: title, color: '#94a3b8' } : undefined
    };
  }

  function renderCharts(day, plant) {
    if (typeof Chart === 'undefined') return;
    var g = day.models.gfs || {};
    var e = day.models.ecmwf || {};
    var cap = HOURS.map(function () { return plant.ac_max_mw; });

    var mwSets = [];
    if (day.blend_mw) mwSets.push(lineDs('Blend MW', slice24(day.blend_mw), COLORS.blend, { borderWidth: 3, pointRadius: 3 }));
    if (g.mw) mwSets.push(lineDs('GFS MW', slice24(g.mw), COLORS.gfs));
    if (e.mw) mwSets.push(lineDs('ECMWF MW', slice24(e.mw), COLORS.ecmwf));
    mwSets.push(lineDs('Clear-sky MW', slice24(day.clear_sky_mw), COLORS.clear, { borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 }));
    mwSets.push(lineDs('AC limit', cap, COLORS.cap, { borderDash: [2, 3], pointRadius: 0, borderWidth: 1 }));

    if (chartMw) chartMw.destroy();
    chartMw = new Chart(document.getElementById('wm-chart-mw').getContext('2d'), {
      type: 'line',
      data: { labels: HOURS, datasets: mwSets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
          x: axisStyle('Hour ending (local)'),
          y: Object.assign(axisStyle('MW'), { beginAtZero: true, suggestedMax: (plant.ac_max_mw || 50) + 5 })
        }
      }
    });

    var ghiSets = [];
    if (g.ghi) ghiSets.push(lineDs('GFS W/m²', slice24(g.ghi), COLORS.gfs, { yAxisID: 'y' }));
    if (e.ghi) ghiSets.push(lineDs('ECMWF W/m²', slice24(e.ghi), COLORS.ecmwf, { yAxisID: 'y' }));
    ghiSets.push(lineDs('Clear-sky W/m²', slice24(day.clear_sky_ghi), COLORS.clear, { borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, yAxisID: 'y' }));
    if (g.cloud) {
      ghiSets.push({ type: 'bar', label: 'GFS cloud %', data: slice24(g.cloud), yAxisID: 'y2', backgroundColor: 'rgba(56, 189, 248, 0.15)', borderWidth: 0 });
    }
    if (e.cloud) {
      ghiSets.push({ type: 'bar', label: 'ECMWF cloud %', data: slice24(e.cloud), yAxisID: 'y2', backgroundColor: 'rgba(249, 115, 22, 0.15)', borderWidth: 0 });
    }

    if (chartGhi) chartGhi.destroy();
    chartGhi = new Chart(document.getElementById('wm-chart-ghi').getContext('2d'), {
      type: 'line',
      data: { labels: HOURS, datasets: ghiSets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
          x: axisStyle('Hour ending (local)'),
          y: Object.assign(axisStyle('W/m²'), { beginAtZero: true, position: 'left' }),
          y2: Object.assign(axisStyle('Cloud %'), { min: 0, max: 100, position: 'right', grid: { drawOnChartArea: false } })
        }
      }
    });
  }

  function renderTable(day) {
    if (!tableBody) return;
    var g = day.models.gfs || {};
    var e = day.models.ecmwf || {};
    var rows = [];
    for (var i = 1; i <= 24; i++) {
      var t = [g.temp_c && g.temp_c[i], e.temp_c && e.temp_c[i]].filter(function (x) { return x != null; });
      var temp = t.length ? t.reduce(function (a, b) { return a + b; }, 0) / t.length : null;
      rows.push(
        '<tr class="border-b border-brand-border/30">' +
        '<td class="py-1 pr-3 text-brand-muted">' + HOURS[i - 1] + '</td>' +
        '<td class="text-right px-2 text-brand-accent font-semibold">' + fmt(day.blend_mw && day.blend_mw[i], 2) + '</td>' +
        '<td class="text-right px-2">' + fmt(g.mw && g.mw[i], 2) + '</td>' +
        '<td class="text-right px-2">' + fmt(e.mw && e.mw[i], 2) + '</td>' +
        '<td class="text-right px-2">' + fmt(g.ghi && g.ghi[i], 0) + ' / ' + fmt(e.ghi && e.ghi[i], 0) + '</td>' +
        '<td class="text-right px-2">' + fmt(g.cloud && g.cloud[i], 0) + ' / ' + fmt(e.cloud && e.cloud[i], 0) + '</td>' +
        '<td class="text-right pl-2">' + fmt(temp, 1) + '</td>' +
        '</tr>'
      );
    }
    tableBody.innerHTML = rows.join('');
  }

  if (btnCopy) {
    btnCopy.addEventListener('click', function () {
      var day = payload && payload.day;
      if (!day || !day.blend_mw) return;
      var text = slice24(day.blend_mw).map(function (v) { return Number(v).toFixed(2); }).join('\n');
      navigator.clipboard.writeText(text).then(function () {
        btnCopy.textContent = 'Copied';
        setTimeout(function () { btnCopy.textContent = 'Copy blend MW (24 values)'; }, 1500);
      });
    });
  }

  if (dateSel) {
    dateSel.addEventListener('change', function () { load(dateSel.value); });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', function () {
      setStatus('Starting download…', true);
      fetch('/api/nwp-forecast/refresh', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function () {
          setStatus('Downloading the latest GFS and ECMWF runs in the background (about 3–5 minutes)…', true);
          schedulePoll();
        })
        .catch(function () { setStatus('Could not start the download.', false); });
    });
  }

  function onShown() {
    if (!loaded) {
      loaded = true;
      load();
    }
  }

  document.addEventListener('areco:panel-shown', function (ev) {
    if (ev.detail && ev.detail.id === 'weather-models') onShown();
  });
  if (!panel.classList.contains('hidden')) onShown();
})();
