(function () {
  var API_BASE = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
  var overlay = document.getElementById('settings-drawer-overlay');
  var panel = document.getElementById('settings-drawer-panel');
  var form = document.getElementById('settings-form');
  var statusEl = document.getElementById('settings-save-status');
  var openBtns = document.querySelectorAll('[data-open-settings]');

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'text-xs min-h-[1.25rem] ' + (isErr ? 'text-red-400' : 'text-brand-muted');
  }

  function openDrawer() {
    if (!overlay || !panel) return;
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function () {
      panel.classList.remove('translate-x-full');
    });
    loadConfig();
  }

  function closeDrawer() {
    if (!overlay || !panel) return;
    panel.classList.add('translate-x-full');
    setTimeout(function () {
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
    }, 200);
  }

  function loadConfig() {
    setStatus('Loading…', false);
    fetch(API_BASE + '/api/app-config')
      .then(function (r) {
        if (!r.ok) return Promise.reject(new Error(r.statusText));
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !data.values) {
          setStatus('Could not load settings.', true);
          return;
        }
        setStatus('', false);
        Object.keys(data.values).forEach(function (key) {
          var el = document.getElementById('cfg-' + key);
          if (el) el.value = data.values[key] != null ? String(data.values[key]) : '';
        });
      })
      .catch(function () {
        setStatus('Could not load settings. Is the server running?', true);
      });
  }

  openBtns.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      openDrawer();
    });
  });

  var closeBtn = document.getElementById('settings-drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeDrawer();
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var values = {};
      fd.forEach(function (v, k) {
        var s = typeof v === 'string' ? v.trim() : '';
        if (s !== '') values[k] = s;
      });
      setStatus('Saving…', false);
      var saveBtn = document.getElementById('settings-save-btn');
      if (saveBtn) saveBtn.disabled = true;
      fetch(API_BASE + '/api/app-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: values })
      })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok) throw new Error((j && j.error) || r.statusText);
            return j;
          });
        })
        .then(function (res) {
          if (res && res.ok) {
            setStatus('Saved. Restart the app if you changed the port.', false);
            loadConfig();
          } else {
            setStatus('Save failed.', true);
          }
        })
        .catch(function (err) {
          setStatus(err && err.message ? err.message : 'Save failed.', true);
        })
        .finally(function () {
          if (saveBtn) saveBtn.disabled = false;
        });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) closeDrawer();
  });
})();
