(function initNominationReporting() {
  var fileInput = document.getElementById('reporting-file-compliance');
  var nameEl = document.getElementById('reporting-name-compliance');
  var readyEl = document.getElementById('reporting-ready-compliance');
  var btnPick = document.getElementById('reporting-btn-compliance');
  var dropZone = document.getElementById('reporting-drop-compliance');
  var complianceSpinner = document.getElementById('reporting-compliance-spinner');
  var saveStatus = document.getElementById('reporting-save-status');
  var storedUl = document.getElementById('reporting-stored-days');
  var storedEmpty = document.getElementById('reporting-stored-empty');
  var complianceUploading = false;

  function updateReady() {
    var ok = !!(fileInput && fileInput.files && fileInput.files[0]);
    if (readyEl) {
      readyEl.textContent = ok ? '✓ File ready' : '○ Waiting for file';
      readyEl.classList.toggle('text-emerald-400', ok);
      readyEl.classList.toggle('text-brand-muted', !ok);
    }
  }

  if (btnPick && fileInput) {
    btnPick.addEventListener('click', function(e) {
      e.stopPropagation();
      fileInput.click();
    });
  }
  function setComplianceSavingUi(on) {
    if (complianceSpinner) complianceSpinner.classList.toggle('hidden', !on);
    if (btnPick) btnPick.disabled = !!on;
    if (dropZone) {
      dropZone.classList.toggle('pointer-events-none', !!on);
      dropZone.classList.toggle('opacity-60', !!on);
    }
  }

  function uploadCompliance() {
    var f = fileInput.files && fileInput.files[0];
    if (!f || complianceUploading) return;
    complianceUploading = true;
    if (saveStatus) saveStatus.textContent = '';
    setComplianceSavingUi(true);
    var fd = new FormData();
    fd.append('compliance_csv', f);
    fetch('/api/nomination-reporting/compliance-csv', { method: 'POST', body: fd })
      .then(function(r) {
        return r.json().then(function(j) {
          return { httpOk: r.ok, j: j };
        });
      })
      .then(function(ref) {
        var j = ref.j;
        if (!ref.httpOk || !j.ok) {
          if (saveStatus) saveStatus.textContent = (j && j.error) || 'Upload failed';
          return;
        }
        if (saveStatus) {
          saveStatus.textContent =
            'Stored for trade day ' +
            (j.compliance_day || '—') +
            (j.overwritten ? ' (replaced existing).' : '.');
        }
        refreshStoredDays();
        refreshChartDaySelect();
      })
      .catch(function() {
        if (saveStatus) saveStatus.textContent = 'Network error';
      })
      .finally(function() {
        complianceUploading = false;
        setComplianceSavingUi(false);
      });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function() {
      var f = fileInput.files && fileInput.files[0];
      if (f && nameEl) {
        nameEl.textContent = f.name;
        nameEl.setAttribute('title', f.name);
        nameEl.classList.remove('text-brand-muted');
        nameEl.classList.add('text-brand-text');
      } else if (nameEl) {
        nameEl.textContent = 'No file selected';
        nameEl.removeAttribute('title');
        nameEl.classList.add('text-brand-muted');
        nameEl.classList.remove('text-brand-text');
      }
      updateReady();
      if (f) uploadCompliance();
    });
  }

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', function(e) {
      if (e.target.closest('button')) return;
      fileInput.click();
    });
    dropZone.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    var overlay = dropZone.querySelector('.accuracy-drop-overlay');
    ['dragenter', 'dragover'].forEach(function(ev) {
      dropZone.addEventListener(ev, function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('border-brand-accent/60', 'bg-brand-dark/50');
        if (overlay) overlay.classList.remove('opacity-0');
        if (overlay) overlay.classList.add('opacity-100');
      });
    });
    ['dragleave', 'drop'].forEach(function(ev) {
      dropZone.addEventListener(ev, function(e) {
        if (ev === 'dragleave' && e.relatedTarget && dropZone.contains(e.relatedTarget)) return;
        dropZone.classList.remove('border-brand-accent/60', 'bg-brand-dark/50');
        if (overlay) overlay.classList.add('opacity-0');
        if (overlay) overlay.classList.remove('opacity-100');
      });
    });
    dropZone.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/\.csv$/i.test(f.name)) {
        if (saveStatus) saveStatus.textContent = 'Please drop a .csv file.';
        return;
      }
      try {
        var dt = new DataTransfer();
        dt.items.add(f);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) {
        if (saveStatus) saveStatus.textContent = 'Could not attach file.';
      }
    });
  }

  function renderStoredDays(dates) {
    if (!storedUl) return;
    storedUl.innerHTML = '';
    if (!dates || !dates.length) {
      if (storedEmpty) storedEmpty.classList.remove('hidden');
      return;
    }
    if (storedEmpty) storedEmpty.classList.add('hidden');
    dates.forEach(function(d) {
      var li = document.createElement('li');
      li.className =
        'rounded-md border border-brand-border/70 bg-brand-dark/40 px-2.5 py-1 text-brand-text';
      li.textContent = d;
      storedUl.appendChild(li);
    });
  }

  function refreshStoredDays() {
    return fetch('/api/nomination-reporting/compliance-csv/days')
      .then(function(r) {
        return r.json();
      })
      .then(function(j) {
        if (j && j.ok && Array.isArray(j.dates)) {
          renderStoredDays(j.dates);
        }
      })
      .catch(function() {});
  }

  var marketFileInput = document.getElementById('reporting-file-market-result');
  var marketNameEl = document.getElementById('reporting-name-market-result');
  var marketPickBtn = document.getElementById('reporting-btn-market-result');
  var marketSpinner = document.getElementById('reporting-market-spinner');
  var marketSaveStatus = document.getElementById('reporting-save-market-status');
  var marketUploading = false;
  var marketStoredInline = document.getElementById('reporting-market-stored-inline');
  var chartDaySelect = document.getElementById('reporting-chart-day');
  var chartRefreshBtn = document.getElementById('reporting-btn-refresh-charts');
  var chartSummary = document.getElementById('reporting-chart-summary');
  var chartError = document.getElementById('reporting-chart-error');
  var chartDispatchEl = document.getElementById('reporting-chart-dispatch');
  var chartHourlyEl = document.getElementById('reporting-chart-hourly');
  var chartPartialBanner = document.getElementById('reporting-chart-partial-banner');
  var chartDispatch = null;
  var chartHourly = null;

  if (marketPickBtn && marketFileInput) {
    marketPickBtn.addEventListener('click', function() {
      marketFileInput.click();
    });
  }

  function setMarketSavingUi(on) {
    if (marketSpinner) marketSpinner.classList.toggle('hidden', !on);
    if (marketPickBtn) marketPickBtn.disabled = !!on;
  }

  function uploadMarketResult() {
    var f = marketFileInput.files && marketFileInput.files[0];
    if (!f || marketUploading) return;
    marketUploading = true;
    if (marketSaveStatus) marketSaveStatus.textContent = '';
    setMarketSavingUi(true);
    var fd = new FormData();
    fd.append('market_result_csv', f);
    fetch('/api/nomination-reporting/market-result-csv', { method: 'POST', body: fd })
      .then(function(r) {
        return r.json().then(function(j) {
          return { httpOk: r.ok, j: j };
        });
      })
      .then(function(ref) {
        var j = ref.j;
        if (!ref.httpOk || !j.ok) {
          if (marketSaveStatus) marketSaveStatus.textContent = (j && j.error) || 'Upload failed';
          return;
        }
        if (marketSaveStatus) {
          marketSaveStatus.textContent =
            'Stored for ' + (j.compliance_day || '—') + (j.overwritten ? ' (replaced).' : '.');
        }
        refreshMarketResultDaysInline();
        refreshChartDaySelect();
        var sel = chartDaySelect && chartDaySelect.value;
        if (sel) loadMarketplaceCharts(sel);
      })
      .catch(function() {
        if (marketSaveStatus) marketSaveStatus.textContent = 'Network error';
      })
      .finally(function() {
        marketUploading = false;
        setMarketSavingUi(false);
      });
  }

  if (marketFileInput) {
    marketFileInput.addEventListener('change', function() {
      var f = marketFileInput.files && marketFileInput.files[0];
      if (f && marketNameEl) {
        marketNameEl.textContent = f.name;
        marketNameEl.setAttribute('title', f.name);
        marketNameEl.classList.remove('text-brand-muted');
        marketNameEl.classList.add('text-brand-text');
      } else if (marketNameEl) {
        marketNameEl.textContent = 'No file selected';
        marketNameEl.removeAttribute('title');
        marketNameEl.classList.add('text-brand-muted');
        marketNameEl.classList.remove('text-brand-text');
      }
      if (f) uploadMarketResult();
    });
  }

  function refreshMarketResultDaysInline() {
    return fetch('/api/nomination-reporting/market-result-csv/days')
      .then(function(r) {
        return r.json();
      })
      .then(function(j) {
        if (j && j.ok && Array.isArray(j.dates) && marketStoredInline) {
          marketStoredInline.textContent = j.dates.length ? j.dates.join(', ') : '—';
        }
      })
      .catch(function() {});
  }

  /** Draws numeric labels above each LMP bar and each Actual line point on the hourly chart. */
  var reportingHourlyValueLabelsPlugin = {
    id: 'reportingHourlyValueLabels',
    afterDatasetsDraw: function(chart) {
      var ctx = chart.ctx;
      chart.data.datasets.forEach(function(dataset, dsIndex) {
        var meta = chart.getDatasetMeta(dsIndex);
        if (!meta || meta.hidden) return;
        var isBar = meta.type === 'bar' || dataset.type === 'bar';
        meta.data.forEach(function(element, index) {
          var raw = dataset.data[index];
          if (raw == null || raw === '') return;
          var v = typeof raw === 'number' ? raw : parseFloat(raw);
          if (isNaN(v)) return;
          var label = v.toFixed(1);
          var x;
          var y;
          if (isBar && element) {
            x = element.x;
            if (element.y !== undefined && element.base !== undefined) {
              y = Math.min(element.y, element.base) - 6;
            } else if (typeof element.tooltipPosition === 'function') {
              var posBar = element.tooltipPosition();
              x = posBar.x;
              var h = element.height;
              if (h != null && !isNaN(h) && h > 0) {
                y = posBar.y - h / 2 - 6;
              } else {
                y = posBar.y - 14;
              }
            } else {
              return;
            }
          } else if (element && typeof element.tooltipPosition === 'function') {
            var pos = element.tooltipPosition();
            x = pos.x;
            y = pos.y - 10;
          } else {
            return;
          }
          ctx.save();
          ctx.font = '600 10px system-ui, Segoe UI, sans-serif';
          ctx.fillStyle = isBar ? 'rgb(147, 197, 253)' : 'rgb(254, 215, 170)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(label, x, y);
          ctx.restore();
        });
      });
    }
  };

  function destroyReportingCharts() {
    if (chartDispatch) {
      chartDispatch.destroy();
      chartDispatch = null;
    }
    if (chartHourly) {
      chartHourly.destroy();
      chartHourly = null;
    }
  }

  function loadMarketplaceCharts(dayIso) {
    if (!dayIso || typeof Chart === 'undefined') return;
    if (chartError) {
      chartError.classList.add('hidden');
      chartError.textContent = '';
    }
    if (chartSummary) chartSummary.classList.add('hidden');
    if (chartPartialBanner) chartPartialBanner.classList.add('hidden');
    destroyReportingCharts();
    fetch('/api/nomination-reporting/marketplace-chart?day=' + encodeURIComponent(dayIso))
      .then(function(r) {
        return r.json().then(function(j) {
          return { httpOk: r.ok, j: j };
        });
      })
      .then(function(ref) {
        var j = ref.j;
        if (!ref.httpOk || !j.ok) {
          if (chartError) {
            chartError.textContent = (j && j.error) || 'Could not load charts';
            chartError.classList.remove('hidden');
          }
          return;
        }
        var isPartial = !!j.partial;
        if (chartPartialBanner) {
          if (isPartial && j.partial_message) {
            chartPartialBanner.textContent = j.partial_message;
            chartPartialBanner.classList.remove('hidden');
          }
        }
        var ds = j.dispatch_series || [];
        var labels = ds.map(function(r) {
          return r.i;
        });
        var rtd = ds.map(function(r) {
          return r.rtd_mw;
        });
        var act = ds.map(function(r) {
          return r.actual_mw;
        });
        var da = ds.map(function(r) {
          return r.day_ahead_mw != null ? r.day_ahead_mw : null;
        });
        var dispatchDatasets = [
          {
            label: 'RTD (Market DOT)',
            data: rtd,
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.1,
            pointRadius: 0,
            borderWidth: 1.5
          },
          {
            label: 'Actual',
            data: act,
            borderColor: 'rgb(249, 115, 22)',
            backgroundColor: 'rgba(249, 115, 22, 0.08)',
            tension: 0.1,
            pointRadius: 0,
            borderWidth: 1.5
          }
        ];
        if (!isPartial) {
          dispatchDatasets.push({
            label: 'Day-ahead MW (schedule)',
            data: da,
            borderColor: 'rgb(34, 197, 94)',
            backgroundColor: 'transparent',
            spanGaps: true,
            tension: 0,
            stepped: true,
            pointRadius: 0,
            borderWidth: 1.5
          });
        }
        if (chartDispatchEl) {
          chartDispatch = new Chart(chartDispatchEl.getContext('2d'), {
            type: 'line',
            data: {
              labels: labels,
              datasets: dispatchDatasets
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { labels: { color: '#94a3b8' } },
                tooltip: {
                  callbacks: {
                    title: function(items) {
                      var i = items[0] && items[0].dataIndex;
                      return i != null && ds[i] ? ds[i].interval_end || '' : '';
                    }
                  }
                }
              },
              scales: {
                x: {
                  ticks: { color: '#64748b', maxTicksLimit: 20 },
                  grid: { color: 'rgba(51, 65, 85, 0.5)' }
                },
                y: {
                  beginAtZero: true,
                  ticks: { color: '#94a3b8' },
                  grid: { color: 'rgba(51, 65, 85, 0.5)' },
                  title: { display: true, text: 'MW', color: '#64748b' }
                }
              }
            }
          });
        }
        var hourly = j.hourly_6am_6pm || [];
        var hLabels = hourly.map(function(h) {
          return h.label;
        });
        var hAct = hourly.map(function(h) {
          return h.actual_mw_avg != null ? h.actual_mw_avg : null;
        });
        var hLmp = hourly.map(function(h) {
          return h.lmp != null ? h.lmp : null;
        });
        if (chartHourlyEl) {
          if (isPartial) {
            chartHourly = new Chart(chartHourlyEl.getContext('2d'), {
              type: 'line',
              plugins: [reportingHourlyValueLabelsPlugin],
              data: {
                labels: hLabels,
                datasets: [
                  {
                    label: 'Actual MW (hourly avg)',
                    data: hAct,
                    borderColor: 'rgb(249, 115, 22)',
                    backgroundColor: 'rgba(249, 115, 22, 0.12)',
                    tension: 0.2,
                    fill: false,
                    borderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: 'rgb(249, 115, 22)',
                    pointBorderColor: 'rgb(255, 237, 213)',
                    pointBorderWidth: 1
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 14 } },
                plugins: {
                  legend: { labels: { color: '#94a3b8' } },
                  title: {
                    display: true,
                    text: 'LMP bars appear after Energy Schedules upload',
                    color: '#64748b',
                    font: { size: 11 }
                  }
                },
                scales: {
                  x: {
                    ticks: { color: '#64748b' },
                    grid: { color: 'rgba(51, 65, 85, 0.5)' }
                  },
                  y: {
                    beginAtZero: true,
                    ticks: { color: '#f97316' },
                    grid: { color: 'rgba(51, 65, 85, 0.5)' },
                    title: { display: true, text: 'MW', color: '#9ca3af' }
                  }
                }
              }
            });
          } else {
            chartHourly = new Chart(chartHourlyEl.getContext('2d'), {
              type: 'bar',
              plugins: [reportingHourlyValueLabelsPlugin],
              data: {
                labels: hLabels,
                datasets: [
                  {
                    type: 'bar',
                    label: 'LMP',
                    data: hLmp,
                    backgroundColor: 'rgba(59, 130, 246, 0.45)',
                    yAxisID: 'y1',
                    borderWidth: 0,
                    order: 2
                  },
                  {
                    type: 'line',
                    label: 'Actual MW (hourly avg)',
                    data: hAct,
                    borderColor: 'rgb(249, 115, 22)',
                    backgroundColor: 'rgba(249, 115, 22, 0.15)',
                    yAxisID: 'y',
                    tension: 0.2,
                    fill: false,
                    borderWidth: 2,
                    order: 1,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: 'rgb(249, 115, 22)',
                    pointBorderColor: 'rgb(255, 237, 213)',
                    pointBorderWidth: 1
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 14 } },
                plugins: {
                  legend: { labels: { color: '#94a3b8' } }
                },
                scales: {
                  x: {
                    ticks: { color: '#64748b' },
                    grid: { color: 'rgba(51, 65, 85, 0.5)' }
                  },
                  y: {
                    position: 'left',
                    beginAtZero: true,
                    ticks: { color: '#f97316' },
                    grid: { color: 'rgba(51, 65, 85, 0.5)' },
                    title: { display: true, text: 'MW', color: '#9ca3af' }
                  },
                  y1: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: { color: '#60a5fa' },
                    title: { display: true, text: 'LMP', color: '#9ca3af' }
                  }
                }
              }
            });
          }
        }
        if (chartSummary) {
          var parts = [];
          parts.push('Trade day ' + (j.trade_day || dayIso));
          if (isPartial) {
            parts.push('MPI from database only');
          }
          if (j.actual_dispatch_mwh_compliance_window != null) {
            parts.push(
              'Actual MWh (05:05–19:00 window) ' + j.actual_dispatch_mwh_compliance_window.toFixed(1)
            );
          }
          if (j.actual_dispatch_avg_mw_6am_6pm != null) {
            parts.push('Avg actual MW 6AM–6PM ' + j.actual_dispatch_avg_mw_6am_6pm.toFixed(2));
          }
          if (!isPartial && j.lmp_average_e7_e19 != null) {
            parts.push('Avg LMP (rows 7–19) ' + j.lmp_average_e7_e19.toFixed(2));
          }
          if (!isPartial && j.lmp_average_e7_e19_display != null) {
            parts.push('Avg LMP ÷1000 (display) ' + j.lmp_average_e7_e19_display);
          }
          chartSummary.textContent = parts.join(' · ');
          chartSummary.classList.remove('hidden');
        }
      })
      .catch(function() {
        if (chartError) {
          chartError.textContent = 'Network error';
          chartError.classList.remove('hidden');
        }
      });
  }

  function refreshChartDaySelect() {
    return fetch('/api/nomination-reporting/compliance-csv/days')
      .then(function(r) {
        return r.json();
      })
      .then(function(j) {
        if (!chartDaySelect || !j || !j.ok || !Array.isArray(j.dates)) return;
        var prev = chartDaySelect.value;
        chartDaySelect.innerHTML = '';
        var opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = j.dates.length ? '— Select day —' : '— Upload MPI compliance first —';
        chartDaySelect.appendChild(opt0);
        j.dates.forEach(function(d) {
          var o = document.createElement('option');
          o.value = d;
          o.textContent = d;
          chartDaySelect.appendChild(o);
        });
        if (prev && j.dates.indexOf(prev) >= 0) {
          chartDaySelect.value = prev;
        } else if (j.dates.length === 1) {
          chartDaySelect.value = j.dates[0];
          loadMarketplaceCharts(j.dates[0]);
        }
      })
      .catch(function() {});
  }

  if (chartDaySelect) {
    chartDaySelect.addEventListener('change', function() {
      var v = chartDaySelect.value;
      if (v) loadMarketplaceCharts(v);
      else destroyReportingCharts();
    });
  }
  if (chartRefreshBtn) {
    chartRefreshBtn.addEventListener('click', function() {
      refreshStoredDays();
      refreshMarketResultDaysInline();
      refreshChartDaySelect();
      var v = chartDaySelect && chartDaySelect.value;
      if (v) loadMarketplaceCharts(v);
    });
  }

  updateReady();
  refreshStoredDays();
  refreshMarketResultDaysInline();
  refreshChartDaySelect();
})();
