(function initNominationAccuracy() {
  var authAcc = typeof window !== 'undefined' && window.__ARECO_AUTH__;
  var accuracyReadOnly = !!(authAcc && authAcc.role === 'spectator');
  var savedRunsColspan = accuracyReadOnly ? 6 : 7;

  var lastStorageDayIso = '';
  /** ISO dates (YYYY-MM-DD) that already have a saved nomination-accuracy run */
  var uploadedTradeDates = new Set();

  /** @returns {Promise<boolean>} true if the server list was applied to ``uploadedTradeDates`` */
  function refreshUploadedTradeDates() {
    return fetch('/api/nomination-accuracy/uploaded-dates')
      .then(function(r) {
        if (!r.ok) return Promise.reject(new Error('uploaded-dates HTTP ' + r.status));
        return r.json();
      })
      .then(function(j) {
        if (j && j.ok && Array.isArray(j.dates)) {
          uploadedTradeDates = new Set(j.dates);
          return true;
        }
        return Promise.reject(new Error('uploaded-dates bad payload'));
      })
      .catch(function() {
        return false;
      });
  }

  function isTradeDateUnavailable(iso) {
    return !!(iso && uploadedTradeDates.has(iso));
  }

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
      updateReadinessUi();
    });
  }

  wirePair('accuracy-btn-mq', 'accuracy-file-mq', 'accuracy-name-mq');

  var mqDialog = document.getElementById('accuracy-mq-dialog');
  var openMqBtn = document.getElementById('accuracy-btn-open-mq-modal');
  var mqModalSpinner = document.getElementById('accuracy-mq-modal-spinner');
  var mqModalStatus = document.getElementById('accuracy-mq-modal-status');
  var mqDialogCancel = document.getElementById('accuracy-mq-dialog-cancel');
  var accuracyMqAnalyzing = false;
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
  /** Last options passed to {@link fetchRuns} (for refresh after delete). */
  var lastRunsFetchOpts = {};
  /** Rows from last month-detail API response (billing-period day order); used for policy modal by row index. */
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

  function updateReadinessUi() {
    var m = document.getElementById('accuracy-file-mq');
    var mOk = !!(m && m.files && m.files[0]);

    var rm = document.getElementById('accuracy-ready-mq');
    if (rm) {
      rm.textContent = mOk ? '✓ File ready' : '○ Waiting for file';
      rm.classList.toggle('text-emerald-400', mOk);
      rm.classList.toggle('text-brand-muted', !mOk);
    }

    var liM = document.getElementById('accuracy-placeholder-li-m');
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
      if (mqDialog && mqDialog.open && mqModalStatus) {
        mqModalStatus.textContent = 'Wrong file type — use .xlsx or .xlsm.';
      } else if (statusEl) {
        statusEl.textContent = 'Wrong file type for that slot.';
      }
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

  wireDropzone('accuracy-drop-mq', 'accuracy-file-mq');
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

  function setMqModalBusy(on) {
    accuracyMqAnalyzing = !!on;
    if (mqModalSpinner) mqModalSpinner.classList.toggle('hidden', !on);
    if (openMqBtn) openMqBtn.disabled = on;
    if (mqDialogCancel) mqDialogCancel.disabled = on;
    if (mqDialog) mqDialog.setAttribute('aria-busy', on ? 'true' : 'false');
    var mqIn = document.getElementById('accuracy-file-mq');
    var mqBtn = document.getElementById('accuracy-btn-mq');
    var tdEl = document.getElementById('accuracy-trade-date');
    if (mqIn) mqIn.disabled = on;
    if (mqBtn) mqBtn.disabled = on;
    if (tdEl) tdEl.disabled = on;
    var dz = document.getElementById('accuracy-drop-mq');
    if (dz) {
      dz.style.pointerEvents = on ? 'none' : '';
      dz.setAttribute('aria-disabled', on ? 'true' : 'false');
    }
  }

  var tradeDateEl = document.getElementById('accuracy-trade-date');

  function resetMqFileAfterSuccess() {
    var m = document.getElementById('accuracy-file-mq');
    if (m) {
      try {
        m.value = '';
      } catch (e) {}
      m.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function runNominationAccuracyAnalysis() {
    var m = document.getElementById('accuracy-file-mq');
    if (!m || !m.files || !m.files[0] || accuracyMqAnalyzing) return;

    var fd = new FormData();
    fd.append('mq_xlsx', m.files[0]);
    var td = tradeDateEl && tradeDateEl.value ? tradeDateEl.value.trim() : '';
    if (td) fd.append('trade_date', td);

    if (mqModalStatus) mqModalStatus.textContent = '';
    if (statusEl) statusEl.textContent = '';
    setMqModalBusy(true);
    if (mqModalStatus) mqModalStatus.textContent = 'Running analysis…';

    fetch('/api/nomination-accuracy', { method: 'POST', body: fd })
      .then(function(r) {
        return r.json().then(function(j) {
          return { httpOk: r.ok, j: j };
        });
      })
      .then(function(ref) {
        var j = ref.j;
        if (!ref.httpOk || !j.ok) {
          if (mqModalStatus) mqModalStatus.textContent = j.error || 'Request failed';
          if (statusEl) statusEl.textContent = '';
          return;
        }
        if (mqDialog && mqDialog.close) mqDialog.close();
        if (mqModalStatus) mqModalStatus.textContent = '';
        if (statusEl) statusEl.textContent = 'Analysis complete.';
        setTimeout(function() {
          if (statusEl && statusEl.textContent === 'Analysis complete.') statusEl.textContent = '';
        }, 4000);
        resetMqFileAfterSuccess();
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
        if (mqModalStatus) mqModalStatus.textContent = 'Network error';
      })
      .finally(function() {
        setMqModalBusy(false);
      });
  }

  if (mqDialog && openMqBtn && openMqBtn.addEventListener) {
    openMqBtn.addEventListener('click', function() {
      if (accuracyMqAnalyzing) return;
      if (mqModalStatus) mqModalStatus.textContent = '';
      if (mqDialog.showModal) mqDialog.showModal();
    });
  }
  if (mqDialog) {
    mqDialog.addEventListener('cancel', function(e) {
      if (accuracyMqAnalyzing) e.preventDefault();
    });
  }
  if (mqDialogCancel && mqDialog) {
    mqDialogCancel.addEventListener('click', function() {
      if (accuracyMqAnalyzing) return;
      mqDialog.close();
    });
  }

  var mqFileForAutoRun = document.getElementById('accuracy-file-mq');
  if (mqFileForAutoRun) {
    mqFileForAutoRun.addEventListener('change', function() {
      if (!mqFileForAutoRun.files || !mqFileForAutoRun.files[0]) return;
      if (!mqDialog || !mqDialog.open) return;
      if (accuracyMqAnalyzing) return;
      runNominationAccuracyAnalysis();
    });
  }
  if (tradeDateEl) {
    tradeDateEl.addEventListener('change', function() {
      if (!mqFileForAutoRun || !mqFileForAutoRun.files || !mqFileForAutoRun.files[0]) return;
      if (!mqDialog || !mqDialog.open) return;
      if (accuracyMqAnalyzing) return;
      runNominationAccuracyAnalysis();
    });
  }

  function formatStatsLine(bp, st) {
    if (!st) return '';
    var parts = [];
    if (bp && bp.start && bp.end) {
      parts.push('Period ' + bp.start + ' → ' + bp.end);
    }
    parts.push(
      'trade days in period: ' +
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
        '</td>' +
        (accuracyReadOnly
          ? ''
          : '<td class="py-2 px-2 text-center">' +
            (x.id != null
              ? '<button type="button" class="accuracy-saved-delete-btn rounded border border-rose-500/35 bg-rose-950/30 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-200 hover:bg-rose-900/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/50" data-run-id="' +
                String(x.id) +
                '" data-compliance-day="' +
                escAttr(x.compliance_day || '') +
                '" title="Remove this saved run for this trade day">Del</button>'
              : '—') +
            '</td>');
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
      '<td colspan="' +
      savedRunsColspan +
      '" class="py-6 px-3 text-center text-brand-muted text-sm">Loading…</td>';
    savedTbody.appendChild(row);

    var statsEl = document.getElementById('accuracy-saved-stats');
    opts = opts || {};
    lastRunsFetchOpts = opts;
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
            '<td colspan="' +
            savedRunsColspan +
            '" class="py-6 px-3 text-center text-rose-300 text-sm">' +
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
          '<td colspan="' +
          savedRunsColspan +
          '" class="py-6 px-3 text-center text-rose-300 text-sm">Network error</td>';
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
      var delBtn = ev.target.closest('.accuracy-saved-delete-btn');
      if (delBtn && savedTbody.contains(delBtn)) {
        ev.preventDefault();
        ev.stopPropagation();
        var delId = delBtn.getAttribute('data-run-id');
        var dayStr = delBtn.getAttribute('data-compliance-day') || '';
        if (!delId) return;
        var msg =
          'Delete saved Forecast Percentage Error data for ' +
          (dayStr || 'this trade day') +
          '? This cannot be undone.';
        if (!window.confirm(msg)) return;
        delBtn.disabled = true;
        fetch('/api/nomination-accuracy/runs/' + encodeURIComponent(delId), { method: 'DELETE' })
          .then(function(r) {
            return r.json().then(function(j) {
              return { httpOk: r.ok, j: j };
            });
          })
          .then(function(ref) {
            if (!ref.j.ok) {
              if (statusEl) statusEl.textContent = ref.j.error || 'Delete failed';
              delBtn.disabled = false;
              return;
            }
            if (statusEl) statusEl.textContent = 'Removed run #' + delId;
            fetchRuns(lastRunsFetchOpts);
            refreshUploadedTradeDates();
          })
          .catch(function() {
            if (statusEl) statusEl.textContent = 'Delete: network error';
            delBtn.disabled = false;
          });
        return;
      }
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
    yearTotalsStrip.appendChild(
      mini(
        'Period max MQ (MW)',
        yt.billing_period_max_mq_mw != null && isFinite(Number(yt.billing_period_max_mq_mw))
          ? Number(yt.billing_period_max_mq_mw).toFixed(3)
          : '—'
      )
    );
    function miniEmph(label, val, extraClass) {
      var d = document.createElement('div');
      d.className =
        'rounded-lg border px-3 py-2 ' +
        (extraClass || 'border-brand-border/60 bg-brand-dark/40');
      d.innerHTML =
        '<p class="text-[9px] font-bold uppercase tracking-wider text-brand-muted">' +
        label +
        '</p><p class="mt-0.5 font-mono font-extrabold text-sm sm:text-base tabular-nums text-brand-text">' +
        val +
        '</p>';
      return d;
    }
    yearTotalsStrip.appendChild(
      miniEmph(
        'Year AVE MAPE',
        fmtPctFromFraction(yt.mape_bp_pooled),
        'border-emerald-500/40 bg-emerald-500/15 ring-1 ring-emerald-500/20'
      )
    );
    yearTotalsStrip.appendChild(
      miniEmph(
        'Year AVE P95',
        fmtPctFromFraction(yt.perc95_bp_pooled),
        'border-sky-500/40 bg-sky-500/15 ring-1 ring-sky-500/20'
      )
    );
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
          var bp = j.billing_period && typeof j.billing_period === 'object' ? j.billing_period : null;
          var rangeLine =
            bp && bp.start && bp.end
              ? String(bp.start) + ' → ' + String(bp.end)
              : '';
          var nDays =
            j.days_in_period != null
              ? j.days_in_period
              : j.calendar_days != null
                ? j.calendar_days
                : '—';
          var bps = j.billing_period_stats && typeof j.billing_period_stats === 'object' ? j.billing_period_stats : null;
          var bpLine = '';
          if (bps) {
            bpLine =
              ' · AVE MAPE ' +
              fmtPctFromFraction(bps.mape_bp_pooled) +
              ' · AVE P95 ' +
              fmtPctFromFraction(bps.perc95_bp_pooled);
            if (bps.billing_period_max_mq_mw != null && isFinite(Number(bps.billing_period_max_mq_mw))) {
              bpLine += ' · max MQ in period ' + Number(bps.billing_period_max_mq_mw).toFixed(3) + ' MW';
            }
            if (
              bps.perc95_bp_pooled == null &&
              (j.days_with_saved || 0) > 0 &&
              (bps.perc95_bp_runs_with_series == null || bps.perc95_bp_runs_with_series < 1)
            ) {
              bpLine += ' (re-save days to populate AVE P95)';
            }
          }
          monthDetailSummary.textContent =
            (rangeLine ? rangeLine + ' · ' : '') +
            String(nDays) +
            ' trade days in period · ' +
            String(j.days_with_saved != null ? j.days_with_saved : 0) +
            ' with saved run · ' +
            String(j.days_missing != null ? j.days_missing : 0) +
            ' missing' +
            bpLine;
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
        '" title="Show per-day uploads and gaps for this billing period (26th–25th)">' +
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
        '<td class="py-2 px-3 text-right text-brand-muted">' +
        fmtCompliancePct(cp) +
        '</td>' +
        '<td class="py-2 px-3 text-right font-semibold text-sm sm:text-base text-emerald-200/95 bg-emerald-500/10 border-l border-emerald-500/30" title="Period rollup MAPE (max MQ denominator)">' +
        fmtPctFromFraction(st.mape_bp_pooled) +
        '</td>' +
        '<td class="py-2 px-3 text-right font-semibold text-sm sm:text-base text-sky-200/95 bg-sky-500/10 border-l border-sky-500/30" title="Pooled PERC95; needs FPE on save">' +
        fmtPctFromFraction(st.perc95_bp_pooled) +
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
        '<td class="py-2 px-3 text-right text-brand-muted">' +
        fmtCompliancePct(cp) +
        '</td>' +
        '<td class="py-2 px-3 text-right font-semibold text-sm sm:text-base text-emerald-200/95 bg-emerald-500/10 border-l border-emerald-500/30">' +
        fmtPctFromFraction(st.mape_bp_pooled) +
        '</td>' +
        '<td class="py-2 px-3 text-right font-semibold text-sm sm:text-base text-sky-200/95 bg-sky-500/10 border-l border-sky-500/30">' +
        fmtPctFromFraction(st.perc95_bp_pooled) +
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
    var mapeBpPct = (months || []).map(function(m) {
      var v = m.stats && m.stats.mape_bp_pooled;
      return v != null && isFinite(v) ? v * 100 : null;
    });
    var p95BpPct = (months || []).map(function(m) {
      var v = m.stats && m.stats.perc95_bp_pooled;
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
              label: 'AVE MAPE %',
              data: mapeBpPct,
              borderColor: CHART.accent,
              backgroundColor: CHART.accentSoft,
              tension: 0.25,
              fill: false,
              spanGaps: true,
              pointRadius: 2
            },
            {
              label: 'AVE P95 %',
              data: p95BpPct,
              borderColor: CHART.sky,
              backgroundColor: CHART.skySoft,
              tension: 0.25,
              fill: false,
              spanGaps: true,
              pointRadius: 2
            }
          ]
        },
        options: (function() {
          var o = baseChartOptions();
          o.scales.y.title = { display: true, text: '%', color: CHART.muted };
          o.plugins.legend.position = 'top';
          if (o.plugins.legend.labels) {
            o.plugins.legend.labels.font = { size: 12, weight: '600' };
            o.plugins.legend.labels.padding = 14;
          }
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
          o.scales.y.title = {
            display: true,
            text: '% trade days compliant (in billing period)',
            color: CHART.muted
          };
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
    var mapeBpPct = (years || []).map(function(y) {
      var v = y.stats && y.stats.mape_bp_pooled;
      return v != null && isFinite(v) ? v * 100 : null;
    });

    chartRefs.annual = new Chart(el, {
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Trade days (billing year)',
            data: dayCounts,
            backgroundColor: 'rgba(51, 65, 85, 0.65)',
            borderColor: CHART.grid,
            borderWidth: 1,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: 'AVE MAPE %',
            data: mapeBpPct,
            borderColor: CHART.accent,
            backgroundColor: CHART.accentSoft,
            tension: 0.2,
            yAxisID: 'y1',
            spanGaps: true,
            pointRadius: 2
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
            title: { display: true, text: 'AVE MAPE %', color: CHART.muted },
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
        if (rollupStatus) rollupStatus.textContent = 'Enter a year between 2000 and 2100 (billing period end year).';
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
    var dlg = document.getElementById('accuracy-backfill-dialog');
    var openBtn = document.getElementById('accuracy-btn-backfill');
    var cancel = document.getElementById('accuracy-backfill-cancel');
    var submit = document.getElementById('accuracy-backfill-submit');
    var tradeDateEl = document.getElementById('accuracy-backfill-trade-date');
    var dateHint = document.getElementById('accuracy-backfill-date-hint');
    var rtdInput = document.getElementById('accuracy-backfill-rtd');
    var mqInput = document.getElementById('accuracy-backfill-mq');
    var statusMsg = document.getElementById('accuracy-backfill-status-msg');
    var spinEl = document.getElementById('accuracy-backfill-spinner');
    var submitLabel = document.getElementById('accuracy-backfill-submit-label');
    var logEl = document.getElementById('accuracy-backfill-log');
    var progressWrap = document.getElementById('accuracy-backfill-progress-wrap');
    var progressSummary = document.getElementById('accuracy-backfill-progress-summary');
    var backfillUploading = false;
    var backfillSeq = 0;
    var backfillAbort = null;

    function updateBackfillDateHint() {
      if (!tradeDateEl || !dateHint) return;
      var v = tradeDateEl.value;
      if (v && isTradeDateUnavailable(v)) {
        dateHint.textContent =
          'This day already has a saved run. Delete it in Saved runs first, or pick another date.';
        tradeDateEl.classList.add('ring-2', 'ring-rose-500/40');
      } else {
        dateHint.textContent = '';
        tradeDateEl.classList.remove('ring-2', 'ring-rose-500/40');
      }
    }

    function setBackfillBusy(on) {
      backfillUploading = !!on;
      if (dlg) dlg.setAttribute('aria-busy', on ? 'true' : 'false');
      if (spinEl) spinEl.classList.toggle('hidden', !on);
      if (submit) submit.disabled = on;
      if (cancel) cancel.disabled = on;
      if (tradeDateEl) tradeDateEl.disabled = on;
      if (rtdInput) rtdInput.disabled = on;
      if (mqInput) mqInput.disabled = on;
      if (submitLabel) submitLabel.textContent = on ? 'Working…' : 'Upload & save';
    }

    if (!dlg || !openBtn) return;
    if (tradeDateEl) {
      tradeDateEl.addEventListener('input', updateBackfillDateHint);
      tradeDateEl.addEventListener('change', updateBackfillDateHint);
    }
    dlg.addEventListener('cancel', function(e) {
      if (backfillUploading) e.preventDefault();
    });
    openBtn.addEventListener('click', function() {
      refreshUploadedTradeDates().then(function(datesOk) {
        updateBackfillDateHint();
        if (datesOk && tradeDateEl) {
          tradeDateEl.classList.remove('ring-2', 'ring-amber-500/35');
        }
        if (!datesOk && dateHint) {
          var existing = (dateHint.textContent || '').trim();
          var warn =
            'Could not load which days already have saved runs. Duplicate dates may not be highlighted until you refresh the page.';
          dateHint.textContent = existing ? existing + ' ' + warn : warn;
          if (tradeDateEl) tradeDateEl.classList.add('ring-2', 'ring-amber-500/35');
        }
        if (progressWrap) progressWrap.classList.add('hidden');
        if (progressSummary) progressSummary.textContent = '';
        if (dlg.showModal) dlg.showModal();
      });
    });
    if (cancel) {
      cancel.addEventListener('click', function() {
        if (backfillUploading) return;
        dlg.close();
      });
    }
    if (submit) {
      submit.addEventListener('click', function() {
        if (backfillUploading) return;
        if (!tradeDateEl || !tradeDateEl.value) {
          if (statusMsg) statusMsg.textContent = 'Choose a trade date.';
          return;
        }
        if (isTradeDateUnavailable(tradeDateEl.value)) {
          if (statusMsg) statusMsg.textContent = 'Pick a date without an existing saved run.';
          return;
        }
        if (!rtdInput || !rtdInput.files || !rtdInput.files[0]) {
          if (statusMsg) statusMsg.textContent = 'Choose the RTD / Actual workbook.';
          return;
        }
        if (!mqInput || !mqInput.files || !mqInput.files[0]) {
          if (statusMsg) statusMsg.textContent = 'Choose the MIRF Daily MQ workbook.';
          return;
        }
        if (logEl) {
          logEl.classList.add('hidden');
          logEl.textContent = '';
        }
        if (progressWrap) progressWrap.classList.remove('hidden');
        if (progressSummary) progressSummary.textContent = 'Uploading…';
        if (statusMsg) statusMsg.textContent = 'Uploading and processing…';
        setBackfillBusy(true);

        if (backfillAbort) {
          try {
            backfillAbort.abort();
          } catch (abErr) {}
        }
        backfillAbort = new AbortController();
        var seq = ++backfillSeq;

        var fd = new FormData();
        fd.append('rtd_file', rtdInput.files[0]);
        fd.append('mq_xlsx', mqInput.files[0]);
        fd.append('trade_date', tradeDateEl.value);

        fetch('/api/nomination-accuracy/rtd-dispatch-backfill', {
          method: 'POST',
          body: fd,
          signal: backfillAbort.signal
        })
          .then(function(r) {
            return r.json().then(function(j) {
              return { httpOk: r.ok, status: r.status, j: j };
            });
          })
          .then(function(ref) {
            if (seq !== backfillSeq) return;
            var j = ref.j;
            if (!ref.httpOk || !j.ok) {
              var errTop =
                (j && j.error) ||
                (ref.status === 409 ? 'This trade date already has a saved run.' : 'Request failed');
              if (statusMsg) statusMsg.textContent = errTop;
              if (progressSummary) progressSummary.textContent = '';
              if (logEl) {
                logEl.textContent = errTop;
                logEl.classList.remove('hidden');
              }
              setBackfillBusy(false);
              return;
            }
            var s = j.summary || {};
            var polObj = j.policy || {};
            var polLine = polObj.day_compliant ? 'policy OK' : polObj.analysis_summary || 'policy FAIL';
            var mp =
              s.mape_pct != null && isFinite(Number(s.mape_pct))
                ? Number(s.mape_pct).toFixed(2) + '% MAPE'
                : '';
            var p95 =
              s.perc95_pct != null && isFinite(Number(s.perc95_pct))
                ? Number(s.perc95_pct).toFixed(2) + '% P95'
                : '';
            var metrics = [mp, p95].filter(Boolean).join(', ');
            var line =
              (j.filename || '') +
              ' → ' +
              (j.storage_day || '') +
              ' · ' +
              (metrics || '—') +
              ' · ' +
              polLine +
              ' · run #' +
              (j.run_id != null ? j.run_id : '—') +
              (j.overwritten ? ' (replaced)' : '');
            if (j.date_warnings && j.date_warnings.length) {
              line += '\n' + j.date_warnings.join('\n');
            }
            if (statusMsg) statusMsg.textContent = 'Saved.';
            if (progressSummary) progressSummary.textContent = 'Done · run #' + j.run_id;
            if (logEl) {
              logEl.textContent = line;
              logEl.classList.remove('hidden');
            }
            refreshUploadedTradeDates().then(function() {
              updateBackfillDateHint();
            });
            setBackfillBusy(false);
          })
          .catch(function(err) {
            if (seq !== backfillSeq) return;
            if (err && err.name === 'AbortError') return;
            if (statusMsg) statusMsg.textContent = 'Network error';
            if (progressSummary) progressSummary.textContent = '';
            setBackfillBusy(false);
          });
      });
    }
  })();
})();
