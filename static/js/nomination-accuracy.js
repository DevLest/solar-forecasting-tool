(function initNominationAccuracy() {
  function wirePair(btnId, inputId, nameId) {
    var btn = document.getElementById(btnId);
    var input = document.getElementById(inputId);
    var nameEl = document.getElementById(nameId);
    if (!btn || !input || !nameEl) return;
    btn.addEventListener('click', function() {
      input.click();
    });
    input.addEventListener('change', function() {
      var f = input.files && input.files[0];
      if (f) {
        nameEl.textContent = f.name;
        nameEl.setAttribute('title', f.name);
        nameEl.classList.remove('text-brand-muted');
        nameEl.classList.add('text-brand-text');
      } else {
        nameEl.textContent = 'No file selected';
        nameEl.removeAttribute('title');
        nameEl.classList.add('text-brand-muted');
        nameEl.classList.remove('text-brand-text');
      }
    });
  }

  wirePair('accuracy-btn-compliance', 'accuracy-file-compliance', 'accuracy-name-compliance');
  wirePair('accuracy-btn-mq', 'accuracy-file-mq', 'accuracy-name-mq');

  var runBtn = document.getElementById('accuracy-btn-run');
  var statusEl = document.getElementById('accuracy-run-status');
  var resultsEl = document.getElementById('accuracy-results');
  var analyticsEl = document.getElementById('accuracy-analytics');
  var placeholderEl = document.getElementById('accuracy-analysis-placeholder');
  var policyBanner = document.getElementById('accuracy-policy-banner');
  var policyHeadline = document.getElementById('accuracy-policy-headline');
  var policyNotes = document.getElementById('accuracy-policy-notes');
  var runSavedEl = document.getElementById('accuracy-run-saved');
  var savedPanel = document.getElementById('accuracy-saved-runs-panel');
  var savedBody = document.getElementById('accuracy-saved-runs-body');
  var loadRunsBtn = document.getElementById('accuracy-btn-load-runs');

  function pct(x) {
    if (x == null || typeof x !== 'number' || !isFinite(x)) return '—';
    return (x * 100).toFixed(2) + '%';
  }

  function num(x, d) {
    if (x == null || typeof x !== 'number' || !isFinite(x)) return '—';
    return x.toFixed(d != null ? d : 2);
  }

  function setRunEnabled() {
    var c = document.getElementById('accuracy-file-compliance');
    var m = document.getElementById('accuracy-file-mq');
    var ok = c && c.files && c.files[0] && m && m.files && m.files[0];
    if (runBtn) runBtn.disabled = !ok;
  }

  document.querySelectorAll('#accuracy-file-compliance, #accuracy-file-mq').forEach(function(el) {
    el.addEventListener('change', setRunEnabled);
  });
  setRunEnabled();

  function renderDateWarnings(messages) {
    var wrap = document.getElementById('accuracy-date-warnings-wrap');
    var ul = document.getElementById('accuracy-date-warnings');
    if (!wrap || !ul) return;
    ul.innerHTML = '';
    if (!messages || !messages.length) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    messages.forEach(function(msg) {
      var li = document.createElement('li');
      li.textContent = msg;
      ul.appendChild(li);
    });
  }

  function renderPolicy(policy, runId, overwritten) {
    if (!policyBanner || !policyHeadline || !policyNotes) return;
    policyBanner.classList.remove('hidden');
    var ok = policy.day_compliant;
    policyBanner.className =
      'rounded-xl border-2 p-4 sm:p-5' +
      (ok
        ? ' border-emerald-500/50 bg-emerald-950/20 text-emerald-100'
        : ' border-rose-500/50 bg-rose-950/25 text-rose-100');
    policyHeadline.textContent = ok
      ? 'Compliant for this day'
      : 'Non-compliant for this day';
    policyHeadline.className =
      'text-base sm:text-lg font-bold uppercase tracking-wide ' + (ok ? 'text-emerald-200' : 'text-rose-200');
    policyNotes.innerHTML = '';
    (policy.notes || []).forEach(function(note) {
      var li = document.createElement('li');
      li.textContent = note;
      policyNotes.appendChild(li);
    });
    if (runSavedEl) {
      var tail =
        runId != null
          ? 'Stored in database as run #' +
            runId +
            (overwritten ? ' (replaced existing row for that trade date).' : ' (new row).')
          : '';
      runSavedEl.textContent = tail;
    }
  }

  function renderAnalytics(a) {
    if (!analyticsEl) return;
    analyticsEl.classList.remove('hidden');
    var tbodyMw = document.getElementById('accuracy-tbody-mw');
    var tbodyMwh = document.getElementById('accuracy-tbody-mwh-day');
    var tbodyH = document.getElementById('accuracy-tbody-hourly');
    var fpeExtra = document.getElementById('accuracy-fpe-extra');
    if (!tbodyMw || !tbodyMwh || !tbodyH) return;

    var tsm = (a && a.trading_summary_mw) || {};
    function rowMw(label, key) {
      var o = tsm[key];
      if (!o) return '';
      var tr = document.createElement('tr');
      tr.className = 'border-b border-brand-border/40';
      tr.innerHTML =
        '<td class="py-2 pr-3 text-brand-text">' +
        label +
        '</td>' +
        '<td class="py-2 pr-3 text-right">' +
        num(o.sum, 3) +
        '</td>' +
        '<td class="py-2 pr-3 text-right">' +
        num(o.min, 3) +
        '</td>' +
        '<td class="py-2 pr-3 text-right">' +
        num(o.mean, 3) +
        '</td>' +
        '<td class="py-2 pr-3 text-right">' +
        num(o.max, 3) +
        '</td>';
      return tr;
    }
    tbodyMw.innerHTML = '';
    tbodyMw.appendChild(rowMw('Real-time dispatch (RTD)', 'real_time_dispatch_mw'));
    tbodyMw.appendChild(rowMw('Actual dispatch', 'actual_dispatch_mw'));
    tbodyMw.appendChild(rowMw('MQ delivered (DEL)', 'mq_delivered_mw'));

    var mwh = (a && a.trading_summary_mwh_day) || {};
    tbodyMwh.innerHTML = '';
    function addMwhRow(lab, v) {
      var tr = document.createElement('tr');
      tr.className = 'border-b border-brand-border/40';
      tr.innerHTML =
        '<td class="py-2 pr-4 text-brand-muted">' +
        lab +
        '</td><td class="py-2 text-right text-brand-text">' +
        num(v, 4) +
        '</td>';
      tbodyMwh.appendChild(tr);
    }
    addMwhRow('RTD MWh (day)', mwh.real_time_dispatch_mwh);
    addMwhRow('Actual dispatch MWh (day)', mwh.actual_dispatch_mwh);
    addMwhRow('MQ DEL MWh (day)', mwh.mq_delivered_mwh);

    tbodyH.innerHTML = '';
    (a.hourly_mwh || []).forEach(function(h) {
      var tr = document.createElement('tr');
      tr.className = 'border-b border-brand-border/30';
      tr.innerHTML =
        '<td class="py-1.5 px-2">' +
        h.label +
        '</td>' +
        '<td class="py-1.5 px-2 text-right">' +
        num(h.rtd_mwh, 4) +
        '</td>' +
        '<td class="py-1.5 px-2 text-right">' +
        num(h.actual_mwh, 4) +
        '</td>' +
        '<td class="py-1.5 px-2 text-right">' +
        num(h.mq_del_mwh, 4) +
        '</td>';
      tbodyH.appendChild(tr);
    });

    var fp = (a && a.fpe) || {};
    if (fpeExtra) {
      fpeExtra.textContent =
        fp.max != null || fp.mean != null
          ? 'FPE (fraction): max ' + num(fp.max, 4) + ', mean ' + num(fp.mean, 4)
          : '';
    }
  }

  function renderSummary(s, storageDayIso) {
    var elMape = document.getElementById('accuracy-out-mape');
    var elP95 = document.getElementById('accuracy-out-perc95');
    var elN = document.getElementById('accuracy-out-n');
    var elMq = document.getElementById('accuracy-out-maxmq');
    if (elMape) elMape.textContent = pct(s.mape);
    if (elP95) elP95.textContent = pct(s.perc95);
    if (elN) elN.textContent = s.n_intervals != null ? String(s.n_intervals) : '—';
    if (elMq) elMq.textContent = s.max_mq_mw != null ? num(s.max_mq_mw, 2) + ' MW' : '—';

    var elDay = document.getElementById('accuracy-out-day');
    var elRows = document.getElementById('accuracy-out-rows');
    var elSheet = document.getElementById('accuracy-out-sheet');
    if (elDay) elDay.textContent = s.compliance_day || '—';
    if (elRows) elRows.textContent = s.compliance_rows_in_window != null ? String(s.compliance_rows_in_window) : '—';
    if (elSheet) elSheet.textContent = s.mq_sheet || '—';
    var elSt = document.getElementById('accuracy-out-storage');
    if (elSt) elSt.textContent = storageDayIso || '—';
  }

  if (runBtn) {
    runBtn.addEventListener('click', function() {
      var c = document.getElementById('accuracy-file-compliance');
      var m = document.getElementById('accuracy-file-mq');
      if (!c || !c.files || !c.files[0] || !m || !m.files || !m.files[0]) return;

      var fd = new FormData();
      fd.append('compliance_csv', c.files[0]);
      fd.append('mq_xlsx', m.files[0]);

      if (statusEl) statusEl.textContent = 'Running…';
      runBtn.disabled = true;

      fetch('/api/nomination-accuracy', { method: 'POST', body: fd })
        .then(function(r) {
          return r.json().then(function(j) {
            return { httpOk: r.ok, j: j };
          });
        })
        .then(function(ref) {
          var j = ref.j;
          if (!j.ok) {
            if (statusEl) statusEl.textContent = j.error || 'Request failed';
            return;
          }
          if (statusEl) statusEl.textContent = 'Done';
          if (resultsEl) resultsEl.classList.remove('hidden');
          if (placeholderEl) placeholderEl.classList.add('hidden');

          renderSummary(j.summary || {}, j.storage_day || '');
          renderDateWarnings(j.date_warnings || []);
          renderPolicy(j.policy || {}, j.run_id, j.overwritten);
          renderAnalytics(j.analytics || {});
        })
        .catch(function() {
          if (statusEl) statusEl.textContent = 'Network error';
        })
        .finally(function() {
          setRunEnabled();
        });
    });
  }

  function formatStatsLine(bp, st) {
    if (!st) return '';
    var parts = [];
    if (bp && bp.start && bp.end) {
      parts.push('Period ' + bp.start + ' → ' + bp.end);
    }
    parts.push(
      'days in view: ' +
        (st.days_in_selection != null ? st.days_in_selection : '0') +
        '; compliant: ' +
        (st.compliant_days != null ? st.compliant_days : '0') +
        '; non-compliant: ' +
        (st.non_compliant_days != null ? st.non_compliant_days : '0')
    );
    if (st.mape_avg != null && isFinite(st.mape_avg)) {
      parts.push('avg MAPE ' + (st.mape_avg * 100).toFixed(2) + '%');
    }
    if (st.perc95_avg != null && isFinite(st.perc95_avg)) {
      parts.push('avg PERC95 ' + (st.perc95_avg * 100).toFixed(2) + '%');
    }
    return parts.join(' · ');
  }

  function fetchRuns(opts) {
    if (!savedBody) return;
    opts = opts || {};
    savedBody.textContent = 'Loading…';
    var statsEl = document.getElementById('accuracy-saved-stats');
    var qs = '?limit=200';
    if (opts.billingYear != null && opts.billingMonth != null) {
      qs =
        '?billing_period_year=' +
        encodeURIComponent(String(opts.billingYear)) +
        '&billing_period_month=' +
        encodeURIComponent(String(opts.billingMonth)) +
        '&limit=500';
    }
    fetch('/api/nomination-accuracy/runs' + qs)
      .then(function(r) {
        return r.json();
      })
      .then(function(j) {
        if (!j.ok) {
          savedBody.textContent = j.error || 'Failed';
          if (statsEl) {
            statsEl.classList.add('hidden');
          }
          return;
        }
        if (statsEl) {
          statsEl.textContent = formatStatsLine(j.billing_period, j.stats);
          statsEl.classList.remove('hidden');
        }
        var runs = j.runs || [];
        if (!runs.length) {
          savedBody.textContent = 'No rows in this selection.';
          return;
        }
        savedBody.textContent = '';
        runs.forEach(function(x) {
          var ok = x.day_compliant === 1 || x.day_compliant === true ? 'OK' : 'NC';
          var line =
            x.compliance_day +
            '  MAPE ' +
            (x.mape != null ? (x.mape * 100).toFixed(2) + '%' : '—') +
            '  P95 ' +
            (x.perc95 != null ? (x.perc95 * 100).toFixed(2) + '%' : '—') +
            '  ' +
            ok +
            '  #' +
            x.id;
          var div = document.createElement('div');
          div.className = 'py-1 border-b border-brand-border/30';
          div.textContent = line;
          savedBody.appendChild(div);
        });
      })
      .catch(function() {
        savedBody.textContent = 'Network error';
      });
  }

  if (loadRunsBtn && savedPanel) {
    loadRunsBtn.addEventListener('click', function() {
      savedPanel.classList.toggle('hidden');
      if (!savedPanel.classList.contains('hidden')) fetchRuns({});
    });
  }

  var billBtn = document.getElementById('accuracy-btn-load-billing');
  if (billBtn) {
    billBtn.addEventListener('click', function() {
      var yEl = document.getElementById('accuracy-bill-year');
      var mEl = document.getElementById('accuracy-bill-month');
      var y = yEl && yEl.value ? parseInt(yEl.value, 10) : NaN;
      var m = mEl && mEl.value ? parseInt(mEl.value, 10) : NaN;
      if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) {
        return;
      }
      savedPanel.classList.remove('hidden');
      fetchRuns({ billingYear: y, billingMonth: m });
    });
  }
})();
