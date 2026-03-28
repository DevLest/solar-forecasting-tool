    (function initAppPanels() {
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
      function showPanel(id) {
        var valid = { nomination: 1, 'nomination-reporting': 1, billing: 1, 'nomination-accuracy': 1, 'billing-history': 1 };
        if (!valid[id]) id = 'nomination';
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
      if (saved === 'billing' || saved === 'nomination-reporting' || saved === 'nomination-accuracy' || saved === 'billing-history') showPanel(saved);
      else showPanel('nomination');
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
