(function () {
  var KEY = 'areco_viewer_active_tab_v1';

  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel) || []); }

  function setActiveTab(tabId) {
    var btns = all('.viewer-tab-btn[data-viewer-tab]');
    var panels = all('[data-viewer-tabpanel]');
    if (!tabId) tabId = 'nomination';

    btns.forEach(function (b) {
      var isOn = b.getAttribute('data-viewer-tab') === tabId;
      b.setAttribute('aria-selected', isOn ? 'true' : 'false');
      b.className = 'viewer-tab-btn px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wide border border-transparent transition-all duration-150 ' + (isOn
        ? 'bg-brand-accent/20 text-brand-accent border-brand-accent/40 shadow-sm'
        : 'text-brand-muted hover:text-brand-text hover:bg-brand-border/25');
    });

    panels.forEach(function (p) {
      var on = p.getAttribute('data-viewer-tabpanel') === tabId;
      if (on) p.classList.remove('hidden');
      else p.classList.add('hidden');
    });

    try { localStorage.setItem(KEY, tabId); } catch (e) {}

    // Charts often need a resize event after becoming visible.
    try { window.dispatchEvent(new Event('resize')); } catch (e2) {}
  }

  function loadTab() {
    try {
      var t = localStorage.getItem(KEY);
      if (t) return t;
    } catch (e) {}
    return 'nomination';
  }

  function init() {
    all('.viewer-tab-btn[data-viewer-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        setActiveTab(b.getAttribute('data-viewer-tab') || 'nomination');
      });
    });

    // Ensure sidebar-panel containers aren't stuck hidden from their original layout.
    ['panel-nomination-reporting', 'panel-nomination-accuracy', 'panel-billing-history'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('hidden');
    });

    setActiveTab(loadTab());
  }

  window.addEventListener('DOMContentLoaded', init);
})();

