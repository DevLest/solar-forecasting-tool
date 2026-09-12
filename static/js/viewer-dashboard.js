(function () {
  var originalFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;

  function isoToday() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function formatTodayLabel() {
    try {
      return new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return isoToday();
    }
  }

  function setViewerHeaderStatus(msg, isErr) {
    var el = document.getElementById('viewer-load-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'text-xs min-h-[1.25rem] mt-1 ' + (isErr ? 'text-rose-300/95' : 'text-brand-muted');
  }

  function updateTodayLabel() {
    var el = document.getElementById('viewer-today-label');
    if (el) el.textContent = "Showing today's nomination — " + formatTodayLabel();
  }

  function installFetchFilter() {
    if (!originalFetch) return;
    if (window.__ARECO_VIEWER_FETCH_PATCHED__) return;
    window.__ARECO_VIEWER_FETCH_PATCHED__ = true;

    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
        if (url && url.indexOf('/api/historical-exports') >= 0) {
          var today = isoToday();
          var hasQuery = url.indexOf('?') >= 0;
          var joiner = hasQuery ? '&' : '?';
          if (url.indexOf('start=') < 0) url += joiner + 'start=' + encodeURIComponent(today);
          joiner = (url.indexOf('?') >= 0) ? '&' : '?';
          if (url.indexOf('end=') < 0) url += joiner + 'end=' + encodeURIComponent(today);
          input = url;
        }
      } catch (e) {}
      return originalFetch(input, init);
    };
  }

  function bumpRefreshes() {
    var btnHist = document.getElementById('btn-refresh-history');
    if (btnHist) btnHist.click();
    var btnRep = document.getElementById('reporting-btn-refresh-charts');
    if (btnRep) btnRep.click();
    var btnRuns = document.getElementById('accuracy-btn-load-runs');
    if (btnRuns) btnRuns.click();
    if (typeof window.refreshViewerNominationToday === 'function') {
      window.refreshViewerNominationToday();
    }
  }

  installFetchFilter();

  function init() {
    updateTodayLabel();
    setViewerHeaderStatus('Loading today\'s nomination…', false);

    var btn = document.getElementById('viewer-refresh-today');
    if (btn) {
      btn.addEventListener('click', function () {
        updateTodayLabel();
        setViewerHeaderStatus('Refreshing today\'s nomination…', false);
        bumpRefreshes();
      });
    }

    window.setViewerHeaderStatus = setViewerHeaderStatus;
    window.bumpViewerRefreshes = bumpRefreshes;
  }

  window.addEventListener('DOMContentLoaded', init);
})();
