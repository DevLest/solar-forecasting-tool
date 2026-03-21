(function () {
  'use strict';

  var LS_KEY = 'areco_billing_export_dir';

  var fileInput = document.getElementById('billing-file-master');
  var dropZone = document.getElementById('billing-drop-master');
  var btnMaster = document.getElementById('billing-btn-master');
  var nameMaster = document.getElementById('billing-name-master');
  var readyMaster = document.getElementById('billing-ready-master');
  var pwdInput1 = document.getElementById('billing-zip-password1');
  var pwdInput2 = document.getElementById('billing-zip-password2');
  var envPwdStatus = document.getElementById('billing-env-pwd-status');
  var btnExportSettings = document.getElementById('billing-btn-export-settings');
  var pathPreview = document.getElementById('billing-export-path-preview');
  var btnExtract = document.getElementById('billing-btn-extract');
  var extractSpinner = document.getElementById('billing-extract-spinner');
  var extractLabel = document.getElementById('billing-extract-label');
  var extractStatus = document.getElementById('billing-extract-status');
  var resultWrap = document.getElementById('billing-result-wrap');
  var resultBanner = document.getElementById('billing-result-banner');
  var outArecoDays = document.getElementById('billing-out-areco-days');
  var outArecossDays = document.getElementById('billing-out-arecoss-days');
  var filesTbody = document.getElementById('billing-files-tbody');
  var filesCount = document.getElementById('billing-files-count');

  var dialogEl = document.getElementById('billing-export-modal');
  var modalInput = document.getElementById('billing-modal-export-input');
  var modalCancel = document.getElementById('billing-modal-cancel');
  var modalSave = document.getElementById('billing-modal-save');
  var modalUseDefault = document.getElementById('billing-modal-use-default');
  var modalShortcuts = document.getElementById('billing-modal-shortcuts');
  var modalShortcutsHint = document.getElementById('billing-modal-shortcuts-hint');

  var masterFile = null;
  var exportPath = '';
  var pendingExtractAfterModal = false;
  var progressPhaseTimer = null;
  var progressElapsedTimer = null;
  var progressStartMs = 0;

  function stripQuotes(s) {
    s = (s || '').trim();
    if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') || (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
      return s.slice(1, -1);
    }
    return s;
  }

  function loadStoredPath() {
    try {
      return stripQuotes(localStorage.getItem(LS_KEY) || '');
    } catch (e) {
      return '';
    }
  }

  function saveStoredPath(p) {
    try {
      localStorage.setItem(LS_KEY, p);
    } catch (e) {}
  }

  function updatePathPreview() {
    if (!pathPreview) return;
    if (exportPath) {
      pathPreview.textContent = exportPath;
      pathPreview.title = exportPath;
    } else {
      pathPreview.textContent = 'No folder configured';
      pathPreview.title = '';
    }
  }

  function setMasterFile(file) {
    masterFile = file || null;
    if (nameMaster) {
      nameMaster.textContent = masterFile ? masterFile.name : 'No file selected';
      nameMaster.title = masterFile ? masterFile.name : '';
    }
    if (readyMaster) {
      readyMaster.textContent = masterFile ? '● Ready: ' + masterFile.name : '○ Waiting for zip';
      readyMaster.classList.toggle('text-brand-accent', !!masterFile);
      readyMaster.classList.toggle('text-brand-muted', !masterFile);
    }
  }

  function refreshModalShortcuts() {
    if (!modalShortcuts) return;
    modalShortcuts.innerHTML =
      '<span class="text-xs text-brand-muted py-2 inline-block">Loading folders from this PC…</span>';
    if (modalShortcutsHint) {
      modalShortcutsHint.classList.add('hidden');
      modalShortcutsHint.textContent = '';
    }
    fetch('/api/billing/user-export-shortcuts')
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        modalShortcuts.innerHTML = '';
        if (!j.ok || !j.shortcuts || !j.shortcuts.length) {
          modalShortcuts.innerHTML =
            '<span class="text-xs text-rose-300/90 py-1">No Desktop/Downloads/Documents detected. Paste a full path or use app data folder.</span>';
          return;
        }
        j.shortcuts.forEach(function (s) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = s.label;
          btn.title = s.path;
          btn.className =
            'py-2 px-3 rounded-lg border border-brand-border bg-brand-dark text-brand-text text-xs font-semibold uppercase tracking-wide hover:bg-brand-border/35 hover:border-brand-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40';
          btn.addEventListener('click', function () {
            if (modalInput) {
              modalInput.value = s.path;
              modalInput.focus();
            }
            if (modalShortcutsHint) {
              modalShortcutsHint.textContent = 'Using: ' + s.path;
              modalShortcutsHint.classList.remove('hidden');
            }
          });
          modalShortcuts.appendChild(btn);
        });
      })
      .catch(function () {
        modalShortcuts.innerHTML =
          '<span class="text-xs text-rose-300/90 py-1">Could not load shortcuts. Paste a path (Shift+right-click folder → Copy as path).</span>';
      });
  }

  function openExportModalSettings() {
    if (!dialogEl || !modalInput) return;
    pendingExtractAfterModal = false;
    if (modalSave) modalSave.textContent = 'Save';
    modalInput.value = exportPath || loadStoredPath();
    refreshModalShortcuts();
    dialogEl.showModal();
    modalInput.focus();
  }

  function openExportModalForExtract() {
    if (!dialogEl || !modalInput) return;
    pendingExtractAfterModal = true;
    if (modalSave) modalSave.textContent = 'Save & extract';
    var cur = stripQuotes(exportPath || loadStoredPath());
    modalInput.value = cur;
    refreshModalShortcuts();
    dialogEl.showModal();
    if (!stripQuotes(modalInput.value)) {
      fetchDefaultDir()
        .then(function (j) {
          if (j.ok && j.path && modalInput && !stripQuotes(modalInput.value)) {
            modalInput.value = j.path;
          }
        })
        .catch(function () {});
    }
    modalInput.focus();
  }

  function closeExportModal() {
    if (dialogEl) dialogEl.close();
  }

  var PROGRESS_PHASES = [
    'Uploading zip to the server…',
    'Unpacking master archive…',
    'Locating ARECO and ARECOSS bundles…',
    'Extracting daily password-protected zips…',
    'Writing files into your export folder…'
  ];

  function showExtractProgressUI() {
    var dlg = document.getElementById('billing-extract-progress-modal');
    var phaseEl = document.getElementById('billing-progress-phase');
    var elapsedEl = document.getElementById('billing-progress-elapsed');
    var stepEls = document.querySelectorAll('.billing-progress-step');
    if (!dlg) return;
    var phaseIdx = 0;
    if (phaseEl) phaseEl.textContent = PROGRESS_PHASES[0];
    progressStartMs = Date.now();
    if (elapsedEl) elapsedEl.textContent = 'Elapsed: 0s';
    function paintSteps(activeIdx) {
      stepEls.forEach(function (li) {
        var n = parseInt(li.getAttribute('data-step'), 10);
        var done = n < activeIdx;
        var active = n === activeIdx;
        li.className =
          'billing-progress-step rounded-lg border px-3 py-2 transition-colors text-left ' +
          (done
            ? 'border-emerald-500/35 bg-emerald-950/20 text-emerald-100/95'
            : active
              ? 'border-brand-accent/50 bg-brand-accent/10 text-brand-text'
              : 'border-transparent text-brand-muted');
        var label = li.getAttribute('data-label') || '';
        li.textContent = (done ? '✓ ' : active ? '… ' : '○ ') + label;
      });
    }
    stepEls.forEach(function (li) {
      if (!li.getAttribute('data-label')) {
        li.setAttribute('data-label', li.textContent.replace(/^[✓…○]\s+/, '').trim());
      }
    });
    paintSteps(0);
    clearInterval(progressPhaseTimer);
    clearInterval(progressElapsedTimer);
    progressElapsedTimer = setInterval(function () {
      if (elapsedEl) {
        elapsedEl.textContent =
          'Elapsed: ' + Math.floor((Date.now() - progressStartMs) / 1000) + 's';
      }
    }, 1000);
    progressPhaseTimer = setInterval(function () {
      phaseIdx = (phaseIdx + 1) % PROGRESS_PHASES.length;
      if (phaseEl) phaseEl.textContent = PROGRESS_PHASES[phaseIdx];
      paintSteps(Math.min(phaseIdx, stepEls.length - 1));
    }, 2800);
    dlg.showModal();
  }

  function hideExtractProgressUI() {
    clearInterval(progressPhaseTimer);
    clearInterval(progressElapsedTimer);
    progressPhaseTimer = null;
    progressElapsedTimer = null;
    var dlg = document.getElementById('billing-extract-progress-modal');
    if (dlg && dlg.open) dlg.close();
  }

  function showBillingErrorModal(title, lines) {
    var text = (lines || []).filter(Boolean).join('\n\n');
    if (typeof window.showConfirmationModal === 'function') {
      window.showConfirmationModal({
        title: title || 'Extraction problem',
        body: text || 'Something went wrong.',
        hideCancel: true,
        confirmLabel: 'OK'
      });
    } else {
      alert((title || 'Error') + (text ? '\n\n' + text : ''));
    }
  }

  function bindDropzone() {
    if (!dropZone || !fileInput) return;
    function pick() {
      fileInput.click();
    }
    if (btnMaster) btnMaster.addEventListener('click', function (e) {
      e.stopPropagation();
      pick();
    });
    dropZone.addEventListener('click', pick);
    dropZone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      setMasterFile(f || null);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('border-brand-accent/60', 'bg-brand-dark/50');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('border-brand-accent/60', 'bg-brand-dark/50');
      });
    });
    dropZone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.zip$/i.test(f.name)) {
        setMasterFile(f);
      } else if (f) {
        setMasterFile(null);
        if (extractStatus) extractStatus.textContent = 'Please drop a .zip file.';
      }
    });
  }

  function setExtractLoading(on) {
    if (btnExtract) btnExtract.disabled = on;
    if (extractSpinner) extractSpinner.classList.toggle('hidden', !on);
    if (extractLabel) extractLabel.textContent = on ? 'Working…' : 'Extract & organize';
  }

  function renderBanner(ok, messages) {
    if (!resultBanner) return;
    resultBanner.className = 'rounded-xl border p-4 sm:p-5 ' + (ok ? 'border-emerald-500/50 bg-emerald-950/25' : 'border-rose-500/50 bg-rose-950/20');
    resultBanner.innerHTML = '<p class="text-sm font-bold uppercase tracking-wide ' + (ok ? 'text-emerald-200' : 'text-rose-200') + '">' + (ok ? 'Done' : 'Completed with errors') + '</p><ul class="mt-2 text-xs list-disc pl-5 space-y-1 text-brand-text/95">' + messages.map(function (m) {
      return '<li>' + escapeHtml(m) + '</li>';
    }).join('') + '</ul>';
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderTable(rows) {
    if (!filesTbody) return;
    filesTbody.innerHTML = '';
    (rows || []).forEach(function (r) {
      var tr = document.createElement('tr');
      tr.className = 'border-b border-brand-border/40 hover:bg-brand-dark/30';
      ['branch', 'date', 'folder', 'file'].forEach(function (k) {
        var td = document.createElement('td');
        td.className = 'py-2 px-3 align-top break-all';
        td.textContent = r[k] != null ? String(r[k]) : '';
        tr.appendChild(td);
      });
      filesTbody.appendChild(tr);
    });
  }

  function onExtractButtonClick() {
    if (!masterFile) {
      if (extractStatus) extractStatus.textContent = 'Choose the master settlement zip first.';
      return;
    }
    openExportModalForExtract();
  }

  function performExtract() {
    if (!masterFile) {
      if (extractStatus) extractStatus.textContent = 'Choose the master settlement zip first.';
      return;
    }
    var out = stripQuotes(exportPath);
    if (!out) {
      if (extractStatus) extractStatus.textContent = 'Enter an export folder path in the dialog.';
      openExportModalForExtract();
      return;
    }

    var fd = new FormData();
    fd.append('settlement_zip', masterFile, masterFile.name);
    fd.append('output_dir', out);
    if (pwdInput1 && pwdInput1.value) fd.append('zip_password1', pwdInput1.value);
    if (pwdInput2 && pwdInput2.value) fd.append('zip_password2', pwdInput2.value);

    setExtractLoading(true);
    showExtractProgressUI();
    if (extractStatus) extractStatus.textContent = 'Uploading and extracting…';

    fetch('/api/billing/settlement-extract', { method: 'POST', body: fd })
      .then(function (res) {
        return res.text().then(function (text) {
          var j = {};
          try {
            j = text ? JSON.parse(text) : {};
          } catch (e) {
            j = { ok: false, error: text || res.statusText || 'Invalid response' };
          }
          return { res: res, j: j };
        });
      })
      .then(function (_ref) {
        var res = _ref.res;
        var j = _ref.j;
        if (!resultWrap) return;

        var msgs = [];
        if (j.output_dir) msgs.push('Output: ' + j.output_dir);
        if (j.error && !(j.errors && j.errors.length)) msgs.push('Server: ' + j.error);
        (j.warnings || []).forEach(function (w) {
          msgs.push('Warning: ' + w);
        });
        (j.errors || []).forEach(function (e) {
          msgs.push('Error: ' + e);
        });
        if ((!j.errors || j.errors.length === 0) && res.status < 400) {
          msgs.push('Files written: ' + (j.files_count != null ? j.files_count : 0));
        }

        resultWrap.classList.remove('hidden');
        var bannerOk = !!j.ok && res.ok;
        renderBanner(bannerOk, msgs.length ? msgs : [res.ok ? 'Done.' : 'Request failed (' + res.status + ').']);
        if (outArecoDays) outArecoDays.textContent = (j.areco_days && j.areco_days.length) ? j.areco_days.join(', ') : '—';
        if (outArecossDays) outArecossDays.textContent = (j.arecoss_days && j.arecoss_days.length) ? j.arecoss_days.join(', ') : '—';
        if (filesCount) filesCount.textContent = (j.files_count != null ? j.files_count : 0) + ' file(s)';
        renderTable(j.files_placed || []);

        if (extractStatus) {
          if (!res.ok && j.error) {
            extractStatus.textContent = 'Error (' + res.status + '): ' + j.error;
          } else {
            extractStatus.textContent = j.ok ? 'Success.' : 'Finished with errors (' + res.status + ').';
          }
        }

        var showErrModal =
          !res.ok ||
          j.ok === false ||
          (j.errors && j.errors.length > 0);
        if (showErrModal) {
          var errLines = [];
          if (!res.ok) errLines.push('HTTP ' + res.status);
          if (j.error) errLines.push(String(j.error));
          (j.errors || []).forEach(function (e) {
            errLines.push(String(e));
          });
          (j.warnings || []).forEach(function (w) {
            errLines.push('Warning: ' + w);
          });
          if (j.output_dir) errLines.push('Output folder: ' + j.output_dir);
          showBillingErrorModal('Extraction did not finish cleanly', errLines);
        }
      })
      .catch(function (err) {
        if (extractStatus) {
          extractStatus.textContent = 'Request failed: ' + (err && err.message ? err.message : String(err));
        }
        showBillingErrorModal('Network or server error', [
          err && err.message ? err.message : String(err),
          'Check that the Flask app is running and try again.'
        ]);
      })
      .finally(function () {
        hideExtractProgressUI();
        setExtractLoading(false);
      });
  }

  function fetchDefaultDir() {
    return fetch('/api/billing/default-export-dir').then(function (r) {
      return r.json();
    });
  }

  exportPath = loadStoredPath();
  updatePathPreview();

  function refreshSettlementConfig() {
    if (!envPwdStatus) return;
    fetch('/api/billing/settlement-config')
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok) {
          envPwdStatus.textContent = '';
          return;
        }
        var n = j.zip_password_slots_from_env;
        if (n >= 2) {
          envPwdStatus.textContent = '.env: 2 passwords';
          envPwdStatus.className = 'text-[10px] font-mono text-emerald-400/90';
        } else if (n === 1) {
          envPwdStatus.textContent = '.env: 1 password';
          envPwdStatus.className = 'text-[10px] font-mono text-amber-300/90';
        } else {
          envPwdStatus.textContent = '.env: none (set .env or overrides)';
          envPwdStatus.className = 'text-[10px] font-mono text-rose-300/85';
        }
      })
      .catch(function () {
        envPwdStatus.textContent = '';
      });
  }

  bindDropzone();
  refreshSettlementConfig();

  if (btnExportSettings) btnExportSettings.addEventListener('click', openExportModalSettings);
  if (modalCancel) {
    modalCancel.addEventListener('click', function () {
      pendingExtractAfterModal = false;
      if (modalSave) modalSave.textContent = 'Save';
      closeExportModal();
    });
  }
  if (modalSave) {
    modalSave.addEventListener('click', function () {
      var run = pendingExtractAfterModal;
      pendingExtractAfterModal = false;
      modalSave.textContent = 'Save';
      exportPath = stripQuotes(modalInput ? modalInput.value : '');
      saveStoredPath(exportPath);
      updatePathPreview();
      closeExportModal();
      if (run) {
        if (!exportPath) {
          if (extractStatus) extractStatus.textContent = 'Export path is required. Click Extract & organize again.';
          return;
        }
        performExtract();
      } else if (extractStatus) {
        extractStatus.textContent = exportPath ? 'Export folder saved.' : 'Cleared export path.';
      }
    });
  }

  if (dialogEl) {
    dialogEl.addEventListener('close', function () {
      pendingExtractAfterModal = false;
      if (modalSave) modalSave.textContent = 'Save';
    });
  }
  if (modalUseDefault) {
    modalUseDefault.addEventListener('click', function () {
      fetchDefaultDir()
        .then(function (j) {
          if (j.ok && j.path && modalInput) {
            modalInput.value = j.path;
          }
        })
        .catch(function () {});
    });
  }

  if (btnExtract) btnExtract.addEventListener('click', onExtractButtonClick);

  var progressDlg = document.getElementById('billing-extract-progress-modal');
  if (progressDlg) {
    progressDlg.addEventListener('cancel', function (e) {
      e.preventDefault();
    });
  }

  if (!fileInput) return;
})();
