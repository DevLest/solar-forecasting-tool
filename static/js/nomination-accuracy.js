(function initNominationAccuracy() {
  var lastStorageDayIso = '';

  function wirePair(btnId, inputId, nameId) {
    var btn = document.getElementById(btnId);
    var input = document.getElementById(inputId);
    var nameEl = document.getElementById(nameId);
    if (!btn || !input || !nameEl) return;
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
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
      setRunEnabled();
      updateReadinessUi();
    });
  }

  wirePair('accuracy-btn-compliance', 'accuracy-file-compliance', 'accuracy-name-compliance');
  wirePair('accuracy-btn-mq', 'accuracy-file-mq', 'accuracy-name-mq');

  var runBtn = document.getElementById('accuracy-btn-run');
  var runSpinner = document.getElementById('accuracy-run-spinner');
  var runLabel = document.getElementById('accuracy-run-label');
  var statusEl = document.getElementById('accuracy-run-status');
  var resultsEl = document.getElementById('accuracy-results');
  var analyticsEl = document.getElementById('accuracy-analytics');
  var placeholderEl = document.getElementById('accuracy-analysis-placeholder');
  var policyBanner = document.getElementById('accuracy-policy-banner');
  var policyHeadline = document.getElementById('accuracy-policy-headline');
  var policyNotes = document.getElementById('accuracy-policy-notes');
  var runSavedEl = document.getElementById('accuracy-run-saved');
  var savedPanel = document.getElementById('accuracy-saved-runs-panel');
  var savedTbody = document.getElementById('accuracy-saved-runs-tbody');
  var savedEmpty = document.getElementById('accuracy-saved-empty');
  var loadRunsBtn = document.getElementById('accuracy-btn-load-runs');
  var outputRegion = document.getElementById('accuracy-output-region');
  var calendarPanel = document.getElementById('accuracy-calendar-panel');
  var calendarToggle = document.getElementById('accuracy-btn-calendar-rollups');
  var tabCompliance = document.getElementById('accuracy-tab-compliance');
  var tabTrading = document.getElementById('accuracy-tab-trading');
  var panelCompliance = document.getElementById('accuracy-tabpanel-compliance');
  var panelTrading = document.getElementById('accuracy-tabpanel-trading');
  var copyStorageBtn = document.getElementById('accuracy-btn-copy-storage');
  var billingStatsEl = document.getElementById('accuracy-billing-stats');
  var billPreviewEl = document.getElementById('accuracy-bill-preview');

  var lastFetchedRuns = [];
  /** Rows from last month-detail API response (calendar order); used for policy modal by row index. */
  var lastMonthDetailRows = [];
  var sortState = { key: 'day', dir: 'desc' };
  /** True after a successful Run analysis; used to restore the results panel when closing Saved / Monthly. */
  var hasAnalysisResults = false;

  /**
   * At most one of: analysis output, saved runs, monthly & annual.
   * @param {'analysis'|'saved'|'calendar'|null} which
   */
  function showNominationSection(which) {
    if (outputRegion) {
      var showOutput = which === 'analysis' && hasAnalysisResults;
      outputRegion.classList.toggle('hidden', !showOutput);
    }
    if (savedPanel) savedPanel.classList.toggle('hidden', which !== 'saved');
    if (calendarPanel) calendarPanel.classList.toggle('hidden', which !== 'calendar');
    if (loadRunsBtn) loadRunsBtn.setAttribute('aria-expanded', which === 'saved' ? 'true' : 'false');
    if (calendarToggle) calendarToggle.setAttribute('aria-expanded', which === 'calendar' ? 'true' : 'false');
  }

  function pct(x) {
    if (x == null || typeof x !== 'number' || !isFinite(x)) return '—';
    return (x * 100).toFixed(2) + '%';
  }

  function num(x, d) {
    if (x == null || typeof x !== 'number' || !isFinite(x)) return '—';
    return x.toFixed(d != null ? d : 2);
  }

  function isoFromDate(y, m0, day) {
    var mm = String(m0 + 1).padStart(2, '0');
    var dd = String(day).padStart(2, '0');
    return y + '-' + mm + '-' + dd;
  }

  /** Match server billing_period_for_end_month: month 1–12 is the month of the 25th (schedule label). */
  function billingPeriodRange(year, month) {
    if (!isFinite(year) || !isFinite(month) || month < 1 || month > 12) return null;
    var start =
      month === 1 ? isoFromDate(year - 1, 11, 26) : isoFromDate(year, month - 2, 26);
    var end = isoFromDate(year, month - 1, 25);
    return { start: start, end: end };
  }

  function updateBillPreview() {
    if (!billPreviewEl) return;
    var yEl = document.getElementById('accuracy-bill-year');
    var mEl = document.getElementById('accuracy-bill-month');
    var y = yEl && yEl.value !== '' ? parseInt(yEl.value, 10) : NaN;
    var m = mEl && mEl.value !== '' ? parseInt(mEl.value, 10) : NaN;
    var r = billingPeriodRange(y, m);
    if (!r) {
      billPreviewEl.textContent = 'Enter year & month to preview range';
      billPreviewEl.classList.add('text-brand-muted');
      billPreviewEl.classList.remove('text-brand-accent');
      return;
    }
    billPreviewEl.textContent = 'Preview: ' + r.start + ' → ' + r.end;
    billPreviewEl.classList.remove('text-brand-muted');
    billPreviewEl.classList.add('text-brand-accent');
  }

  function setRunEnabled() {
    var c = document.getElementById('accuracy-file-compliance');
    var m = document.getElementById('accuracy-file-mq');
    var ok = c && c.files && c.files[0] && m && m.files && m.files[0];
    if (runBtn) runBtn.disabled = !ok;
  }

  function updateReadinessUi() {
    var c = document.getElementById('accuracy-file-compliance');
    var m = document.getElementById('accuracy-file-mq');
    var cOk = !!(c && c.files && c.files[0]);
    var mOk = !!(m && m.files && m.files[0]);

    var rc = document.getElementById('accuracy-ready-compliance');
    var rm = document.getElementById('accuracy-ready-mq');
    if (rc) {
      rc.textContent = cOk ? '✓ File ready' : '○ Waiting for file';
      rc.classList.toggle('text-emerald-400', cOk);
      rc.classList.toggle('text-brand-muted', !cOk);
    }
    if (rm) {
      rm.textContent = mOk ? '✓ File ready' : '○ Waiting for file';
      rm.classList.toggle('text-emerald-400', mOk);
      rm.classList.toggle('text-brand-muted', !mOk);
    }

    var liC = document.getElementById('accuracy-placeholder-li-c');
    var liM = document.getElementById('accuracy-placeholder-li-m');
    if (liC) {
      var dotC = liC.querySelector('.accuracy-ph-dot');
      if (dotC) {
        dotC.classList.toggle('bg-emerald-500', cOk);
        dotC.classList.toggle('bg-brand-border', !cOk);
      }
      liC.classList.toggle('text-brand-text', cOk);
      liC.classList.toggle('text-brand-muted', !cOk);
    }
    if (liM) {
      var dotM = liM.querySelector('.accuracy-ph-dot');
      if (dotM) {
        dotM.classList.toggle('bg-emerald-500', mOk);
        dotM.classList.toggle('bg-brand-border', !mOk);
      }
      liM.classList.toggle('text-brand-text', mOk);
      liM.classList.toggle('text-brand-muted', !mOk);
    }
  }

  function assignFileToInput(input, file) {
    if (!input || !file) return;
    var accept = (input.getAttribute('accept') || '').toLowerCase();
    var name = (file.name || '').toLowerCase();
    var ok = true;
    if (accept.indexOf('.csv') >= 0 && name.indexOf('.csv') < 0) ok = false;
    if (accept.indexOf('.xlsx') >= 0 && name.indexOf('.xlsx') < 0 && name.indexOf('.xlsm') < 0) ok = false;
    if (!ok) {
      if (statusEl) statusEl.textContent = 'Wrong file type for that slot.';
      return;
    }
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Could not attach dropped file.';
    }
  }

  function wireDropzone(zoneId, inputId) {
    var zone = document.getElementById(zoneId);
    var input = document.getElementById(inputId);
    if (!zone || !input) return;
    var overlay = zone.querySelector('.accuracy-drop-overlay');

    zone.addEventListener('click', function(e) {
      if (e.target.closest('button')) return;
      input.click();
    });
    zone.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    ['dragenter', 'dragover'].forEach(function(ev) {
      zone.addEventListener(ev, function(e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('border-brand-accent/60', 'bg-brand-dark/50');
        if (overlay) overlay.classList.remove('opacity-0');
        if (overlay) overlay.classList.add('opacity-100');
      });
    });
    ['dragleave', 'drop'].forEach(function(ev) {
      zone.addEventListener(ev, function(e) {
        if (ev === 'dragleave' && e.relatedTarget && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('border-brand-accent/60', 'bg-brand-dark/50');
        if (overlay) overlay.classList.add('opacity-0');
        if (overlay) overlay.classList.remove('opacity-100');
      });
    });
    zone.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) assignFileToInput(input, f);
    });
  }

  wireDropzone('accuracy-drop-compliance', 'accuracy-file-compliance');
  wireDropzone('accuracy-drop-mq', 'accuracy-file-mq');
  setRunEnabled();
  updateReadinessUi();
  updateBillPreview();

  function selectResultTab(which) {
    var compliance = which === 'compliance';
    if (tabCompliance) {
      tabCompliance.setAttribute('aria-selected', compliance ? 'true' : 'false');
      tabCompliance.classList.toggle('bg-brand-accent/20', compliance);
      tabCompliance.classList.toggle('text-brand-accent', compliance);
      tabCompliance.classList.toggle('border-brand-accent/40', compliance);
      tabCompliance.classList.toggle('border-transparent', !compliance);
      tabCompliance.classList.toggle('shadow-sm', compliance);
      tabCompliance.classList.toggle('text-brand-muted', !compliance);
      tabCompliance.classList.toggle('hover:text-brand-text', !compliance);
      tabCompliance.classList.toggle('hover:bg-brand-border/25', !compliance);
    }
    if (tabTrading) {
      tabTrading.setAttribute('aria-selected', !compliance ? 'true' : 'false');
      tabTrading.classList.toggle('bg-brand-accent/20', !compliance);
      tabTrading.classList.toggle('text-brand-accent', !compliance);
      tabTrading.classList.toggle('border-brand-accent/40', !compliance);
      tabTrading.classList.toggle('border-transparent', compliance);
      tabTrading.classList.toggle('shadow-sm', !compliance);
      tabTrading.classList.toggle('text-brand-muted', compliance);
      tabTrading.classList.toggle('hover:text-brand-text', compliance);
      tabTrading.classList.toggle('hover:bg-brand-border/25', compliance);
    }
    if (panelCompliance) panelCompliance.classList.toggle('hidden', !compliance);
    if (panelTrading) panelTrading.classList.toggle('hidden', compliance);
  }

  if (tabCompliance) {
    tabCompliance.addEventListener('click', function() {
      selectResultTab('compliance');
    });
  }
  if (tabTrading) {
    tabTrading.addEventListener('click', function() {
      selectResultTab('trading');
    });
  }

  if (copyStorageBtn) {
    copyStorageBtn.addEventListener('click', function() {
      if (!lastStorageDayIso) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lastStorageDayIso).then(
          function() {
            if (statusEl) {
              statusEl.textContent = 'Copied ' + lastStorageDayIso;
              setTimeout(function() {
                if (statusEl && statusEl.textContent.indexOf('Copied') === 0) statusEl.textContent = '';
              }, 2000);
            }
          },
          function() {}
        );
      }
    });
  }

  var billYearEl = document.getElementById('accuracy-bill-year');
  var billMonthEl = document.getElementById('accuracy-bill-month');
  if (billYearEl) billYearEl.addEventListener('input', updateBillPreview);
  if (billMonthEl) billMonthEl.addEventListener('input', updateBillPreview);

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
      'rounded-xl border-2 p-4 sm:p-5 transition-all duration-200' +
      (ok
        ? ' border-emerald-500/50 bg-emerald-950/20 text-emerald-100'
        : ' border-rose-500/50 bg-rose-950/25 text-rose-100');
    policyHeadline.textContent = ok
      ? 'Compliant for this day'
      : 'Non-compliant for this day';
    policyHeadline.className =
      'text-base sm:text-lg font-bold uppercase tracking-wide ' + (ok ? 'text-emerald-200' : 'text-rose-200');
    var analysisEl = document.getElementById('accuracy-policy-analysis');
    if (analysisEl) {
      var summary = policy && policy.analysis_summary;
      if (summary) {
        analysisEl.textContent = summary;
        analysisEl.classList.remove('hidden');
      } else {
        analysisEl.textContent = '';
        analysisEl.classList.add('hidden');
      }
    }
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
    var tbodyMw = document.getElementById('accuracy-tbody-mw');
    var tbodyMwh = document.getElementById('accuracy-tbody-mwh-day');
    var tbodyH = document.getElementById('accuracy-tbody-hourly');
    var fpeExtra = document.getElementById('accuracy-fpe-extra');
    if (!tbodyMw || !tbodyMwh || !tbodyH) return;

    var tsm = (a && a.trading_summary_mw) || {};
    var rowIdx = 0;
    function rowMw(label, key) {
      var o = tsm[key];
      if (!o) return;
      var tr = document.createElement('tr');
      tr.className =
        (rowIdx % 2 === 0 ? 'bg-brand-dark/10 ' : 'bg-transparent ') +
        'border-b border-brand-border/40 hover:bg-brand-accent/5 transition-colors';
      rowIdx++;
      tr.innerHTML =
        '<td class="py-2.5 px-3 text-brand-text">' +
        label +
        '</td>' +
        '<td class="py-2.5 px-3 text-right">' +
        num(o.sum, 3) +
        '</td>' +
        '<td class="py-2.5 px-3 text-right">' +
        num(o.min, 3) +
        '</td>' +
        '<td class="py-2.5 px-3 text-right">' +
        num(o.mean, 3) +
        '</td>' +
        '<td class="py-2.5 px-3 text-right">' +
        num(o.max, 3) +
        '</td>';
      tbodyMw.appendChild(tr);
    }
    tbodyMw.innerHTML = '';
    rowMw('Real-time dispatch (RTD)', 'real_time_dispatch_mw');
    rowMw('Actual dispatch', 'actual_dispatch_mw');
    rowMw('MQ delivered (DEL)', 'mq_delivered_mw');

    var mwh = (a && a.trading_summary_mwh_day) || {};
    tbodyMwh.innerHTML = '';
    var mwhI = 0;
    function addMwhRow(lab, v) {
      var tr = document.createElement('tr');
      tr.className =
        (mwhI % 2 === 0 ? 'bg-brand-dark/10 ' : '') +
        'border-b border-brand-border/40 hover:bg-brand-accent/5 transition-colors';
      mwhI++;
      tr.innerHTML =
        '<td class="py-2.5 px-3 text-brand-muted">' +
        lab +
        '</td><td class="py-2.5 px-3 text-right text-brand-text">' +
        num(v, 4) +
        '</td>';
      tbodyMwh.appendChild(tr);
    }
    addMwhRow('RTD MWh (day)', mwh.real_time_dispatch_mwh);
    addMwhRow('Actual dispatch MWh (day)', mwh.actual_dispatch_mwh);
    addMwhRow('MQ DEL MWh (day)', mwh.mq_delivered_mwh);

    tbodyH.innerHTML = '';
    (a.hourly_mwh || []).forEach(function(h, hi) {
      var tr = document.createElement('tr');
      tr.className =
        (hi % 2 === 0 ? 'bg-brand-dark/10 ' : '') +
        'border-b border-brand-border/30 hover:bg-brand-accent/5 transition-colors';
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
    lastStorageDayIso = storageDayIso || '';
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
    if (copyStorageBtn) {
      copyStorageBtn.textContent = storageDayIso || '—';
      copyStorageBtn.disabled = !storageDayIso;
      copyStorageBtn.title = storageDayIso ? 'Click to copy ' + storageDayIso : '';
    }
  }

  function setRunningUi(on) {
    if (runSpinner) runSpinner.classList.toggle('hidden', !on);
    if (runLabel) runLabel.textContent = on ? 'Running…' : 'Run analysis';
    if (on) {
      if (runBtn) runBtn.disabled = true;
    }
  }

  if (runBtn) {
    runBtn.addEventListener('click', function() {
      var c = document.getElementById('accuracy-file-compliance');
      var m = document.getElementById('accuracy-file-mq');
      if (!c || !c.files || !c.files[0] || !m || !m.files || !m.files[0]) return;

      var fd = new FormData();
      fd.append('compliance_csv', c.files[0]);
      fd.append('mq_xlsx', m.files[0]);

      if (statusEl) statusEl.textContent = '';
      setRunningUi(true);

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
          hasAnalysisResults = true;
          showNominationSection('analysis');
          selectResultTab('compliance');
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
          setRunningUi(false);
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

  function renderBillingStatCards(bp, st) {
    if (!billingStatsEl) return;
    billingStatsEl.innerHTML = '';
    if (!st || st.days_in_selection == null) {
      billingStatsEl.classList.add('hidden');
      return;
    }
    billingStatsEl.classList.remove('hidden');
    function card(label, value, accent) {
      var d = document.createElement('div');
      d.className =
        'rounded-lg border px-3 py-2.5 transition-all duration-200 hover:border-brand-accent/35 ' +
        (accent
          ? 'border-brand-accent/30 bg-brand-accent/10'
          : 'border-brand-border/70 bg-brand-dark/35');
      d.innerHTML =
        '<p class="text-[9px] font-bold uppercase tracking-wider text-brand-muted">' +
        label +
        '</p><p class="mt-0.5 text-sm font-mono font-bold tabular-nums text-brand-text">' +
        value +
        '</p>';
      return d;
    }
    if (bp && bp.start && bp.end) {
      billingStatsEl.appendChild(
        card(
          'Period',
          bp.start + ' → ' + bp.end,
          true
        )
      );
    }
    billingStatsEl.appendChild(
      card('Days', String(st.days_in_selection != null ? st.days_in_selection : '0'), false)
    );
    billingStatsEl.appendChild(
      card(
        'Compliant',
        String(st.compliant_days != null ? st.compliant_days : '0'),
        false
      )
    );
    billingStatsEl.appendChild(
      card(
        'Non-compliant',
        String(st.non_compliant_days != null ? st.non_compliant_days : '0'),
        false
      )
    );
    if (st.mape_avg != null && isFinite(st.mape_avg)) {
      billingStatsEl.appendChild(card('Avg MAPE', (st.mape_avg * 100).toFixed(2) + '%', false));
    }
    if (st.perc95_avg != null && isFinite(st.perc95_avg)) {
      billingStatsEl.appendChild(card('Avg PERC95', (st.perc95_avg * 100).toFixed(2) + '%', false));
    }
  }

  function sortRunsInPlace(runs) {
    var key = sortState.key;
    var dir = sortState.dir === 'asc' ? 1 : -1;
    var copy = runs.slice();
    copy.sort(function(a, b) {
      var va, vb;
      if (key === 'day') {
        va = a.compliance_day || '';
        vb = b.compliance_day || '';
        return va < vb ? -dir : va > vb ? dir : 0;
      }
      if (key === 'mape') {
        va = a.mape != null ? Number(a.mape) : NaN;
        vb = b.mape != null ? Number(b.mape) : NaN;
      } else {
        va = a.perc95 != null ? Number(a.perc95) : NaN;
        vb = b.perc95 != null ? Number(b.perc95) : NaN;
      }
      if (!isFinite(va) && !isFinite(vb)) return 0;
      if (!isFinite(va)) return 1;
      if (!isFinite(vb)) return -1;
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return copy;
  }

  function updateSortIndicators() {
    document.querySelectorAll('.accuracy-sort-btn').forEach(function(btn) {
      var k = btn.getAttribute('data-sort');
      var ind = btn.querySelector('.accuracy-sort-ind');
      var active = k === sortState.key;
      if (ind) {
        ind.classList.toggle('opacity-0', !active);
        ind.textContent = sortState.dir === 'asc' ? '↑' : '↓';
      }
    });
  }

  function escAttr(s) {
    if (s == null || s === '') return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
  function escHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function openAccuracyPolicyModal(payload) {
    var dlg = document.getElementById('accuracy-run-policy-dialog');
    var subEl = document.getElementById('accuracy-run-policy-subtitle');
    var metricsEl = document.getElementById('accuracy-run-policy-metrics');
    var legacyEl = document.getElementById('accuracy-run-policy-legacy');
    var sumWrap = document.getElementById('accuracy-run-policy-summary-wrap');
    var sumEl = document.getElementById('accuracy-run-policy-summary');
    var failWrap = document.getElementById('accuracy-run-policy-fail-wrap');
    var failList = document.getElementById('accuracy-run-policy-fail-list');
    var notesWrap = document.getElementById('accuracy-run-policy-notes-wrap');
    var notesList = document.getElementById('accuracy-run-policy-notes-list');
    if (!dlg || !subEl || !metricsEl) return;

    var dateIso = payload.date || payload.compliance_day || '—';
    var mape = payload.mape;
    var perc95 = payload.perc95;
    var dc = payload.day_compliant;
    var ok = dc === 1 || dc === true;
    var mq = payload.mq_sheet;
    var pol = payload.policy && typeof payload.policy === 'object' ? payload.policy : null;
    var runId = payload.saved_run_id != null ? payload.saved_run_id : payload.id;

    subEl.textContent = dateIso;
    metricsEl.innerHTML = '';
    function addMetric(k, v) {
      var dt = document.createElement('dt');
      dt.className = 'text-brand-muted';
      dt.textContent = k;
      var dd = document.createElement('dd');
      dd.className = 'font-mono text-brand-text tabular-nums';
      dd.textContent = v;
      metricsEl.appendChild(dt);
      metricsEl.appendChild(dd);
    }
    addMetric('MAPE', mape != null && isFinite(Number(mape)) ? (Number(mape) * 100).toFixed(2) + '%' : '—');
    addMetric(
      'PERC95',
      perc95 != null && isFinite(Number(perc95)) ? (Number(perc95) * 100).toFixed(2) + '%' : '—'
    );
    addMetric('Policy', ok ? 'Compliant' : 'Non-compliant');
    if (mq) addMetric('MQ source', String(mq));
    if (runId != null) addMetric('Run ID', String(runId));

    if (legacyEl) {
      if (!pol) {
        legacyEl.classList.remove('hidden');
        legacyEl.textContent =
          'Detailed policy analysis was not stored for this run. Upload or run analysis again for this trade day to capture summary and reasons.';
      } else {
        legacyEl.classList.add('hidden');
        legacyEl.textContent = '';
      }
    }

    if (sumWrap && sumEl) {
      if (pol && pol.analysis_summary) {
        sumWrap.classList.remove('hidden');
        sumEl.textContent = pol.analysis_summary;
      } else {
        sumWrap.classList.add('hidden');
        sumEl.textContent = '';
      }
    }

    if (failWrap && failList) {
      var fr = pol && pol.failure_reasons;
      if (fr && fr.length && !ok) {
        failWrap.classList.remove('hidden');
        failList.innerHTML = '';
        fr.forEach(function(s) {
          var li = document.createElement('li');
          li.textContent = s;
          failList.appendChild(li);
        });
      } else {
        failWrap.classList.add('hidden');
        failList.innerHTML = '';
      }
    }

    if (notesWrap && notesList) {
      var notes = pol && pol.notes;
      if (notes && notes.length) {
        notesWrap.classList.remove('hidden');
        notesList.innerHTML = '';
        notes.forEach(function(s) {
          var li = document.createElement('li');
          li.textContent = s;
          notesList.appendChild(li);
        });
      } else {
        notesWrap.classList.add('hidden');
        notesList.innerHTML = '';
      }
    }

    if (dlg.showModal) dlg.showModal();
  }

  function renderSavedTable(runs) {
    if (!savedTbody) return;
    savedTbody.innerHTML = '';
    var sorted = sortRunsInPlace(runs);
    sorted.forEach(function(x, i) {
      var ok = x.day_compliant === 1 || x.day_compliant === true;
      var tr = document.createElement('tr');
      tr.className =
        (i % 2 === 0 ? 'bg-brand-dark/15 ' : '') +
        'border-b border-brand-border/30 hover:bg-brand-accent/10 transition-colors';
      var mapeStr = x.mape != null ? (x.mape * 100).toFixed(2) + '%' : '—';
      var p95Str = x.perc95 != null ? (x.perc95 * 100).toFixed(2) + '%' : '—';
      var badge =
        '<span class="inline-flex items-center justify-center min-w-[2.25rem] px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ' +
        (ok ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-500/40' : 'bg-rose-950/50 text-rose-200 border border-rose-500/40') +
        '">' +
        (ok ? 'OK' : 'NC') +
        '</span>';
      var pol = x.policy && typeof x.policy === 'object' ? x.policy : null;
      var reasonFull = pol && pol.analysis_summary ? String(pol.analysis_summary) : '';
      var reasonShort =
        reasonFull.length > 52 ? reasonFull.slice(0, 50) + '…' : reasonFull;
      var analysisTd =
        '<td class="py-2 px-3 text-left text-[10px] sm:text-xs text-brand-muted/95 max-w-[14rem] hidden lg:table-cell font-sans normal-case leading-snug" title="' +
        escAttr(reasonFull) +
        '">' +
        (reasonFull ? escHtml(reasonShort) : '—') +
        '</td>';
      tr.innerHTML =
        '<td class="py-2 px-3 text-xs sm:text-sm">' +
        '<button type="button" class="accuracy-saved-day-link text-left font-mono text-brand-accent hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/50 rounded px-0.5" data-run-id="' +
        (x.id != null ? String(x.id) : '') +
        '">' +
        escHtml(x.compliance_day || '—') +
        '</button></td>' +
        '<td class="py-2 px-3 text-right">' +
        mapeStr +
        '</td>' +
        '<td class="py-2 px-3 text-right hidden sm:table-cell">' +
        p95Str +
        '</td>' +
        '<td class="py-2 px-3 text-center">' +
        badge +
        '</td>' +
        analysisTd +
        '<td class="py-2 px-3 text-right text-brand-muted text-[11px]">#' +
        (x.id != null ? x.id : '—') +
        '</td>';
      savedTbody.appendChild(tr);
    });
    updateSortIndicators();
    if (savedEmpty) {
      var empty = !runs.length;
      savedEmpty.classList.toggle('hidden', !empty);
      savedTbody.parentElement.classList.toggle('hidden', empty);
    }
  }

  document.querySelectorAll('.accuracy-sort-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var k = btn.getAttribute('data-sort');
      if (!k) return;
      if (sortState.key === k) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = k;
        sortState.dir = k === 'day' ? 'desc' : 'asc';
      }
      renderSavedTable(lastFetchedRuns);
    });
  });

  function fetchRuns(opts) {
    if (!savedTbody) return;
    savedTbody.innerHTML = '';
    if (savedEmpty) {
      savedEmpty.classList.add('hidden');
      savedTbody.parentElement.classList.remove('hidden');
    }
    var row = document.createElement('tr');
    row.innerHTML =
      '<td colspan="6" class="py-6 px-3 text-center text-brand-muted text-sm">Loading…</td>';
    savedTbody.appendChild(row);

    var statsEl = document.getElementById('accuracy-saved-stats');
    opts = opts || {};
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
        savedTbody.innerHTML = '';
        if (!j.ok) {
          var err = document.createElement('tr');
          err.innerHTML =
            '<td colspan="6" class="py-6 px-3 text-center text-rose-300 text-sm">' +
            (j.error || 'Failed') +
            '</td>';
          savedTbody.appendChild(err);
          if (statsEl) {
            statsEl.classList.add('hidden');
          }
          renderBillingStatCards(null, null);
          lastFetchedRuns = [];
          if (savedEmpty) savedEmpty.classList.add('hidden');
          return;
        }
        if (statsEl) {
          statsEl.textContent = formatStatsLine(j.billing_period, j.stats);
          statsEl.classList.remove('hidden');
        }
        renderBillingStatCards(j.billing_period, j.stats);
        var runs = j.runs || [];
        lastFetchedRuns = runs;
        renderSavedTable(runs);
      })
      .catch(function() {
        savedTbody.innerHTML = '';
        var err = document.createElement('tr');
        err.innerHTML =
          '<td colspan="6" class="py-6 px-3 text-center text-rose-300 text-sm">Network error</td>';
        savedTbody.appendChild(err);
        lastFetchedRuns = [];
      });
  }

  if (loadRunsBtn && savedPanel) {
    loadRunsBtn.addEventListener('click', function() {
      if (!savedPanel.classList.contains('hidden')) {
        showNominationSection(hasAnalysisResults ? 'analysis' : null);
        return;
      }
      showNominationSection('saved');
      fetchRuns({});
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
        if (statusEl) statusEl.textContent = 'Enter billing year and month (1–12).';
        return;
      }
      showNominationSection('saved');
      fetchRuns({ billingYear: y, billingMonth: m });
    });
  }

  /* —— Calendar monthly / annual rollups (Chart.js) —— */
  var rollupYearInput = document.getElementById('accuracy-rollup-year');
  var rollupYearLabel = document.getElementById('accuracy-rollup-year-label');
  var rollupStatus = document.getElementById('accuracy-rollup-status');
  var rollupRefresh = document.getElementById('accuracy-btn-rollup-refresh');
  var rollupLoadYear = document.getElementById('accuracy-btn-load-rollup-year');
  var monthlyTbody = document.getElementById('accuracy-monthly-rollup-tbody');
  var annualTbody = document.getElementById('accuracy-annual-rollup-tbody');
  var yearTotalsStrip = document.getElementById('accuracy-year-totals-strip');
  var monthDetailPanel = document.getElementById('accuracy-month-detail');
  var monthDetailTitle = document.getElementById('accuracy-month-detail-title');
  var monthDetailSummary = document.getElementById('accuracy-month-detail-summary');
  var monthDetailMissing = document.getElementById('accuracy-month-detail-missing');
  var monthDetailTbody = document.getElementById('accuracy-month-detail-tbody');
  var monthDetailClose = document.getElementById('accuracy-month-detail-close');
  var lastRollupYearForCalendar = null;

  var policyDlg = document.getElementById('accuracy-run-policy-dialog');
  var policyDlgClose = document.getElementById('accuracy-run-policy-close');
  if (policyDlgClose && policyDlg) {
    policyDlgClose.addEventListener('click', function() {
      policyDlg.close();
    });
  }
  if (monthDetailTbody && !monthDetailTbody.dataset.policyModalDeleg) {
    monthDetailTbody.dataset.policyModalDeleg = '1';
    monthDetailTbody.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.accuracy-policy-day-link');
      if (!btn || !monthDetailTbody.contains(btn)) return;
      ev.preventDefault();
      var idx = parseInt(btn.getAttribute('data-row-index'), 10);
      if (!isFinite(idx)) return;
      var row = lastMonthDetailRows[idx];
      if (!row || !row.has_data) return;
      openAccuracyPolicyModal({
        date: row.date,
        mape: row.mape,
        perc95: row.perc95,
        day_compliant: row.day_compliant,
        mq_sheet: row.mq_sheet,
        policy: row.policy,
        saved_run_id: row.saved_run_id
      });
    });
  }
  if (savedTbody && !savedTbody.dataset.policyModalDeleg) {
    savedTbody.dataset.policyModalDeleg = '1';
    savedTbody.addEventListener('click', function(ev) {
      var btn = ev.target.closest('.accuracy-saved-day-link');
      if (!btn || !savedTbody.contains(btn)) return;
      ev.preventDefault();
      var rid = btn.getAttribute('data-run-id');
      var row = null;
      if (rid) {
        for (var j = 0; j < lastFetchedRuns.length; j++) {
          if (String(lastFetchedRuns[j].id) === String(rid)) {
            row = lastFetchedRuns[j];
            break;
          }
        }
      }
      if (!row) return;
      openAccuracyPolicyModal({
        compliance_day: row.compliance_day,
        mape: row.mape,
        perc95: row.perc95,
        day_compliant: row.day_compliant,
        mq_sheet: row.mq_sheet,
        policy: row.policy,
        id: row.id
      });
    });
  }

  var chartRefs = { monthlyErr: null, monthlyComp: null, annual: null };

  var CHART = {
    accent: 'rgba(16, 185, 129, 0.9)',
    accentSoft: 'rgba(16, 185, 129, 0.2)',
    rose: 'rgba(244, 63, 94, 0.85)',
    sky: 'rgba(56, 189, 248, 0.9)',
    skySoft: 'rgba(56, 189, 248, 0.15)',
    muted: '#94a3b8',
    grid: 'rgba(51, 65, 85, 0.55)',
    text: '#cbd5e1'
  };

  function destroyRollupCharts() {
    ['monthlyErr', 'monthlyComp', 'annual'].forEach(function(k) {
      if (chartRefs[k] && typeof chartRefs[k].destroy === 'function') {
        chartRefs[k].destroy();
      }
      chartRefs[k] = null;
    });
  }

  function compliancePct(st) {
    if (!st || st.days_in_selection == null || st.days_in_selection < 1) return null;
    var c = st.compliant_days != null ? st.compliant_days : 0;
    return (c / st.days_in_selection) * 100;
  }

  function fmtPctFromFraction(x) {
    if (x == null || typeof x !== 'number' || !isFinite(x)) return '—';
    return (x * 100).toFixed(2) + '%';
  }

  function fmtCompliancePct(p) {
    if (p == null || !isFinite(p)) return '—';
    return p.toFixed(1) + '%';
  }

  function renderYearTotalsStrip(yt) {
    if (!yearTotalsStrip) return;
    yearTotalsStrip.innerHTML = '';
    if (!yt || yt.days_in_selection == null) return;
    function mini(label, val) {
      var d = document.createElement('div');
      d.className =
        'rounded-lg border border-brand-border/60 bg-brand-dark/40 px-3 py-2';
      d.innerHTML =
        '<p class="text-[9px] font-bold uppercase tracking-wider text-brand-muted">' +
        label +
        '</p><p class="mt-0.5 font-mono font-bold text-brand-text">' +
        val +
        '</p>';
      return d;
    }
    yearTotalsStrip.appendChild(
      mini('Year total days', String(yt.days_in_selection != null ? yt.days_in_selection : '0'))
    );
    yearTotalsStrip.appendChild(
      mini(
        'Compliant / non-comp.',
        (yt.compliant_days != null ? yt.compliant_days : '0') +
          ' / ' +
          (yt.non_compliant_days != null ? yt.non_compliant_days : '0')
      )
    );
    yearTotalsStrip.appendChild(mini('Year avg MAPE', fmtPctFromFraction(yt.mape_avg)));
    yearTotalsStrip.appendChild(mini('Year avg PERC95', fmtPctFromFraction(yt.perc95_avg)));
  }

  function hideMonthDetail() {
    if (monthDetailPanel) monthDetailPanel.classList.add('hidden');
    if (monthlyTbody) {
      monthlyTbody.querySelectorAll('[data-accuracy-month-selected="1"]').forEach(function(el) {
        el.removeAttribute('data-accuracy-month-selected');
        el.classList.remove('ring-1', 'ring-brand-accent/50', 'bg-brand-accent/10');
      });
    }
  }

  function fmtMonthDetailUtc(iso) {
    if (!iso || typeof iso !== 'string') return '—';
    var t = Date.parse(iso);
    if (!isFinite(t)) return iso;
    var d = new Date(t);
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  function renderMonthDetailTable(rows) {
    if (!monthDetailTbody) return;
    lastMonthDetailRows = rows || [];
    monthDetailTbody.innerHTML = '';
    (rows || []).forEach(function(r, i) {
      var tr = document.createElement('tr');
      tr.className =
        (i % 2 === 0 ? 'bg-brand-dark/10 ' : '') +
        'border-b border-brand-border/30' +
        (!r.has_data ? ' opacity-75' : '');
      if (r.has_data) {
        var mapePct =
          r.mape != null && isFinite(Number(r.mape)) ? (Number(r.mape) * 100).toFixed(2) : '—';
        var p95Pct =
          r.perc95 != null && isFinite(Number(r.perc95))
            ? (Number(r.perc95) * 100).toFixed(2)
            : '—';
        var polBadge = r.day_compliant
          ? '<span class="text-emerald-300/90">OK</span>'
          : '<span class="text-rose-300/90">Fail</span>';
        var pMeta = r.policy && typeof r.policy === 'object' ? r.policy : null;
        var reasonFull = pMeta && pMeta.analysis_summary ? String(pMeta.analysis_summary) : '';
        var reasonShort =
          reasonFull.length > 52 ? reasonFull.slice(0, 50) + '…' : reasonFull;
        tr.innerHTML =
          '<td class="py-1.5 px-2 text-brand-text">' +
          '<button type="button" class="accuracy-policy-day-link text-left font-mono text-brand-accent hover:underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/50 rounded px-0.5" data-row-index="' +
          i +
          '">' +
          escHtml(r.date) +
          '</button></td>' +
          '<td class="py-1.5 px-2 text-right text-emerald-300/90">1</td>' +
          '<td class="py-1.5 px-2 text-right">' +
          mapePct +
          '</td>' +
          '<td class="py-1.5 px-2 text-right">' +
          p95Pct +
          '</td>' +
          '<td class="py-1.5 px-2 text-center">' +
          polBadge +
          '</td>' +
          '<td class="py-1.5 px-2 text-left text-[10px] max-w-[14rem] font-sans normal-case text-brand-muted leading-snug" title="' +
          escAttr(reasonFull) +
          '">' +
          (reasonFull ? escHtml(reasonShort) : '—') +
          '</td>' +
          '<td class="py-1.5 px-2 text-right">' +
          (r.n_intervals != null ? String(r.n_intervals) : '—') +
          '</td>' +
          '<td class="py-1.5 px-2 text-right">' +
          (r.compliance_rows_in_window != null ? String(r.compliance_rows_in_window) : '—') +
          '</td>' +
          '<td class="py-1.5 px-2 text-[10px] sm:text-[11px]">' +
          fmtMonthDetailUtc(r.created_at) +
          '</td>';
      } else {
        tr.innerHTML =
          '<td class="py-1.5 px-2 text-brand-muted">' +
          r.date +
          '</td>' +
          '<td class="py-1.5 px-2 text-right text-rose-300/80">0</td>' +
          '<td class="py-1.5 px-2 text-right">—</td>' +
          '<td class="py-1.5 px-2 text-right">—</td>' +
          '<td class="py-1.5 px-2 text-center">—</td>' +
          '<td class="py-1.5 px-2 text-left text-brand-muted">—</td>' +
          '<td class="py-1.5 px-2 text-right">—</td>' +
          '<td class="py-1.5 px-2 text-right">—</td>' +
          '<td class="py-1.5 px-2 text-brand-muted">—</td>';
      }
      monthDetailTbody.appendChild(tr);
    });
  }

  function openMonthDetail(year, month) {
    if (!monthDetailPanel) return;
    hideMonthDetail();
    if (monthlyTbody) {
      var prev = monthlyTbody.querySelector('button[data-accuracy-month="' + String(month) + '"]');
      if (prev) {
        prev.setAttribute('data-accuracy-month-selected', '1');
        prev.classList.add('ring-1', 'ring-brand-accent/50', 'bg-brand-accent/10');
      }
    }
    monthDetailPanel.classList.remove('hidden');
    if (monthDetailTitle) monthDetailTitle.textContent = 'Loading…';
    if (monthDetailSummary) monthDetailSummary.textContent = '';
    if (monthDetailMissing) {
      monthDetailMissing.classList.add('hidden');
      monthDetailMissing.textContent = '';
    }
    if (monthDetailTbody) monthDetailTbody.innerHTML = '';
    if (rollupStatus) rollupStatus.textContent = 'Loading day coverage…';
    fetch(
      '/api/nomination-accuracy/analytics/month-detail?year=' +
        encodeURIComponent(String(year)) +
        '&month=' +
        encodeURIComponent(String(month))
    )
      .then(function(r) {
        return r.json();
      })
      .then(function(j) {
        if (rollupStatus) rollupStatus.textContent = '';
        if (!j.ok) {
          if (monthDetailTitle) monthDetailTitle.textContent = 'Day coverage';
          if (monthDetailSummary) monthDetailSummary.textContent = j.error || 'Failed to load.';
          return;
        }
        if (monthDetailTitle) monthDetailTitle.textContent = j.label || 'Day coverage';
        if (monthDetailSummary) {
          monthDetailSummary.textContent =
            String(j.calendar_days != null ? j.calendar_days : '—') +
            ' calendar days · ' +
            String(j.days_with_saved != null ? j.days_with_saved : 0) +
            ' with saved run · ' +
            String(j.days_missing != null ? j.days_missing : 0) +
            ' missing';
        }
        if (monthDetailMissing) {
          var miss = j.missing_dates || [];
          if (miss.length) {
            monthDetailMissing.classList.remove('hidden');
            monthDetailMissing.innerHTML =
              '<span class="font-semibold text-brand-text">Missing dates:</span> ' +
              miss.join(', ');
          } else {
            monthDetailMissing.classList.add('hidden');
            monthDetailMissing.textContent = '';
          }
        }
        renderMonthDetailTable(j.rows || []);
      })
      .catch(function() {
        if (rollupStatus) rollupStatus.textContent = '';
        if (monthDetailTitle) monthDetailTitle.textContent = 'Day coverage';
        if (monthDetailSummary) monthDetailSummary.textContent = 'Network error.';
      });
  }

  if (monthlyTbody) {
    monthlyTbody.addEventListener('click', function(ev) {
      var btn = ev.target.closest('button[data-accuracy-month]');
      if (!btn || !monthlyTbody.contains(btn)) return;
      var m = parseInt(btn.getAttribute('data-accuracy-month'), 10);
      if (!isFinite(m) || m < 1 || m > 12) return;
      var y = lastRollupYearForCalendar;
      if (y == null || !isFinite(y)) return;
      openMonthDetail(y, m);
    });
  }
  if (monthDetailClose) {
    monthDetailClose.addEventListener('click', hideMonthDetail);
  }

  function renderMonthlyTable(months, year) {
    if (!monthlyTbody) return;
    monthlyTbody.innerHTML = '';
    hideMonthDetail();
    lastRollupYearForCalendar = year;
    if (rollupYearLabel) rollupYearLabel.textContent = String(year);
    (months || []).forEach(function(row, i) {
      var st = row.stats || {};
      var days = st.days_in_selection != null ? st.days_in_selection : 0;
      var cp = compliancePct(st);
      var tr = document.createElement('tr');
      tr.className =
        (i % 2 === 0 ? 'bg-brand-dark/10 ' : '') + 'border-b border-brand-border/30';
      var mo = row.month != null ? String(row.month) : '';
      tr.innerHTML =
        '<td class="py-2 px-3 text-brand-text">' +
        '<button type="button" class="text-left font-medium text-brand-accent hover:underline hover:text-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40 rounded px-0.5 -mx-0.5" data-accuracy-month="' +
        mo +
        '" title="Show per-day uploads and gaps for this month">' +
        row.label +
        '</button>' +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        String(days) +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        (st.compliant_days != null ? String(st.compliant_days) : '0') +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        (st.non_compliant_days != null ? String(st.non_compliant_days) : '0') +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        fmtPctFromFraction(st.mape_avg) +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        fmtPctFromFraction(st.perc95_avg) +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        fmtCompliancePct(cp) +
        '</td>';
      monthlyTbody.appendChild(tr);
    });
  }

  function renderAnnualTable(years) {
    if (!annualTbody) return;
    annualTbody.innerHTML = '';
    if (!years || !years.length) {
      var empty = document.createElement('tr');
      empty.innerHTML =
        '<td colspan="7" class="py-6 px-3 text-center text-brand-muted text-sm">No saved runs in the database yet.</td>';
      annualTbody.appendChild(empty);
      return;
    }
    (years || []).forEach(function(row, i) {
      var st = row.stats || {};
      var cp = compliancePct(st);
      var tr = document.createElement('tr');
      tr.className =
        (i % 2 === 0 ? 'bg-brand-dark/10 ' : '') + 'border-b border-brand-border/30';
      tr.innerHTML =
        '<td class="py-2 px-3 font-semibold text-brand-text">' +
        row.label +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        (st.days_in_selection != null ? String(st.days_in_selection) : '0') +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        (st.compliant_days != null ? String(st.compliant_days) : '0') +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        (st.non_compliant_days != null ? String(st.non_compliant_days) : '0') +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        fmtPctFromFraction(st.mape_avg) +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        fmtPctFromFraction(st.perc95_avg) +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        fmtCompliancePct(cp) +
        '</td>';
      annualTbody.appendChild(tr);
    });
  }

  function baseChartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: CHART.muted, boxWidth: 12, font: { size: 11 } }
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: CHART.text,
          bodyColor: CHART.text,
          borderColor: CHART.grid,
          borderWidth: 1
        }
      },
      scales: {
        x: {
          ticks: { color: CHART.muted, maxRotation: 45, minRotation: 0 },
          grid: { color: CHART.grid }
        },
        y: {
          ticks: { color: CHART.muted },
          grid: { color: CHART.grid }
        }
      }
    };
  }

  function drawMonthlyCharts(months) {
    if (typeof Chart === 'undefined') return;
    var labels = (months || []).map(function(m) {
      return m.label.slice(0, 3);
    });
    var mapePct = (months || []).map(function(m) {
      var v = m.stats && m.stats.mape_avg;
      return v != null && isFinite(v) ? v * 100 : null;
    });
    var p95Pct = (months || []).map(function(m) {
      var v = m.stats && m.stats.perc95_avg;
      return v != null && isFinite(v) ? v * 100 : null;
    });
    var compPct = (months || []).map(function(m) {
      return compliancePct(m.stats || {});
    });

    var elErr = document.getElementById('accuracy-chart-monthly-errors');
    var elComp = document.getElementById('accuracy-chart-monthly-compliance');
    if (elErr) {
      if (chartRefs.monthlyErr) chartRefs.monthlyErr.destroy();
      chartRefs.monthlyErr = new Chart(elErr, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Avg MAPE %',
              data: mapePct,
              borderColor: CHART.accent,
              backgroundColor: CHART.accentSoft,
              tension: 0.25,
              fill: false,
              spanGaps: false
            },
            {
              label: 'Avg PERC95 %',
              data: p95Pct,
              borderColor: CHART.sky,
              backgroundColor: CHART.skySoft,
              tension: 0.25,
              fill: false,
              spanGaps: false
            }
          ]
        },
        options: (function() {
          var o = baseChartOptions();
          o.scales.y.title = { display: true, text: '%', color: CHART.muted };
          o.plugins.legend.position = 'top';
          return o;
        })()
      });
    }
    if (elComp) {
      if (chartRefs.monthlyComp) chartRefs.monthlyComp.destroy();
      chartRefs.monthlyComp = new Chart(elComp, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Compliance %',
              data: compPct,
              backgroundColor: compPct.map(function(v) {
                if (v == null || !isFinite(v)) return 'rgba(51, 65, 85, 0.4)';
                return v >= 80 ? CHART.accentSoft : v >= 50 ? 'rgba(250, 204, 21, 0.25)' : 'rgba(244, 63, 94, 0.25)';
              }),
              borderColor: compPct.map(function(v) {
                if (v == null || !isFinite(v)) return CHART.grid;
                return v >= 80 ? CHART.accent : v >= 50 ? 'rgba(250, 204, 21, 0.8)' : CHART.rose;
              }),
              borderWidth: 1
            }
          ]
        },
        options: (function() {
          var o = baseChartOptions();
          o.scales.y.min = 0;
          o.scales.y.max = 100;
          o.scales.y.title = { display: true, text: '% days compliant', color: CHART.muted };
          return o;
        })()
      });
    }
  }

  function drawAnnualChart(years) {
    if (typeof Chart === 'undefined') return;
    var el = document.getElementById('accuracy-chart-annual-overview');
    if (!el) return;
    if (chartRefs.annual) chartRefs.annual.destroy();
    chartRefs.annual = null;
    if (!years || !years.length) return;
    var labels = (years || []).map(function(y) {
      return y.label;
    });
    var dayCounts = (years || []).map(function(y) {
      var st = y.stats || {};
      return st.days_in_selection != null ? st.days_in_selection : 0;
    });
    var mapePct = (years || []).map(function(y) {
      var v = y.stats && y.stats.mape_avg;
      return v != null && isFinite(v) ? v * 100 : null;
    });

    chartRefs.annual = new Chart(el, {
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Days with data',
            data: dayCounts,
            backgroundColor: 'rgba(51, 65, 85, 0.65)',
            borderColor: CHART.grid,
            borderWidth: 1,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: 'Avg MAPE %',
            data: mapePct,
            borderColor: CHART.accent,
            backgroundColor: CHART.accentSoft,
            tension: 0.2,
            yAxisID: 'y1',
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: CHART.muted, boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleColor: CHART.text,
            bodyColor: CHART.text,
            borderColor: CHART.grid,
            borderWidth: 1
          }
        },
        scales: {
          x: {
            ticks: { color: CHART.muted },
            grid: { color: CHART.grid }
          },
          y: {
            position: 'left',
            title: { display: true, text: 'Days', color: CHART.muted },
            ticks: { color: CHART.muted },
            grid: { color: CHART.grid }
          },
          y1: {
            position: 'right',
            title: { display: true, text: 'MAPE %', color: CHART.muted },
            ticks: { color: CHART.muted },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  }

  function fetchRollupData(year) {
    if (rollupStatus) rollupStatus.textContent = 'Loading rollups…';
    return Promise.all([
      fetch('/api/nomination-accuracy/analytics/annual').then(function(r) {
        return r.json();
      }),
      fetch(
        '/api/nomination-accuracy/analytics/monthly?year=' + encodeURIComponent(String(year))
      ).then(function(r) {
        return r.json();
      })
    ])
      .then(function(pair) {
        var annualJ = pair[0];
        var monthlyJ = pair[1];
        if (!annualJ.ok) throw new Error(annualJ.error || 'Annual rollup failed');
        if (!monthlyJ.ok) throw new Error(monthlyJ.error || 'Monthly rollup failed');
        renderAnnualTable(annualJ.years || []);
        drawAnnualChart(annualJ.years || []);
        renderMonthlyTable(monthlyJ.months || [], monthlyJ.year);
        renderYearTotalsStrip(monthlyJ.year_totals || {});
        drawMonthlyCharts(monthlyJ.months || []);
        if (rollupStatus) rollupStatus.textContent = '';
        requestAnimationFrame(function() {
          ['monthlyErr', 'monthlyComp', 'annual'].forEach(function(k) {
            if (chartRefs[k] && typeof chartRefs[k].resize === 'function') chartRefs[k].resize();
          });
        });
      })
      .catch(function(e) {
        if (rollupStatus) rollupStatus.textContent = e.message || 'Failed to load rollups';
        destroyRollupCharts();
      });
  }

  function defaultRollupYear() {
    return new Date().getFullYear();
  }

  if (rollupYearInput && !rollupYearInput.value) {
    rollupYearInput.value = String(defaultRollupYear());
  }

  if (calendarToggle && calendarPanel) {
    calendarToggle.addEventListener('click', function() {
      if (!calendarPanel.classList.contains('hidden')) {
        showNominationSection(hasAnalysisResults ? 'analysis' : null);
        return;
      }
      showNominationSection('calendar');
      var y =
        rollupYearInput && rollupYearInput.value
          ? parseInt(rollupYearInput.value, 10)
          : defaultRollupYear();
      if (!isFinite(y)) y = defaultRollupYear();
      fetchRollupData(y);
    });
  }

  if (rollupLoadYear && rollupYearInput) {
    rollupLoadYear.addEventListener('click', function() {
      var y = parseInt(rollupYearInput.value, 10);
      if (!isFinite(y) || y < 2000 || y > 2100) {
        if (rollupStatus) rollupStatus.textContent = 'Enter a calendar year between 2000 and 2100.';
        return;
      }
      fetchRollupData(y);
    });
  }

  if (rollupRefresh && rollupYearInput) {
    rollupRefresh.addEventListener('click', function() {
      var y = parseInt(rollupYearInput.value, 10);
      if (!isFinite(y)) y = defaultRollupYear();
      fetchRollupData(y);
    });
  }

  (function initBackfillDialog() {
    var MONTHS = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december'
    ];
    function guessTradeDateFromFilename(name) {
      if (!name) return null;
      var base = name.replace(/^.*[\\/]/, '');
      var m = base.match(
        /_(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i
      );
      if (m) {
        var d = parseInt(m[1], 10);
        var y = parseInt(m[3], 10);
        var mi = MONTHS.indexOf(m[2].toLowerCase()) + 1;
        if (mi >= 1 && d >= 1 && d <= 31 && y >= 2000)
          return y + '-' + String(mi).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      }
      var ymd = base.match(/(20\d{2})(\d{2})(\d{2})/);
      if (ymd) return ymd[1] + '-' + ymd[2] + '-' + ymd[3];
      var iso = base.match(/(20\d{2})-(\d{2})-(\d{2})/);
      if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
      return null;
    }

    var dlg = document.getElementById('accuracy-backfill-dialog');
    var openBtn = document.getElementById('accuracy-btn-backfill');
    var cancel = document.getElementById('accuracy-backfill-cancel');
    var submit = document.getElementById('accuracy-backfill-submit');
    var filesInput = document.getElementById('accuracy-backfill-files');
    var fallbackDate = document.getElementById('accuracy-backfill-fallback-date');
    var previewEl = document.getElementById('accuracy-backfill-preview');
    var statusMsg = document.getElementById('accuracy-backfill-status-msg');
    var spinEl = document.getElementById('accuracy-backfill-spinner');
    var submitLabel = document.getElementById('accuracy-backfill-submit-label');
    var detailsEl = document.getElementById('accuracy-backfill-details');
    var logEl = document.getElementById('accuracy-backfill-log');
    var progressWrap = document.getElementById('accuracy-backfill-progress-wrap');
    var progressList = document.getElementById('accuracy-backfill-progress-list');
    var progressSummary = document.getElementById('accuracy-backfill-progress-summary');
    var backfillUploading = false;

    var JOB_SPINNER =
      '<svg class="animate-spin h-3.5 w-3.5 text-sky-400 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';

    function escLocal(s) {
      if (s == null || s === '') return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function setJobRowState(i, state, detail) {
      if (!progressList) return;
      var li = progressList.querySelector('[data-job-index="' + i + '"]');
      if (!li) return;
      var icon = li.querySelector('.accuracy-backfill-job-icon');
      var det = li.querySelector('.accuracy-backfill-job-detail');
      if (det) det.textContent = detail || '';
      if (!icon) return;
      icon.className =
        'accuracy-backfill-job-icon shrink-0 w-5 flex justify-center pt-0.5 tabular-nums';
      icon.innerHTML = '';
      icon.textContent = '';
      if (state === 'queued') {
        icon.textContent = '○';
        icon.classList.add('text-brand-muted');
      } else if (state === 'running') {
        icon.innerHTML = JOB_SPINNER;
      } else if (state === 'done') {
        icon.textContent = '✓';
        icon.classList.add('text-emerald-400');
      } else if (state === 'error') {
        icon.textContent = '✕';
        icon.classList.add('text-rose-400');
      } else if (state === 'skipped') {
        icon.textContent = '—';
        icon.classList.add('text-brand-muted/80');
      }
    }

    function buildJobList(fileArr) {
      if (!progressList) return;
      progressList.innerHTML = '';
      fileArr.forEach(function(f, i) {
        var li = document.createElement('li');
        li.setAttribute('data-job-index', String(i));
        li.className = 'flex gap-3 px-3 py-2.5 items-start';
        li.innerHTML =
          '<span class="accuracy-backfill-job-icon shrink-0 w-5 flex justify-center pt-0.5 text-brand-muted" aria-hidden="true">○</span>' +
          '<div class="min-w-0 flex-1">' +
          '<p class="font-mono text-[11px] text-brand-text break-all">' +
          escLocal(f.name) +
          '</p>' +
          '<p class="accuracy-backfill-job-detail mt-0.5 text-[10px] text-brand-muted leading-snug"></p>' +
          '</div>';
        progressList.appendChild(li);
        setJobRowState(i, 'queued', 'Queued');
      });
    }

    function setBackfillBusy(on) {
      backfillUploading = !!on;
      if (dlg) dlg.setAttribute('aria-busy', on ? 'true' : 'false');
      if (spinEl) spinEl.classList.toggle('hidden', !on);
      if (submit) submit.disabled = on;
      if (cancel) cancel.disabled = on;
      if (filesInput) filesInput.disabled = on;
      if (fallbackDate) fallbackDate.disabled = on;
      if (detailsEl) {
        detailsEl.classList.toggle('pointer-events-none', on);
        detailsEl.classList.toggle('opacity-60', on);
        if (on) detailsEl.setAttribute('inert', '');
        else detailsEl.removeAttribute('inert');
      }
      if (previewEl) previewEl.classList.toggle('opacity-50', on);
      if (previewEl) previewEl.classList.toggle('pointer-events-none', on);
      if (submitLabel) submitLabel.textContent = on ? 'Working…' : 'Upload & save';
    }

    if (!dlg || !openBtn) return;
    dlg.addEventListener('cancel', function(e) {
      if (backfillUploading) e.preventDefault();
    });
    openBtn.addEventListener('click', function() {
      if (progressWrap) progressWrap.classList.add('hidden');
      if (progressList) progressList.innerHTML = '';
      if (progressSummary) progressSummary.textContent = '';
      if (dlg.showModal) dlg.showModal();
    });
    if (cancel) {
      cancel.addEventListener('click', function() {
        if (backfillUploading) return;
        dlg.close();
      });
    }
    if (filesInput && previewEl) {
      filesInput.addEventListener('change', function() {
        previewEl.innerHTML = '';
        var files = filesInput.files;
        if (!files || !files.length) {
          previewEl.classList.add('hidden');
          return;
        }
        previewEl.classList.remove('hidden');
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          var iso = guessTradeDateFromFilename(f.name);
          var li = document.createElement('li');
          li.className = 'leading-snug flex flex-wrap gap-x-1 gap-y-0.5 items-baseline';
          var nameSpan = document.createElement('span');
          nameSpan.className = 'text-brand-muted break-all';
          nameSpan.textContent = f.name || '';
          var arrow = document.createTextNode(' → ');
          var dateSpan = document.createElement('span');
          dateSpan.className = iso ? 'text-brand-accent shrink-0' : 'text-amber-300/90 shrink-0';
          dateSpan.textContent = iso ? iso : 'no date in name — use fallback or rename';
          li.appendChild(nameSpan);
          li.appendChild(arrow);
          li.appendChild(dateSpan);
          previewEl.appendChild(li);
        }
      });
    }
    if (submit) {
      submit.addEventListener('click', function() {
        if (backfillUploading) return;
        if (!filesInput || !filesInput.files || !filesInput.files.length) {
          if (statusMsg) statusMsg.textContent = 'Choose at least one workbook.';
          return;
        }
        var fileArr = Array.prototype.slice.call(filesInput.files);
        var total = fileArr.length;
        if (logEl) {
          logEl.classList.add('hidden');
          logEl.textContent = '';
        }
        if (progressWrap) progressWrap.classList.remove('hidden');
        if (progressSummary) progressSummary.textContent = '0 / ' + total + ' complete · ' + total + ' queued';
        buildJobList(fileArr);
        if (statusMsg) statusMsg.textContent = 'Starting ' + total + ' job' + (total === 1 ? '' : 's') + '…';
        setBackfillBusy(true);

        var lines = [];
        var okCount = 0;
        var failCount = 0;

        function appendSuccessLine(row) {
          var s = row.summary || {};
          var polObj = row.policy || {};
          var polLine = polObj.day_compliant
            ? 'policy OK'
            : polObj.analysis_summary || 'policy FAIL';
          var mp =
            s.mape_pct != null && isFinite(Number(s.mape_pct))
              ? Number(s.mape_pct).toFixed(2) + '% MAPE'
              : '';
          var p95 =
            s.perc95_pct != null && isFinite(Number(s.perc95_pct))
              ? Number(s.perc95_pct).toFixed(2) + '% P95'
              : '';
          var metrics = [mp, p95].filter(Boolean).join(', ');
          lines.push(
            row.filename +
              ' → ' +
              row.storage_day +
              ' · ' +
              (metrics || '—') +
              ' · ' +
              polLine +
              ' · run #' +
              row.run_id +
              (row.overwritten ? ' (replaced)' : '')
          );
        }

        function processAtIndex(i) {
          if (i >= total) {
            if (statusMsg) {
              statusMsg.textContent =
                'Done: ' + okCount + ' saved, ' + failCount + ' failed.';
            }
            if (progressSummary) {
              progressSummary.textContent =
                okCount + ' saved · ' + failCount + ' failed · ' + total + ' total';
            }
            if (logEl) {
              logEl.textContent = lines.join('\n');
              logEl.classList.toggle('hidden', !lines.length);
            }
            setBackfillBusy(false);
            return;
          }

          var rem = total - i - 1;
          if (progressSummary) {
            progressSummary.textContent =
              'Running ' + (i + 1) + ' of ' + total + (rem > 0 ? ' · ' + rem + ' left' : '');
          }
          if (statusMsg) {
            statusMsg.textContent =
              'Running job ' +
              (i + 1) +
              ' of ' +
              total +
              (rem > 0 ? ' (' + rem + ' remaining after this)' : '') +
              '…';
          }

          setJobRowState(i, 'running', 'Uploading and processing on server…');

          var fd = new FormData();
          fd.append('files', fileArr[i]);
          if (fallbackDate && fallbackDate.value) fd.append('trade_date', fallbackDate.value);

          fetch('/api/nomination-accuracy/rtd-dispatch-backfill', { method: 'POST', body: fd })
            .then(function(r) {
              return r.json().then(function(j) {
                return { httpOk: r.ok, j: j };
              });
            })
            .then(function(ref) {
              var j = ref.j;
              if (!ref.httpOk || !j.ok) {
                var errTop = (j && j.error) || 'Request failed';
                setJobRowState(i, 'error', errTop);
                failCount++;
                lines.push(fileArr[i].name + ' — ' + errTop);
                for (var k = i + 1; k < total; k++) {
                  setJobRowState(k, 'skipped', 'Skipped (batch error)');
                }
                if (statusMsg) statusMsg.textContent = errTop;
                if (progressSummary) {
                  progressSummary.textContent =
                    okCount +
                    ' saved · ' +
                    failCount +
                    ' failed · ' +
                    (total - i - 1) +
                    ' skipped';
                }
                if (logEl) {
                  logEl.textContent = lines.join('\n');
                  logEl.classList.remove('hidden');
                }
                setBackfillBusy(false);
                return;
              }
              var results = j.results || [];
              var row = results[0];
              if (!row) {
                setJobRowState(i, 'error', 'No result from server');
                failCount++;
                lines.push(fileArr[i].name + ' — No result');
                processAtIndex(i + 1);
                return;
              }
              if (!row.ok) {
                var err = row.error || 'Error';
                setJobRowState(i, 'error', err);
                failCount++;
                lines.push(row.filename + ' — ' + err);
                processAtIndex(i + 1);
                return;
              }
              okCount++;
              var polObj = row.policy || {};
              var detail =
                row.storage_day +
                ' · ' +
                (polObj.day_compliant ? 'Compliant' : 'Non-compliant');
              setJobRowState(i, 'done', detail);
              appendSuccessLine(row);
              processAtIndex(i + 1);
            })
            .catch(function() {
              setJobRowState(i, 'error', 'Network error');
              failCount++;
              lines.push(fileArr[i].name + ' — Network error');
              for (var k2 = i + 1; k2 < total; k2++) {
                setJobRowState(k2, 'skipped', 'Not run (network error)');
              }
              if (statusMsg) statusMsg.textContent = 'Network error on job ' + (i + 1) + ' of ' + total;
              if (progressSummary) {
                progressSummary.textContent =
                  okCount + ' saved · ' + failCount + ' failed · ' + (total - i - 1) + ' not run';
              }
              if (logEl) {
                logEl.textContent = lines.join('\n');
                logEl.classList.remove('hidden');
              }
              setBackfillBusy(false);
            });
        }

        processAtIndex(0);
      });
    }
  })();
})();
