/**
 * Billing export zip: unpack outer archive (two inner zips), preview files,
 * write ARECO / ARECOSS tree with ARECO_ENERGY_{date} and ARECO_ENERGY_SEIN_{date}.
 * Uses File System Access API when available; otherwise offers a downloadable .zip.
 */
(function () {
  'use strict';

  if (typeof JSZip === 'undefined') {
    console.error('billing-extract: JSZip is not loaded');
    return;
  }

  var rootHandle = null;
  var outerZip = null;
  var outerFileName = '';
  /** @type {{ role: string, entryName: string, inner: JSZip, files: { rawPath: string, path: string, dir: 'energy'|'sein' }[] }[]} */
  var parsed = [];

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function ymdCompact(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  /**
   * Billing window: 26th of prior month through 25th of selected month (local).
   * @param {number} endYear
   * @param {number} endMonth1to12
   */
  function billingPeriodRange(endYear, endMonth1to12) {
    var end = new Date(endYear, endMonth1to12 - 1, 25);
    var start = new Date(endYear, endMonth1to12 - 1, 25);
    start.setMonth(start.getMonth() - 1);
    start.setDate(26);
    return { start: start, end: end };
  }

  function periodTag(endYear, endMonth1to12) {
    var r = billingPeriodRange(endYear, endMonth1to12);
    return ymdCompact(r.start) + '_' + ymdCompact(r.end);
  }

  function classifyOuterZipEntryName(name) {
    var base = (name || '').split(/[/\\]/).pop() || '';
    var u = base.toUpperCase();
    if (u.indexOf('ARECOSS') !== -1) return 'ARECOSS';
    if (u.indexOf('ARECO') !== -1) return 'ARECO';
    return null;
  }

  function routeEnergyVsSein(relPath) {
    var u = (relPath || '').replace(/\\/g, '/').toUpperCase();
    return u.indexOf('SEIN') !== -1 ? 'sein' : 'energy';
  }

  function sanitizePathSegment(seg) {
    var s = String(seg || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    if (!s || s === '.' || s === '..') return '_';
    return s;
  }

  function normalizeZipPath(name) {
    var p = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    var parts = p.split('/').filter(Boolean);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') continue;
      out.push(sanitizePathSegment(parts[i]));
    }
    return out.join('/');
  }

  function setStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg || '';
    el.classList.remove('text-brand-muted', 'text-brand-accent', 'text-red-400', 'text-amber-300');
    if (kind === 'ok') el.classList.add('text-brand-accent');
    else if (kind === 'err') el.classList.add('text-red-400');
    else if (kind === 'warn') el.classList.add('text-amber-300');
    else el.classList.add('text-brand-muted');
  }

  function supportsDirectoryPicker() {
    return typeof window.showDirectoryPicker === 'function';
  }

  async function ensureDir(parent, name) {
    return parent.getDirectoryHandle(name, { create: true });
  }

  async function writeBlobToPath(root, relPath, blob) {
    var norm = normalizeZipPath(relPath);
    if (!norm) return;
    var parts = norm.split('/');
    var fileName = parts.pop();
    var dh = root;
    for (var i = 0; i < parts.length; i++) {
      dh = await ensureDir(dh, parts[i]);
    }
    var fh = await dh.getFileHandle(fileName, { create: true });
    var w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async function buildInnerFileList(inner) {
    var files = [];
    inner.forEach(function (_content, path) {
      if (!path || path.endsWith('/')) return;
      var n = normalizeZipPath(path);
      if (!n) return;
      files.push({ rawPath: path, path: n, dir: routeEnergyVsSein(n) });
    });
    files.sort(function (a, b) {
      return a.path.localeCompare(b.path);
    });
    return files;
  }

  async function parseOuter(file) {
    outerZip = await JSZip.loadAsync(file);
    outerFileName = file.name || 'export.zip';
    parsed = [];
    var zipEntries = [];
    outerZip.forEach(function (_c, name) {
      if (name && !name.endsWith('/') && /\.zip$/i.test(name)) zipEntries.push(name);
    });
    zipEntries.sort();
    for (var i = 0; i < zipEntries.length; i++) {
      var en = zipEntries[i];
      var role = classifyOuterZipEntryName(en);
      if (!role) continue;
      var buf = await outerZip.file(en).async('arraybuffer');
      var inner = await JSZip.loadAsync(buf);
      var files = await buildInnerFileList(inner);
      parsed.push({ role: role, entryName: en, inner: inner, files: files });
    }
    parsed.sort(function (a, b) {
      return a.role.localeCompare(b.role);
    });
  }

  function renderPreview(tag) {
    var wrap = $('billing-preview-wrap');
    var body = $('billing-preview-body');
    if (!wrap || !body) return;
    body.innerHTML = '';
    if (!parsed.length) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    parsed.forEach(function (block) {
      var sec = document.createElement('section');
      sec.className =
        'rounded-xl border border-brand-border/80 bg-brand-dark/30 p-4 space-y-2';
      var h = document.createElement('h4');
      h.className = 'text-xs font-bold uppercase tracking-wider text-brand-accent';
      h.textContent = block.role + ' · ' + block.entryName + ' (' + block.files.length + ' files)';
      sec.appendChild(h);
      var ul = document.createElement('ul');
      ul.className = 'text-[11px] font-mono text-brand-muted max-h-40 overflow-y-auto space-y-0.5 pl-1';
      var max = 200;
      for (var j = 0; j < Math.min(block.files.length, max); j++) {
        var f = block.files[j];
        var li = document.createElement('li');
        li.textContent = '[' + f.dir.toUpperCase() + '] ' + f.path;
        ul.appendChild(li);
      }
      if (block.files.length > max) {
        var more = document.createElement('li');
        more.className = 'text-brand-muted italic';
        more.textContent = '… +' + (block.files.length - max) + ' more';
        ul.appendChild(more);
      }
      sec.appendChild(ul);
      var sub = document.createElement('p');
      sub.className = 'text-[10px] text-brand-muted';
      sub.textContent =
        'Target folders: ' +
        block.role +
        '/ARECO_ENERGY_' +
        tag +
        ' and ' +
        block.role +
        '/ARECO_ENERGY_SEIN_' +
        tag +
        ' (SEIN = path/name contains “SEIN”).';
      sec.appendChild(sub);
      body.appendChild(sec);
    });
  }

  async function pickDestination() {
    if (!supportsDirectoryPicker()) {
      setStatus(
        $('billing-export-status'),
        'Folder picker needs Chrome or Edge. Use “Download .zip” instead.',
        'warn'
      );
      return;
    }
    try {
      rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      var nameEl = $('billing-dest-name');
      if (nameEl) nameEl.textContent = rootHandle.name || '(folder selected)';
      setStatus($('billing-export-status'), 'Destination folder ready.', 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus($('billing-export-status'), (e && e.message) || 'Could not open folder.', 'err');
    }
  }

  async function writeTreeToHandle(tag) {
    if (!rootHandle) throw new Error('Choose a destination folder first.');
    for (var b = 0; b < parsed.length; b++) {
      var block = parsed[b];
      var top = await ensureDir(rootHandle, block.role);
      var energyDir = await ensureDir(top, 'ARECO_ENERGY_' + tag);
      var seinDir = await ensureDir(top, 'ARECO_ENERGY_SEIN_' + tag);
      for (var k = 0; k < block.files.length; k++) {
        var item = block.files[k];
        var targetRoot = item.dir === 'sein' ? seinDir : energyDir;
        var zf = block.inner.file(item.rawPath);
        if (!zf) continue;
        var blob = await zf.async('blob');
        await writeBlobToPath(targetRoot, item.path, blob);
      }
    }
  }

  async function buildOutputZip(tag) {
    var out = new JSZip();
    for (var b = 0; b < parsed.length; b++) {
      var block = parsed[b];
      for (var k = 0; k < block.files.length; k++) {
        var item = block.files[k];
        var prefix =
          block.role +
          '/' +
          (item.dir === 'sein' ? 'ARECO_ENERGY_SEIN_' : 'ARECO_ENERGY_') +
          tag +
          '/';
        var zf = block.inner.file(item.rawPath);
        if (!zf) continue;
        var u8 = await zf.async('uint8array');
        out.file(prefix + item.path, u8);
      }
    }
    return out.generateAsync({ type: 'blob' });
  }

  function getPeriodInputs() {
    var y = parseInt(($('billing-period-year') && $('billing-period-year').value) || '', 10);
    var m = parseInt(($('billing-period-month') && $('billing-period-month').value) || '', 10);
    if (!y || !m || m < 1 || m > 12) return null;
    return { year: y, month: m, tag: periodTag(y, m) };
  }

  async function onFileChosen(file) {
    var st = $('billing-parse-status');
    setStatus(st, 'Reading zip…', null);
    try {
      await parseOuter(file);
      if (parsed.length < 1) {
        setStatus(
          st,
          'No inner .zip files matched. Expected names containing ARECO (generator) and ARECOSS (load).',
          'warn'
        );
        $('billing-preview-wrap') && $('billing-preview-wrap').classList.add('hidden');
        return;
      }
      var roles = {};
      for (var i = 0; i < parsed.length; i++) roles[parsed[i].role] = true;
      var msg =
        'Found ' +
        parsed.length +
        ' inner archive(s): ' +
        Object.keys(roles).join(', ') +
        '.';
      if (!roles.ARECO || !roles.ARECOSS) {
        setStatus(st, msg + ' Tip: include both ARECO and ARECOSS inner zips when possible.', 'warn');
      } else setStatus(st, msg, 'ok');
      var p = getPeriodInputs();
      if (p) renderPreview(p.tag);
      else renderPreview('YYYYMMDD_YYYYMMDD');
    } catch (e) {
      setStatus(st, (e && e.message) || 'Failed to read zip.', 'err');
      parsed = [];
      $('billing-preview-wrap') && $('billing-preview-wrap').classList.add('hidden');
    }
  }

  async function runExport(useDownload) {
    var est = $('billing-export-status');
    if (!parsed.length) {
      setStatus(est, 'Load an outer zip first.', 'err');
      return;
    }
    var p = getPeriodInputs();
    if (!p) {
      setStatus(est, 'Set billing period (month the 25th falls in).', 'err');
      return;
    }
    renderPreview(p.tag);
    var btnDisk = $('billing-btn-export-disk');
    var btnZip = $('billing-btn-export-zip');
    var spin = $('billing-export-spinner');
    if (spin) spin.classList.remove('hidden');
    if (btnDisk) btnDisk.disabled = true;
    if (btnZip) btnZip.disabled = true;
    try {
      if (useDownload) {
        var blob = await buildOutputZip(p.tag);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download =
          'ARECO_billing_' +
          p.tag +
          '_' +
          (outerFileName.replace(/\.zip$/i, '') || 'export') +
          '.zip';
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(a.href);
        a.remove();
        setStatus(est, 'Download started.', 'ok');
      } else {
        await writeTreeToHandle(p.tag);
        setStatus(est, 'Files written under the folder you chose.', 'ok');
      }
    } catch (e) {
      setStatus(est, (e && e.message) || 'Export failed.', 'err');
    } finally {
      if (spin) spin.classList.add('hidden');
      if (btnDisk) btnDisk.disabled = false;
      if (btnZip) btnZip.disabled = false;
    }
  }

  function wire() {
    var yEl = $('billing-period-year');
    var mEl = $('billing-period-month');
    if (yEl && !yEl.value) {
      var now = new Date();
      yEl.value = String(now.getFullYear());
      if (mEl && !mEl.value) mEl.value = String(now.getMonth() + 1);
    }

    var fileInput = $('billing-file-zip');
    var btnPick = $('billing-btn-choose-zip');
    var drop = $('billing-drop-zip');
    var btnDest = $('billing-btn-choose-dest');
    var yearEl = $('billing-period-year');
    var monthEl = $('billing-period-month');

    if (btnPick && fileInput) {
      btnPick.addEventListener('click', function () {
        fileInput.click();
      });
    }
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        var nameEl = $('billing-zip-name');
        if (nameEl) nameEl.textContent = f ? f.name : 'No file selected';
        if (f) onFileChosen(f);
      });
    }
    if (drop && fileInput) {
      drop.addEventListener('click', function () {
        fileInput.click();
      });
      drop.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          fileInput.click();
        }
      });
      drop.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        drop.classList.add('border-brand-accent/50', 'bg-brand-dark/45');
      });
      drop.addEventListener('dragleave', function () {
        drop.classList.remove('border-brand-accent/50', 'bg-brand-dark/45');
      });
      drop.addEventListener('drop', function (ev) {
        ev.preventDefault();
        drop.classList.remove('border-brand-accent/50', 'bg-brand-dark/45');
        var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f && /\.zip$/i.test(f.name)) {
          var zn = $('billing-zip-name');
          if (zn) zn.textContent = f.name;
          onFileChosen(f);
        } else {
          setStatus($('billing-parse-status'), 'Drop a .zip file.', 'warn');
        }
      });
    }
    if (btnDest) btnDest.addEventListener('click', pickDestination);
    $('billing-btn-export-disk') &&
      $('billing-btn-export-disk').addEventListener('click', function () {
        runExport(false);
      });
    $('billing-btn-export-zip') &&
      $('billing-btn-export-zip').addEventListener('click', function () {
        runExport(true);
      });

    function refreshTagPreview() {
      if (!parsed.length) return;
      var p = getPeriodInputs();
      if (p) renderPreview(p.tag);
    }
    if (yearEl) yearEl.addEventListener('change', refreshTagPreview);
    if (monthEl) monthEl.addEventListener('change', refreshTagPreview);

    if (!supportsDirectoryPicker() && $('billing-fs-hint')) {
      $('billing-fs-hint').classList.remove('hidden');
      if (btnDest) btnDest.disabled = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else wire();
})();
