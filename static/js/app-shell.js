    (function initAppPanels() {
      var auth = typeof window !== 'undefined' && window.__ARECO_AUTH__;
      var allowed = {};
      if (auth && auth.panels && auth.panels.length) {
        auth.panels.forEach(function (p) { allowed[p] = 1; });
      } else {
        ['nomination', 'nomination-reporting', 'nomination-accuracy', 'billing', 'billing-history'].forEach(function (p) {
          allowed[p] = 1;
        });
      }
      var defaultPanel = (auth && auth.default_panel) || 'nomination';

      var panelNom = document.getElementById('panel-nomination');
      var panelReporting = document.getElementById('panel-nomination-reporting');
      var panelBill = document.getElementById('panel-billing');
      var panelAcc = document.getElementById('panel-nomination-accuracy');
      var panelBillHist = document.getElementById('panel-billing-history');
      var subtitleEl = document.getElementById('app-subtitle');
      var titles = {
        nomination: 'Nomination Dashboard',
        'nomination-reporting': 'Reporting',
        billing: 'Billing & Settlement',
        'nomination-accuracy': 'Forecast Percentage Error',
        'billing-history': 'Billing History'
      };
      var panelToSection = {
        nomination: 'nomination',
        'nomination-reporting': 'nomination',
        'nomination-accuracy': 'nomination',
        billing: 'billing',
        'billing-history': 'billing'
      };
      function setSectionExpanded(sectionRoot, expanded) {
        var toggle = sectionRoot.querySelector('[data-nav-section-toggle]');
        var region = sectionRoot.querySelector('.nav-section-subs');
        var chev = sectionRoot.querySelector('.nav-section-chevron');
        if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (region) {
          if (expanded) region.classList.remove('hidden');
          else region.classList.add('hidden');
        }
        if (chev) {
          if (expanded) chev.classList.remove('-rotate-90');
          else chev.classList.add('-rotate-90');
        }
      }
      function syncNavSectionsForPanel(panelId) {
        var activeSec = panelToSection[panelId] || 'nomination';
        document.querySelectorAll('[data-nav-section]').forEach(function(root) {
          var key = root.getAttribute('data-nav-section');
          setSectionExpanded(root, key === activeSec);
        });
      }
      var panelById = {
        nomination: panelNom,
        'nomination-reporting': panelReporting,
        billing: panelBill,
        'nomination-accuracy': panelAcc,
        'billing-history': panelBillHist
      };
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      function animatePanelIn(panelEl) {
        if (!panelEl || reduceMotion) return;
        panelEl.classList.remove('panel-enter');
        void panelEl.offsetWidth;
        panelEl.classList.add('panel-enter');
      }
      function showPanel(id) {
        if (!allowed[id]) id = defaultPanel;
        if (!allowed[id]) id = Object.keys(allowed)[0] || 'nomination';
        if (panelNom) panelNom.classList.toggle('hidden', id !== 'nomination');
        if (panelReporting) panelReporting.classList.toggle('hidden', id !== 'nomination-reporting');
        if (panelBill) panelBill.classList.toggle('hidden', id !== 'billing');
        if (panelAcc) panelAcc.classList.toggle('hidden', id !== 'nomination-accuracy');
        if (panelBillHist) panelBillHist.classList.toggle('hidden', id !== 'billing-history');
        document.querySelectorAll('[data-nav-panel]').forEach(function(btn) {
          var active = btn.getAttribute('data-nav-panel') === id;
          btn.setAttribute('aria-current', active ? 'page' : 'false');
        });
        if (subtitleEl) subtitleEl.textContent = titles[id] || titles.nomination;
        syncNavSectionsForPanel(id);
        animatePanelIn(panelById[id]);
        try { sessionStorage.setItem('areco_app_panel', id); } catch (e) {}
      }
      document.querySelectorAll('[data-nav-section-toggle]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var root = btn.closest('[data-nav-section]');
          if (!root) return;
          var expanded = btn.getAttribute('aria-expanded') === 'true';
          setSectionExpanded(root, !expanded);
        });
      });
      document.querySelectorAll('[data-nav-panel]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          showPanel(btn.getAttribute('data-nav-panel'));
        });
      });
      var saved = '';
      try { saved = sessionStorage.getItem('areco_app_panel') || ''; } catch (e2) {}
      if (saved && allowed[saved]) showPanel(saved);
      else showPanel(defaultPanel);
    })();

    (function confirmationModal() {
      var overlay = document.getElementById('confirmation-modal');
      var titleEl = document.getElementById('confirmation-modal-title');
      var bodyEl = document.getElementById('confirmation-modal-body');
      var cancelBtn = document.getElementById('confirmation-modal-cancel');
      var confirmBtn = document.getElementById('confirmation-modal-confirm');
      var currentOpts = {};

      function closeModal() {
        if (overlay) overlay.removeAttribute('open');
        if (overlay) overlay.style.display = 'none';
        currentOpts = {};
      }

      function openModal() {
        if (overlay) overlay.setAttribute('open', '');
        if (overlay) overlay.style.display = 'flex';
      }

      window.showConfirmationModal = function(opts) {
        opts = opts || {};
        currentOpts = opts;
        if (titleEl) titleEl.textContent = opts.title || 'Confirm';
        if (bodyEl) {
          if (typeof opts.body === 'string' && opts.body.indexOf('<') >= 0) bodyEl.innerHTML = opts.body;
          else bodyEl.textContent = opts.body != null ? opts.body : '';
        }
        if (confirmBtn) {
          confirmBtn.textContent = opts.confirmLabel != null ? opts.confirmLabel : 'Confirm';
          confirmBtn.style.display = '';
        }
        if (cancelBtn) {
          cancelBtn.style.display = opts.hideCancel ? 'none' : '';
          cancelBtn.textContent = opts.cancelLabel != null ? opts.cancelLabel : 'Cancel';
        }
        openModal();
      };

      function onConfirm() {
        if (typeof currentOpts.onConfirm === 'function') currentOpts.onConfirm();
        closeModal();
      }
      function onCancel() { closeModal(); }

      if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
      if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
      if (overlay) overlay.addEventListener('click', function(e) { if (e.target === overlay) onCancel(); });
    })();

    (function mobileMoreSheet() {
      var moreBtn = document.getElementById('mobile-more-btn');
      var sheet = document.getElementById('mobile-more-sheet');
      var backdrop = document.getElementById('mobile-more-backdrop');
      if (!moreBtn || !sheet || !backdrop) return;

      function openSheet() {
        sheet.classList.add('is-open');
        backdrop.classList.add('is-open');
        moreBtn.setAttribute('aria-expanded', 'true');
      }
      function closeSheet() {
        sheet.classList.remove('is-open');
        backdrop.classList.remove('is-open');
        moreBtn.setAttribute('aria-expanded', 'false');
      }
      moreBtn.addEventListener('click', function () {
        if (sheet.classList.contains('is-open')) closeSheet();
        else openSheet();
      });
      document.querySelectorAll('[data-mobile-sheet-close]').forEach(function (el) {
        el.addEventListener('click', closeSheet);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeSheet();
      });
    })();

    (function pwaShell() {
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
        });
      }
      var installBtn = document.getElementById('pwa-install-btn');
      var deferredPrompt = null;
      window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        if (installBtn) installBtn.hidden = false;
      });
      if (installBtn) {
        installBtn.addEventListener('click', function () {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          deferredPrompt.userChoice.finally(function () {
            deferredPrompt = null;
            installBtn.hidden = true;
          });
        });
      }
      window.addEventListener('appinstalled', function () {
        if (installBtn) installBtn.hidden = true;
      });
    })();
