(function () {
  var RANGE_KEY = 'areco_viewer_date_range_v1';
  var originalFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;

  function iso(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function defaultRange() {
    var now = new Date();
    var start = new Date(now);
    start.setDate(start.getDate() - 30);
    var end = new Date(now);
    end.setDate(end.getDate() + 1);
    return { start: iso(start), end: iso(end) };
  }

  function loadRange() {
    try {
      var raw = localStorage.getItem(RANGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.start && parsed.end) return parsed;
      }
    } catch (e) {}
    return defaultRange();
  }

  function saveRange(r) {
    try { localStorage.setItem(RANGE_KEY, JSON.stringify(r)); } catch (e) {}
  }

  function setStatus(msg, isErr) {
    var el = document.getElementById('viewer-date-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'text-[11px] min-h-[1.25rem] self-center ' + (isErr ? 'text-rose-300/95' : 'text-brand-muted');
  }

  function currentRangeFromInputs() {
    var s = document.getElementById('viewer-date-start');
    var e = document.getElementById('viewer-date-end');
    return { start: (s && s.value) ? s.value : '', end: (e && e.value) ? e.value : '' };
  }

  function applyRangeToInputs(r) {
    var s = document.getElementById('viewer-date-start');
    var e = document.getElementById('viewer-date-end');
    if (s) s.value = r.start || '';
    if (e) e.value = r.end || '';
  }

  function isIsoDate(x) {
    return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  }

  function bumpRefreshes() {
    // Nomination history refresh
    var btnHist = document.getElementById('btn-refresh-history');
    if (btnHist) btnHist.click();

    // Reporting charts: if a day is selected, refresh it; otherwise just leave it.
    var btnRep = document.getElementById('reporting-btn-refresh-charts');
    if (btnRep) btnRep.click();

    // Accuracy: nudge the user workflows by opening saved runs + calendar (no assumptions about their chosen views).
    var btnRuns = document.getElementById('accuracy-btn-load-runs');
    if (btnRuns) btnRuns.click();
  }

  function installFetchFilter() {
    if (!originalFetch) return;
    if (window.__ARECO_VIEWER_FETCH_PATCHED__) return;
    window.__ARECO_VIEWER_FETCH_PATCHED__ = true;

    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
        if (url && url.indexOf('/api/historical-exports') >= 0) {
          var hasQuery = url.indexOf('?') >= 0;
          var range = loadRange();
          if (range && isIsoDate(range.start) && isIsoDate(range.end)) {
            var joiner = hasQuery ? '&' : '?';
            if (url.indexOf('start=') < 0) url += joiner + 'start=' + encodeURIComponent(range.start);
            joiner = (url.indexOf('?') >= 0) ? '&' : '?';
            if (url.indexOf('end=') < 0) url += joiner + 'end=' + encodeURIComponent(range.end);
            input = url;
          }
        }
      } catch (e) {}
      return originalFetch(input, init);
    };
  }

  // Patch fetch ASAP (before other deferred scripts run).
  installFetchFilter();

  function init() {
    var r = loadRange();
    applyRangeToInputs(r);
    setStatus('', false);

    var btn = document.getElementById('viewer-date-apply');
    if (btn) {
      btn.addEventListener('click', function () {
        var cur = currentRangeFromInputs();
        if (!isIsoDate(cur.start) || !isIsoDate(cur.end)) {
          setStatus('Choose valid Start/End dates (YYYY-MM-DD).', true);
          return;
        }
        if (cur.end < cur.start) {
          setStatus('End date must be on/after Start date.', true);
          return;
        }
        saveRange(cur);
        setStatus('', false);
        bumpRefreshes();
      });
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();

