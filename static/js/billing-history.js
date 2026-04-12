(function () {
  'use strict';

  var bhAuth = typeof window !== 'undefined' && window.__ARECO_AUTH__;
  var bhReadOnly = !!(bhAuth && bhAuth.role === 'spectator');

  var yearFilter = document.getElementById('bh-filter-year');
  var monthFilter = document.getElementById('bh-filter-month');
  var stmtFilter = document.getElementById('bh-filter-statement');
  var btnApply = document.getElementById('bh-btn-apply');
  var btnClear = document.getElementById('bh-btn-clear');

  var uploadYear = document.getElementById('bh-upload-year');
  var uploadMonth = document.getElementById('bh-upload-month');
  var uploadStmt = document.getElementById('bh-upload-statement');
  var btnUpload = document.getElementById('bh-btn-upload');
  var uploadStatus = document.getElementById('bh-upload-status');
  var bulkInput = document.getElementById('bh-invoices-bulk');
  var bulkClearBtn = document.getElementById('bh-btn-bulk-clear');

  var displayEmpty = document.getElementById('bh-display-empty');
  var displayWrap = document.getElementById('bh-display-wrap');
  var displayContext = document.getElementById('bh-display-context');
  var displayClearSel = document.getElementById('bh-display-clear-selection');
  var displaySales = document.getElementById('bh-display-sales');
  var displayPurch = document.getElementById('bh-display-purch');
  var inputTbody = document.getElementById('bh-input-tbody');
  var inputCount = document.getElementById('bh-input-count');

  /** @type {number|null} */
  var bhSelectedRowId = null;
  /** @type {Record<number, object>} */
  var bhRowsById = {};

  var STATUS = ['For Follow-Up', 'Overdue', 'Received'];

  function fmt(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
    var x = Number(n);
    return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function amountClass(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return 'text-brand-muted';
    var x = Number(n);
    if (x > 0) return 'text-emerald-300/95 tabular-nums';
    if (x < 0) return 'text-rose-300/90 tabular-nums';
    return 'text-brand-text/85 tabular-nums';
  }

  function countBulkFiles() {
    if (!bulkInput || !bulkInput.files) return 0;
    return bulkInput.files.length;
  }

  function updateBulkSummary() {
    var nb = countBulkFiles();
    var bulkSummaryEl = document.getElementById('bh-upload-bulk-summary');
    if (bulkSummaryEl) {
      if (nb === 0) {
        bulkSummaryEl.textContent = 'No PDFs selected.';
        bulkSummaryEl.className = 'text-[11px] text-brand-muted min-h-[1.25rem]';
      } else if (nb > 5) {
        bulkSummaryEl.textContent =
          nb + ' PDFs selected — at most 5 per import; remove extras before uploading.';
        bulkSummaryEl.className = 'text-[11px] text-amber-400/90 font-medium min-h-[1.25rem]';
      } else {
        bulkSummaryEl.textContent =
          nb + ' PDF(s) selected — invoice types and billing period are read on import.';
        bulkSummaryEl.className = 'text-[11px] text-emerald-400/95 font-medium min-h-[1.25rem]';
      }
    }
  }

  function clearBulkInput() {
    if (bulkInput) {
      bulkInput.value = '';
      updateBulkSummary();
    }
  }

  function updateDisplayContext(payload) {
    if (!displayContext) return;
    var sid = payload && payload.selected_row_id != null ? payload.selected_row_id : null;
    var rows = (payload && payload.rows) || [];
    if (sid != null) {
      var row = rows.filter(function (r) {
        return r.id === sid;
      })[0];
      displayContext.textContent = row
        ? 'Single row · #' +
          row.id +
          ' · ' +
          row.year +
          ' · ' +
          row.billing_month +
          ' · ' +
          row.statement_ref
        : 'Single row · #' + sid;
      displayContext.classList.remove('hidden');
      if (displayClearSel) displayClearSel.classList.remove('hidden');
    } else {
    }
  }

  function renderDisplayRow(label, value, index, isTotal, column) {
    var zebra = index % 2 === 0 ? 'bg-brand-dark/30' : 'bg-brand-dark/[0.08]';
    var totalSales =
      'border-t-2 border-emerald-500/35 bg-emerald-950/50 pl-3 border-l-4 border-l-emerald-400/70';
    var totalPurch =
      'border-t-2 border-amber-500/30 bg-rose-950/40 pl-3 border-l-4 border-l-amber-400/55';
    var rowCls = isTotal
      ? column === 'sales'
        ? totalSales
        : totalPurch
      : zebra + ' border-b border-brand-border/20';
    var labelCls = isTotal ? 'font-bold text-brand-text py-2.5 pr-3' : 'py-2 pr-3 text-brand-muted/95';
    var valCls = isTotal
      ? 'py-2.5 font-mono font-bold text-[15px] ' + amountClass(value)
      : 'py-2 font-mono ' + amountClass(value);
    return (
      '<tr class="' +
      rowCls +
      '"><td class="' +
      labelCls +
      '">' +
      label +
      '</td><td class="' +
      valCls +
      ' text-right min-w-[9rem]">' +
      fmt(value) +
      '</td></tr>'
    );
  }

  function renderDisplay(display, payload) {
    if (!display || !display.sales) {
      if (displayWrap) displayWrap.classList.add('hidden');
      if (displayEmpty) displayEmpty.classList.remove('hidden');
      if (displayContext) {
        displayContext.classList.add('hidden');
        displayContext.textContent = '';
      }
      if (displayClearSel) displayClearSel.classList.add('hidden');
      return;
    }
    updateDisplayContext(payload || {});
    if (displayEmpty) displayEmpty.classList.add('hidden');
    if (displayWrap) displayWrap.classList.remove('hidden');
    var s = display.sales;
    var p = display.purchases;
    var salesRows = [
      ['ARECO — VATable sales', s.vatable_g01],
      ['ARECO — Non-VATable sales', s.non_vatable_g01],
      ['ARECOSS — VATable sales', s.vatable_l01],
      ['ARECOSS — Non-VATable sales', s.non_vatable_l01],
      ['VAT — 06VISTASOL_G01', s.vat_on_g01],
      ['VAT — 06VISTASOL_L01', s.vat_on_l01],
      ['EWT on trading', s.ewt],
    ];
    var tp =
      display.total_payable_to_iemop != null && display.total_payable_to_iemop !== ''
        ? display.total_payable_to_iemop
        : p.total_payable;
    var purchDetailRows = [
      ['Purchases — VATable (ARECO)', p.vatable_g01],
      ['Purchases — Non-VATable (ARECO)', p.non_vatable_g01],
      ['Purchases — VATable (ARECOSS)', p.vatable_l01],
      ['Purchases — Non-VATable (ARECOSS)', p.non_vatable_l01],
      ['VAT on G01 / L01', p.vat_on_g01 + p.vat_on_l01],
      ['EWT (purchases)', p.ewt],
      ['Market fee — EMF regular', p.market_fee_1],
      ['Market fee — IEMMS', p.market_fee_2],
      ['Market fee — supplemental', p.market_fee_3],
    ];
    if (displaySales) {
      displaySales.innerHTML = salesRows
        .map(function (r, i) {
          return renderDisplayRow(r[0], r[1], i, false, 'sales');
        })
        .join('');
    }
    if (displayPurch) {
      displayPurch.innerHTML = purchDetailRows
        .map(function (r, i) {
          return renderDisplayRow(r[0], r[1], i, false, 'purch');
        })
        .join('');
    }
    var trRecv = display.total_receivable_from_iemop;
    if (displaySales && trRecv != null && trRecv !== '') {
      displaySales.insertAdjacentHTML(
        'beforeend',
        renderDisplayRow('TOTAL RECEIVABLE FROM IEMOP', trRecv, salesRows.length, true, 'sales')
      );
    }
    if (displayPurch && tp != null && tp !== '') {
      displayPurch.insertAdjacentHTML(
        'beforeend',
        renderDisplayRow('TOTAL PAYABLE TO IEMOP', tp, purchDetailRows.length, true, 'purch')
      );
    }
  }

  function renderInputRows(rows) {
    if (!inputTbody) return;
    inputTbody.innerHTML = '';
    bhRowsById = {};
    (rows || []).forEach(function (r) {
      bhRowsById[r.id] = r;
      var am = r.amounts || {};
      var tr = document.createElement('tr');
      var selected = bhSelectedRowId != null && r.id === bhSelectedRowId;
      tr.className =
        'border-b border-brand-border/40 transition-colors ' +
        (selected
          ? 'bg-brand-accent/20 ring-1 ring-inset ring-brand-accent/50 cursor-pointer'
          : 'hover:bg-brand-dark/25 cursor-pointer');
      tr.setAttribute('data-row-id', String(r.id));
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('title', selected ? 'Click to show aggregated Display' : 'Show this row in Display');
      var ef = Number(am.e || 0) + Number(am.f || 0);
      var hi = Number(am.h || 0) + Number(am.i || 0);
      var fees = Number(am.aa || 0) + Number(am.ab || 0) + Number(am.ac || 0);
      var sv = Number(am.s || 0) + Number(am.v || 0);
      tr.innerHTML =
        '<td class="py-2 px-2 align-middle whitespace-nowrap">' +
        r.year +
        '</td>' +
        '<td class="py-2 px-2 align-middle whitespace-nowrap">' +
        escapeHtml(r.billing_month) +
        '</td>' +
        '<td class="py-2 px-2 align-middle whitespace-nowrap">' +
        escapeHtml(r.statement_ref) +
        '</td>' +
        '<td class="py-2 px-2 text-right font-mono align-middle whitespace-nowrap">' +
        fmt(ef) +
        '</td>' +
        '<td class="py-2 px-2 text-right font-mono align-middle whitespace-nowrap">' +
        fmt(hi) +
        '</td>' +
        '<td class="py-2 px-2 text-right font-mono align-middle whitespace-nowrap">' +
        fmt(am.m) +
        '</td>' +
        '<td class="py-2 px-2 text-right font-mono align-middle whitespace-nowrap">' +
        fmt(fees) +
        '</td>' +
        '<td class="py-2 px-2 text-right font-mono align-middle whitespace-nowrap">' +
        fmt(sv) +
        '</td>' +
        '<td class="py-2 px-2 align-middle">' +
        (bhReadOnly
          ? '<span class="text-brand-text">' + escapeHtml(r.status_sales || '—') + '</span>'
          : statusSelect(r.id, 'status_sales', r.status_sales)) +
        '</td>' +
        '<td class="py-2 px-2 align-middle">' +
        (bhReadOnly
          ? '<span class="text-brand-text">' + escapeHtml(r.status_purchases || '—') + '</span>'
          : statusSelect(r.id, 'status_purchases', r.status_purchases)) +
        '</td>' +
        (bhReadOnly
          ? ''
          : '<td class="py-2 px-2 align-middle"><button type="button" class="bh-del inline-flex items-center h-8 px-0.5 text-rose-300 hover:text-rose-200 text-[11px] font-semibold uppercase leading-none" data-id="' +
            r.id +
            '">Delete</button></td>');
      inputTbody.appendChild(tr);
    });
    if (inputCount) inputCount.textContent = rows && rows.length ? rows.length + ' row(s)' : 'No rows';
    if (!bhReadOnly) {
      inputTbody.querySelectorAll('select[data-bh-status]').forEach(function (sel) {
        sel.addEventListener('change', onStatusChange);
        sel.addEventListener('click', function (e) {
          e.stopPropagation();
        });
      });
      inputTbody.querySelectorAll('.bh-del').forEach(function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          onDelete(ev);
        });
      });
    }
    inputTbody.querySelectorAll('tr[data-row-id]').forEach(function (tr) {
      tr.addEventListener('click', onInputRowClick);
      tr.addEventListener('keydown', onInputRowKeydown);
    });
  }

  function onInputRowClick(ev) {
    if (ev.target.closest('select, button')) return;
    var tr = ev.currentTarget;
    var id = parseInt(tr.getAttribute('data-row-id'), 10);
    if (!id) return;
    if (bhSelectedRowId === id) {
      bhSelectedRowId = null;
    } else {
      bhSelectedRowId = id;
    }
    refreshAll();
  }

  function onInputRowKeydown(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (ev.target.closest('select, button')) return;
    ev.preventDefault();
    var id = parseInt(ev.currentTarget.getAttribute('data-row-id'), 10);
    if (!id) return;
    if (bhSelectedRowId === id) {
      bhSelectedRowId = null;
    } else {
      bhSelectedRowId = id;
    }
    refreshAll();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusSelect(rowId, field, current) {
    var opts = STATUS.map(function (st) {
      return (
        '<option value="' +
        escapeHtml(st) +
        '"' +
        (st === current ? ' selected' : '') +
        '>' +
        escapeHtml(st) +
        '</option>'
      );
    }).join('');
    return (
      '<select data-bh-status="' +
      escapeHtml(field) +
      '" data-row-id="' +
      rowId +
      '" class="bh-status-select box-border h-8 max-w-[11rem] rounded border border-brand-border bg-brand-dark px-2 py-0 text-xs leading-none text-brand-text align-middle">' +
      opts +
      '</select>'
    );
  }

  function onStatusChange(ev) {
    var sel = ev.target;
    var id = parseInt(sel.getAttribute('data-row-id'), 10);
    var field = sel.getAttribute('data-bh-status');
    var body = {};
    body[field] = sel.value;
    fetch('/api/billing-history/rows/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Update failed');
      })
      .catch(function (err) {
        if (uploadStatus) uploadStatus.textContent = err.message || String(err);
      });
  }

  function onDelete(ev) {
    var id = parseInt(ev.target.getAttribute('data-id'), 10);
    if (!id) return;
    if (bhSelectedRowId === id) bhSelectedRowId = null;
    fetch('/api/billing-history/rows/' + id, { method: 'DELETE' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Delete failed');
        refreshAll();
      })
      .catch(function (err) {
        if (uploadStatus) uploadStatus.textContent = err.message || String(err);
      });
  }

  function qs() {
    var q = [];
    if (yearFilter && yearFilter.value) q.push('year=' + encodeURIComponent(yearFilter.value));
    if (monthFilter && monthFilter.value) q.push('billing_month=' + encodeURIComponent(monthFilter.value));
    if (stmtFilter && stmtFilter.value) q.push('statement_ref=' + encodeURIComponent(stmtFilter.value));
    if (bhSelectedRowId != null) q.push('row_id=' + encodeURIComponent(String(bhSelectedRowId)));
    return q.length ? '?' + q.join('&') : '';
  }

  function refreshAll() {
    var url = '/api/billing-history/display' + qs();
    fetch(url)
      .then(function (r) {
        if (r.status === 404) {
          bhSelectedRowId = null;
          return fetch('/api/billing-history/display' + qs()).then(function (r2) {
            return r2.json();
          });
        }
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Load failed');
        renderInputRows(j.rows || []);
        renderDisplay(j.display, j);
      })
      .catch(function (err) {
        if (uploadStatus) uploadStatus.textContent = err.message || String(err);
      });
  }

  function onApply() {
    bhSelectedRowId = null;
    refreshAll();
  }

  function onClearMonth() {
    if (monthFilter) monthFilter.value = '';
    if (stmtFilter) stmtFilter.value = '';
    bhSelectedRowId = null;
    refreshAll();
  }

  function onClearDisplaySelection() {
    bhSelectedRowId = null;
    refreshAll();
  }

  function applyDetectedPeriod(ap) {
    if (!ap) return;
    if (uploadYear && ap.year != null) uploadYear.value = String(ap.year);
    if (uploadMonth && ap.billing_month) uploadMonth.value = ap.billing_month;
    if (uploadStmt && ap.statement_ref) uploadStmt.value = ap.statement_ref;
    if (yearFilter && ap.year != null) yearFilter.value = String(ap.year);
    if (monthFilter && ap.billing_month) monthFilter.value = ap.billing_month;
    if (stmtFilter && ap.statement_ref) stmtFilter.value = ap.statement_ref;
  }

  function onUpload() {
    var nb = countBulkFiles();
    if (!nb) {
      if (uploadStatus) uploadStatus.textContent = 'Choose at least one PDF.';
      return;
    }
    if (nb > 5) {
      if (uploadStatus) uploadStatus.textContent = 'At most 5 PDFs per import.';
      return;
    }
    var fd = new FormData();
    fd.append('year', uploadYear && uploadYear.value !== '' ? uploadYear.value : '');
    fd.append('billing_month', uploadMonth ? uploadMonth.value : '');
    fd.append('statement_ref', uploadStmt ? uploadStmt.value : '');
    for (var i = 0; i < bulkInput.files.length; i++) {
      var bf = bulkInput.files[i];
      fd.append('invoices', bf, bf.name);
    }
    if (btnUpload) btnUpload.disabled = true;
    if (uploadStatus) uploadStatus.textContent = 'Uploading…';
    fetch('/api/billing-history/upload', { method: 'POST', body: fd })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Import failed');
        var parts = ['Imported row #' + j.row_id + '.'];
        if (j.applied_period) {
          var ap = j.applied_period;
          parts.push(ap.billing_month + ' ' + ap.year + ' · ' + ap.statement_ref + '.');
        }
        if (j.period_warnings && j.period_warnings.length) {
          parts.push(j.period_warnings.join(' '));
        }
        if (j.import_notes && j.import_notes.length) {
          parts.push(j.import_notes.join(' '));
        }
        if (uploadStatus) uploadStatus.textContent = parts.join(' ');
        clearBulkInput();
        applyDetectedPeriod(j.applied_period);
        bhSelectedRowId = j.row_id != null ? j.row_id : null;
        return fetch('/api/billing-history/display' + qs()).then(function (r) {
          return r.json();
        });
      })
      .then(function (j) {
        if (!j || !j.ok) return;
        renderInputRows(j.rows || []);
        renderDisplay(j.display, j);
      })
      .catch(function (err) {
        if (uploadStatus) uploadStatus.textContent = err.message || String(err);
      })
      .finally(function () {
        if (btnUpload) btnUpload.disabled = false;
      });
  }

  if (yearFilter) yearFilter.value = String(new Date().getFullYear());

  if (btnApply) btnApply.addEventListener('click', onApply);
  if (btnClear) btnClear.addEventListener('click', onClearMonth);
  if (!bhReadOnly && btnUpload) btnUpload.addEventListener('click', onUpload);
  if (displayClearSel) displayClearSel.addEventListener('click', onClearDisplaySelection);

  if (!bhReadOnly && bulkInput) {
    bulkInput.addEventListener('change', function () {
      updateBulkSummary();
    });
    updateBulkSummary();
  }
  if (!bhReadOnly && bulkClearBtn && bulkInput) {
    bulkClearBtn.addEventListener('click', function () {
      clearBulkInput();
    });
  }

  document.querySelectorAll('[data-nav-panel="billing-history"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTimeout(refreshAll, 0);
    });
  });
})();
