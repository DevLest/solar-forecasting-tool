(function () {
  var API_BASE = '';
  var LIVE_STREAM_STORAGE_KEY = 'areco_live_stream_url';
  var DEFAULT_LIVE_STREAM_URL = 'https://vdo.ninja/?view=2vNAR9X';

  var historicalExportsList = [];
  var selectedRecord = null;
  var nominationChart = null;

  function clampMw(v) {
    v = Number(v);
    if (isNaN(v)) v = 0;
    if (v < 0) v = 0;
    if (v > 50) v = 50;
    return v;
  }

  function formatDateForDisplay(isoOrStr) {
    if (!isoOrStr) return '';
    try {
      var d = new Date(isoOrStr);
      if (isNaN(d.getTime())) return String(isoOrStr);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
    } catch (e) {
      return String(isoOrStr);
    }
  }

  function formatHistoryExportedAt(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
      return String(iso);
    }
  }

  function intervalToDeliveryHour(intervalStr) {
    var s = (intervalStr || '').trim();
    if (s === '24:00') return 24;
    var parts = s.split(':');
    if (!parts.length) return NaN;
    var hh = parseInt(parts[0], 10);
    var mm = parts.length > 1 ? parseInt(parts[1], 10) : 0;
    if (isNaN(hh) || isNaN(mm)) return NaN;
    if (hh < 0 || hh > 23) return NaN;
    if (mm === 0) return hh; // e.g. 06:00 belongs to delivery hour 6
    return hh + 1;
  }

  function intervalsToHourlyCurves(intervals) {
    var byHourDa = {};
    var byHourRtd = {};
    for (var h = 1; h <= 24; h++) {
      byHourDa[h] = [];
      byHourRtd[h] = [];
    }
    (intervals || []).forEach(function (row) {
      var dh = intervalToDeliveryHour(row.interval);
      if (!dh || isNaN(dh) || dh < 1 || dh > 24) return;
      byHourDa[dh].push(clampMw(row.dayAhead));
      byHourRtd[dh].push(clampMw(row.rtd));
    });
    var da = [];
    var rtd = [];
    for (var h2 = 1; h2 <= 24; h2++) {
      var v1 = byHourDa[h2];
      var v2 = byHourRtd[h2];
      var avgDa = v1.length ? (v1.reduce(function (a, b) { return a + b; }, 0) / v1.length) : 0;
      var avgRtd = v2.length ? (v2.reduce(function (a, b) { return a + b; }, 0) / v2.length) : 0;
      da.push(Math.round(avgDa * 1000) / 1000);
      rtd.push(Math.round(avgRtd * 1000) / 1000);
    }
    return { da: da, rtd: rtd };
  }

  function ensureNominationChart() {
    if (nominationChart) return nominationChart;
    var canvas = document.getElementById('nominationChart');
    if (!canvas || !window.Chart) return null;
    var labels = [];
    for (var i = 1; i <= 24; i++) labels.push(String(i));
    nominationChart = new window.Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Day Ahead', data: labels.map(function () { return 0; }), borderColor: 'rgba(16,185,129,0.85)', backgroundColor: 'rgba(16,185,129,0.12)', tension: 0.25, pointRadius: 0, borderWidth: 2, fill: true },
          { label: 'RTD', data: labels.map(function () { return 0; }), borderColor: 'rgba(167,139,250,0.9)', backgroundColor: 'rgba(167,139,250,0.0)', tension: 0.25, pointRadius: 0, borderWidth: 2, fill: false }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, labels: { color: '#cbd5e1', boxWidth: 10 } } },
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.12)' } },
          y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.12)' }, title: { display: true, text: 'MW', color: '#94a3b8' } }
        }
      }
    });
    return nominationChart;
  }

  function updateNominationChartFromRecord(rec) {
    var c = ensureNominationChart();
    if (!c) return;
    var curves = intervalsToHourlyCurves((rec && rec.intervals) ? rec.intervals : []);
    c.data.datasets[0].data = curves.da;
    c.data.datasets[1].data = curves.rtd;
    c.update();
  }

  var VRE_MINUTE_COLUMNS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

  function getDayAheadLookupForDisplay(intervals) {
    var map = {};
    (intervals || []).forEach(function (row) {
      var s = (row.interval || '').trim();
      if (!s) return;
      if (s === '24:00') {
        map['24,0'] = clampMw(row.dayAhead);
        return;
      }
      var parts = s.split(':');
      var hour = parseInt(parts[0], 10);
      var minute = parts.length > 1 ? parseInt(parts[1], 10) : 0;
      if (isNaN(hour) || isNaN(minute)) return;
      map[String(hour) + ',' + String(minute)] = clampMw(row.dayAhead);
    });
    return map;
  }

  function getVreHourlyAverages(intervals) {
    var byHour = {};
    for (var h = 1; h <= 24; h++) byHour[h] = [];
    (intervals || []).forEach(function (row) {
      var s = (row.interval || '').trim();
      if (!s) return;
      var parts = s.split(':');
      var hour = parseInt(parts[0], 10);
      var minute = parts.length > 1 ? parseInt(parts[1], 10) : 0;
      if (isNaN(hour) || isNaN(minute)) return;
      if (hour === 24 && minute === 0) {
        byHour[24].push(clampMw(row.dayAhead));
        return;
      }
      if (hour >= 0 && hour <= 23) {
        var deliveryHour = hour === 0 ? 24 : hour;
        byHour[deliveryHour].push(clampMw(row.dayAhead));
      }
    });
    var out = [];
    for (var h2 = 1; h2 <= 24; h2++) {
      var vals = byHour[h2];
      var avg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) : 0;
      out.push({ deliveryHour: h2, vreNom: Math.round(avg * 10) / 10 });
    }
    return out;
  }

  function deliveryHourToClockHour(dh) {
    return dh === 24 ? 0 : dh;
  }

  function renderVreTableFromRecord(rec) {
    var tbody = document.getElementById('vre-tbody');
    if (!tbody) return;
    var intervals = (rec && rec.intervals) ? rec.intervals : [];
    var vreRows = getVreHourlyAverages(intervals);
    var daMap = getDayAheadLookupForDisplay(intervals);
    tbody.innerHTML = vreRows.map(function (r) {
      var clockH = deliveryHourToClockHour(r.deliveryHour);
      var hourCell = '<td class="vre-col-hour">' + String(r.deliveryHour) + '</td>';
      var vreCell = '<td class="vre-col-vre">' + String(r.vreNom) + '</td>';
      var dataCells = VRE_MINUTE_COLUMNS.map(function (min) {
        var keyMin = (min === 60) ? 0 : min;
        var keyHour = (min === 60) ? (clockH + 1) : clockH;
        if (keyHour === 24) keyHour = 24;
        if (keyHour === 25) keyHour = 24;
        var val = daMap[String(keyHour) + ',' + String(keyMin)];
        if (val == null && min === 60 && r.deliveryHour === 24) val = daMap['24,0'];
        val = val != null ? val : 0;
        return '<td class="vre-col-mw">' + String(Math.round(Number(val) * 1000) / 1000) + '</td>';
      }).join('');
      return '<tr>' + hourCell + vreCell + dataCells + '</tr>';
    }).join('');
  }

  function computeHistoryAnalytics(records) {
    if (!records || records.length === 0) {
      return { totalExports: 0, uniqueDates: 0, dateRange: '—', avgRtdPct: '—', modeCounts: {}, avgPeakMw: '—', totalDayAheadMwh: '—', last7d: 0, last30d: 0, avgIntervals: '—' };
    }
    var now = Date.now();
    var sevenDays = 7 * 24 * 60 * 60 * 1000;
    var thirtyDays = 30 * 24 * 60 * 60 * 1000;
    var dates = {};
    var rtdSum = 0, rtdCount = 0;
    var modeCounts = { low: 0, mid: 0, high: 0, custom: 0 };
    var peakSum = 0, peakCount = 0;
    var mwhSum = 0, mwhCount = 0;
    var intervalCountSum = 0;
    var last7d = 0, last30d = 0;
    var firstDate = null, lastDate = null;
    records.forEach(function (r) {
      var iso = r.forecastRefDateIso || r.forecastRefDate;
      if (iso) { dates[iso] = true; if (!firstDate || iso < firstDate) firstDate = iso; if (!lastDate || iso > lastDate) lastDate = iso; }
      if (r.rtdPercent != null && !isNaN(Number(r.rtdPercent))) { rtdSum += Number(r.rtdPercent); rtdCount++; }
      var mode = (r.rtdForecastMode || 'custom').toLowerCase();
      if (modeCounts[mode] !== undefined) modeCounts[mode]++; else modeCounts.custom++;
      var intervals = r.intervals || [];
      intervalCountSum += intervals.length;
      var peak = 0, totalMwh = 0;
      intervals.forEach(function (iv) {
        var mw = Number(iv.dayAhead);
        if (!isNaN(mw)) { if (mw > peak) peak = mw; totalMwh += mw * (5 / 60); }
      });
      if (intervals.length) { peakSum += peak; peakCount++; mwhSum += totalMwh; mwhCount++; }
      var exportedAt = r.exportedAt || r.savedAt || '';
      if (exportedAt) {
        var t = new Date(exportedAt).getTime();
        if (now - t <= sevenDays) last7d++;
        if (now - t <= thirtyDays) last30d++;
      }
    });
    var avgRtd = rtdCount ? Math.round(rtdSum / rtdCount) : '—';
    var avgPeak = peakCount ? (Math.round((peakSum / peakCount) * 100) / 100) : '—';
    var avgMwh = mwhCount ? (Math.round((mwhSum / mwhCount) * 10) / 10) : '—';
    var dateRange = (firstDate && lastDate) ? (formatDateForDisplay(firstDate) + ' → ' + formatDateForDisplay(lastDate)) : '—';
    var avgIntervals = records.length ? Math.round(intervalCountSum / records.length) : '—';
    return { totalExports: records.length, uniqueDates: Object.keys(dates).length, dateRange: dateRange, avgRtdPct: avgRtd, modeCounts: modeCounts, avgPeakMw: avgPeak, totalDayAheadMwh: avgMwh, last7d: last7d, last30d: last30d, avgIntervals: avgIntervals };
  }

  function renderAnalyticsCards(analytics) {
    var container = document.getElementById('analytics-cards');
    if (!container) return;
    if (analytics.totalExports === 0) {
      container.innerHTML = '<p class="col-span-full text-sm text-brand-muted">No data in this range.</p>';
      return;
    }
    var cards = [
      { label: 'Exports', value: analytics.totalExports },
      { label: 'Unique dates', value: analytics.uniqueDates },
      { label: 'Date range', value: analytics.dateRange, span: ' lg:col-span-2' },
      { label: 'Avg RTD %', value: analytics.avgRtdPct },
      { label: 'Avg peak MW', value: analytics.avgPeakMw },
      { label: 'Avg day-ahead (MWh)', value: analytics.totalDayAheadMwh },
      { label: 'Last 7d exports', value: analytics.last7d },
      { label: 'Last 30d exports', value: analytics.last30d },
      { label: 'Avg intervals', value: analytics.avgIntervals }
    ];
    container.innerHTML = cards.map(function (c) {
      var val = c.value !== undefined && c.value !== null && c.value !== '' ? String(c.value) : '—';
      var spanClass = c.span || '';
      return '<div class="bg-brand-dark/60 border border-brand-border rounded-lg px-4 py-3' + spanClass + '"><div class="text-[10px] text-brand-muted uppercase tracking-wider">' + c.label + '</div><div class="text-lg font-bold text-brand-accent mt-1 break-words">' + val + '</div></div>';
    }).join('');
  }

  function renderHistoryTable(records) {
    var tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    if (!records || records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-brand-muted text-center">No history in this range.</td></tr>';
      return;
    }
    var list = records.slice();
    list.sort(function (a, b) {
      var ta = a.exportedAt || a.savedAt || '';
      var tb = b.exportedAt || b.savedAt || '';
      return tb.localeCompare(ta);
    });
    tbody.innerHTML = list.map(function (rec, idx) {
      var exportedAt = formatHistoryExportedAt(rec.exportedAt || rec.savedAt);
      var forecastRef = formatDateForDisplay(rec.forecastRefDateIso || rec.forecastRefDate) || '—';
      var intervalCount = (rec.intervals && rec.intervals.length) ? rec.intervals.length : 0;
      var revNum = rec.intervalRev != null ? (parseInt(rec.intervalRev, 10) || 0) : '—';
      var rtdPct = rec.rtdPercent != null ? rec.rtdPercent : '—';
      var mode = (rec.rtdForecastMode || '—').toString();
      return '<tr class="history-row cursor-pointer hover:bg-brand-border/20 transition-colors" data-history-index="' + idx + '"><td class="px-4 py-2 text-brand-muted">' + exportedAt + '</td><td class="px-4 py-2 text-brand-accent">' + forecastRef + '</td><td class="px-4 py-2">' + intervalCount + '</td><td class="px-4 py-2">' + revNum + '</td><td class="px-4 py-2">' + rtdPct + '</td><td class="px-4 py-2">' + mode + '</td></tr>';
    }).join('');
    list.forEach(function (rec, i) {
      var row = tbody.querySelector('[data-history-index="' + i + '"]');
      if (row) row._historyRecord = list[i];
    });
  }

  function applySelectedRecord(rec) {
    selectedRecord = rec;
    updateNominationChartFromRecord(rec);
    renderVreTableFromRecord(rec);
  }

  function loadHistory() {
    var tbody = document.getElementById('history-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-brand-muted text-center">Loading…</td></tr>';
    fetch(API_BASE + '/api/historical-exports').then(function (r) {
      if (!r.ok) return r.text().then(function () { return []; });
      return r.json();
    }).then(function (data) {
      historicalExportsList = Array.isArray(data) ? data : [];
      renderHistoryTable(historicalExportsList);
      renderAnalyticsCards(computeHistoryAnalytics(historicalExportsList));
      if (historicalExportsList.length) applySelectedRecord(historicalExportsList[0]);
    }).catch(function () {
      historicalExportsList = [];
      renderHistoryTable([]);
      renderAnalyticsCards(computeHistoryAnalytics([]));
    });
  }

  function initHistoryClicks() {
    var historyTbody = document.getElementById('history-tbody');
    if (historyTbody) {
      historyTbody.addEventListener('click', function (e) {
        var row = e.target.closest('.history-row');
        if (!row || !row._historyRecord) return;
        document.querySelectorAll('#history-tbody .history-row').forEach(function (r) {
          r.classList.remove('bg-brand-accent/20', 'ring-1', 'ring-brand-accent');
        });
        row.classList.add('bg-brand-accent/20', 'ring-1', 'ring-brand-accent');
        applySelectedRecord(row._historyRecord);
      });
    }
    var btnRefreshHistory = document.getElementById('btn-refresh-history');
    if (btnRefreshHistory) btnRefreshHistory.addEventListener('click', loadHistory);
  }

  function initLiveStream() {
    var statusEl = document.getElementById('live-stream-status');
    function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }
    function readStoredUrl() {
      try { return localStorage.getItem(LIVE_STREAM_STORAGE_KEY) || ''; } catch (e) { return ''; }
    }
    function persistUrl(u) {
      try { localStorage.setItem(LIVE_STREAM_STORAGE_KEY, u); return true; } catch (e) { return false; }
    }
    function setIframeSrc(u) {
      var iframe = document.getElementById('vdo-ninja-stream');
      if (!iframe) return;
      iframe.src = u || '';
    }
    var input = document.getElementById('live-stream-url');
    var saved = readStoredUrl();
    var url = (saved && saved.trim()) ? saved.trim() : DEFAULT_LIVE_STREAM_URL;
    if (input) input.value = url;
    setIframeSrc(url);
    function applyUrl() {
      var u = input ? (input.value || '').trim() : '';
      if (!u) { setStatus(''); return; }
      persistUrl(u);
      setIframeSrc(u);
      setStatus('');
    }
    var applyBtn = document.getElementById('live-stream-apply');
    if (applyBtn) applyBtn.addEventListener('click', applyUrl);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') applyUrl(); });
  }

  function init() {
    initLiveStream();
    initHistoryClicks();
    loadHistory();
  }

  window.addEventListener('DOMContentLoaded', init);
})();

