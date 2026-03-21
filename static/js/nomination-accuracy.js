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

  /** Match server billing_period_for_start_month (month 1–12). */
  function billingPeriodRange(year, month) {
    if (!isFinite(year) || !isFinite(month) || month < 1 || month > 12) return null;
    var start = isoFromDate(year, month - 1, 26);
    var end =
      month === 12
        ? isoFromDate(year + 1, 0, 25)
        : isoFromDate(year, month, 25);
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
      tr.innerHTML =
        '<td class="py-2 px-3 text-xs sm:text-sm">' +
        (x.compliance_day || '—') +
        '</td>' +
        '<td class="py-2 px-3 text-right">' +
        mapeStr +
        '</td>' +
        '<td class="py-2 px-3 text-right hidden sm:table-cell">' +
        p95Str +
        '</td>' +
        '<td class="py-2 px-3 text-center">' +
        badge +
        '</td>' +
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
      '<td colspan="5" class="py-6 px-3 text-center text-brand-muted text-sm">Loading…</td>';
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
            '<td colspan="5" class="py-6 px-3 text-center text-rose-300 text-sm">' +
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
          '<td colspan="5" class="py-6 px-3 text-center text-rose-300 text-sm">Network error</td>';
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

  function renderMonthlyTable(months, year) {
    if (!monthlyTbody) return;
    monthlyTbody.innerHTML = '';
    if (rollupYearLabel) rollupYearLabel.textContent = String(year);
    (months || []).forEach(function(row, i) {
      var st = row.stats || {};
      var days = st.days_in_selection != null ? st.days_in_selection : 0;
      var cp = compliancePct(st);
      var tr = document.createElement('tr');
      tr.className =
        (i % 2 === 0 ? 'bg-brand-dark/10 ' : '') + 'border-b border-brand-border/30';
      tr.innerHTML =
        '<td class="py-2 px-3 text-brand-text">' +
        row.label +
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
})();
