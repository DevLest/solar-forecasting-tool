    (function initAppPanels() {
      var panelNom = document.getElementById('panel-nomination');
      var panelBill = document.getElementById('panel-billing');
      var panelAcc = document.getElementById('panel-nomination-accuracy');
      var subtitleEl = document.getElementById('app-subtitle');
      var titles = {
        nomination: 'WESM Nomination',
        billing: 'Billing & Invoice',
        'nomination-accuracy': 'Nomination accuracy'
      };
      function showPanel(id) {
        if (id !== 'billing' && id !== 'nomination-accuracy') id = 'nomination';
        if (panelNom) panelNom.classList.toggle('hidden', id !== 'nomination');
        if (panelBill) panelBill.classList.toggle('hidden', id !== 'billing');
        if (panelAcc) panelAcc.classList.toggle('hidden', id !== 'nomination-accuracy');
        document.querySelectorAll('[data-nav-panel]').forEach(function(btn) {
          var active = btn.getAttribute('data-nav-panel') === id;
          btn.setAttribute('aria-current', active ? 'page' : 'false');
        });
        if (subtitleEl) subtitleEl.textContent = titles[id] || titles.nomination;
        try { sessionStorage.setItem('areco_app_panel', id); } catch (e) {}
      }
      document.querySelectorAll('[data-nav-panel]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          showPanel(btn.getAttribute('data-nav-panel'));
        });
      });
      var saved = '';
      try { saved = sessionStorage.getItem('areco_app_panel') || ''; } catch (e2) {}
      if (saved === 'billing' || saved === 'nomination-accuracy') showPanel(saved);
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
