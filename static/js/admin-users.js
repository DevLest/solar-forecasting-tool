(function () {
  var auth = typeof window !== 'undefined' && window.__ARECO_AUTH__;
  if (!auth || !auth.can_edit_settings) return;

  var API_BASE =
    typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : '';
  var tbody = document.getElementById('admin-users-tbody');
  var statusEl = document.getElementById('admin-users-status');
  var addForm = document.getElementById('admin-users-add-form');
  var newName = document.getElementById('admin-users-new-name');
  var newPass = document.getElementById('admin-users-new-pass');
  var newRole = document.getElementById('admin-users-new-role');
  var addBtn = document.getElementById('admin-users-add-btn');

  var rolesCache = ['admin', 'nominator', 'spectator'];

  function setStatus(msg, isErr) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className =
      'text-xs min-h-[1.25rem] ' + (isErr ? 'text-rose-300/95' : 'text-brand-muted');
  }

  function fillRoleSelects(roles) {
    if (roles && roles.length) rolesCache = roles;
    if (newRole) {
      newRole.innerHTML = rolesCache
        .map(function (r) {
          return '<option value="' + r + '">' + r + '</option>';
        })
        .join('');
    }
  }

  function rowRoleOptions(selected) {
    return rolesCache
      .map(function (r) {
        return '<option value="' + r + '"' + (r === selected ? ' selected' : '') + '>' + r + '</option>';
      })
      .join('');
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderTable(users, currentUser) {
    if (!tbody) return;
    tbody.innerHTML = '';
    (users || []).forEach(function (u) {
      var tr = document.createElement('tr');
      tr.className = 'border-b border-brand-border/40';
      var uname = u.username || '';
      var isSelf = currentUser && uname === currentUser;
      tr.innerHTML =
        '<td class="py-2 px-2 font-mono text-xs text-brand-text">' +
        escapeAttr(uname) +
        (isSelf ? ' <span class="text-[10px] text-brand-muted">(you)</span>' : '') +
        '</td>' +
        '<td class="py-2 px-2">' +
        '<select data-au-username="' +
        escapeAttr(uname) +
        '" data-au-field="role" class="au-row-role w-full max-w-[9rem] bg-brand-dark border border-brand-border rounded px-1.5 py-1 text-[11px] text-brand-text [color-scheme:dark]">' +
        rowRoleOptions(u.role || 'nominator') +
        '</select></td>' +
        '<td class="py-2 px-2 whitespace-nowrap space-x-1">' +
        '<input type="password" data-au-username="' +
        escapeAttr(uname) +
        '" data-au-field="password" autocomplete="new-password" placeholder="New password" class="w-[6.5rem] bg-brand-dark border border-brand-border rounded px-1.5 py-1 text-[10px] text-brand-text placeholder:text-brand-muted/70" />' +
        '<button type="button" class="au-save py-1 px-2 rounded border border-brand-accent/50 bg-brand-accent/15 text-brand-accent text-[10px] font-bold uppercase" data-au-username="' +
        escapeAttr(uname) +
        '">Save</button>' +
        '<button type="button" class="au-del py-1 px-2 rounded border border-rose-500/35 text-rose-200 text-[10px] font-bold uppercase' +
        (isSelf ? ' opacity-40 cursor-not-allowed' : '') +
        '" data-au-username="' +
        escapeAttr(uname) +
        '"' +
        (isSelf ? ' disabled' : '') +
        '>Del</button>' +
        '</td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.au-save').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var un = btn.getAttribute('data-au-username');
        if (!un) return;
        var row = btn.closest('tr');
        if (!row) return;
        var sel = row.querySelector('select[data-au-field="role"]');
        var pw = row.querySelector('input[data-au-field="password"]');
        var body = { role: sel ? sel.value : undefined };
        if (pw && pw.value && pw.value.trim()) body.password = pw.value;
        setStatus('Saving…', false);
        btn.disabled = true;
        fetch(API_BASE + '/api/admin/users/' + encodeURIComponent(un), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok, j: j };
            });
          })
          .then(function (x) {
            if (!x.j || !x.j.ok) throw new Error((x.j && x.j.error) || 'Save failed');
            if (pw) pw.value = '';
            setStatus('User updated.', false);
            if (x.j.users) renderTable(x.j.users, auth.username);
          })
          .catch(function (e) {
            setStatus(e.message || 'Save failed', true);
          })
          .finally(function () {
            btn.disabled = false;
          });
      });
    });

    tbody.querySelectorAll('.au-del').forEach(function (btn) {
      if (btn.disabled) return;
      btn.addEventListener('click', function () {
        var un = btn.getAttribute('data-au-username');
        if (!un) return;
        if (!window.confirm('Delete user "' + un + '"?')) return;
        setStatus('Deleting…', false);
        btn.disabled = true;
        fetch(API_BASE + '/api/admin/users/' + encodeURIComponent(un), { method: 'DELETE' })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok, j: j };
            });
          })
          .then(function (x) {
            if (!x.j || !x.j.ok) throw new Error((x.j && x.j.error) || 'Delete failed');
            setStatus('User deleted.', false);
            if (x.j.users) renderTable(x.j.users, auth.username);
          })
          .catch(function (e) {
            setStatus(e.message || 'Delete failed', true);
          })
          .finally(function () {
            btn.disabled = false;
          });
      });
    });
  }

  window.loadAdminUsers = function () {
    if (!tbody) return;
    setStatus('Loading users…', false);
    fetch(API_BASE + '/api/admin/users')
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (x) {
        if (!x.j || !x.j.ok) throw new Error((x.j && x.j.error) || 'Could not load users');
        if (x.j.roles) fillRoleSelects(x.j.roles);
        renderTable(x.j.users, auth.username);
        setStatus('', false);
      })
      .catch(function (e) {
        setStatus(e.message || 'Could not load users', true);
      });
  };

  if (addForm) {
    fillRoleSelects(null);
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var u = newName ? newName.value.trim() : '';
      var p = newPass ? newPass.value : '';
      var r = newRole ? newRole.value : 'nominator';
      if (!u) {
        setStatus('Username is required.', true);
        return;
      }
      if (addBtn) addBtn.disabled = true;
      setStatus('Creating user…', false);
      fetch(API_BASE + '/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p, role: r }),
      })
        .then(function (res) {
          return res.json().then(function (j) {
            return { ok: res.ok, j: j };
          });
        })
        .then(function (x) {
          if (!x.j || !x.j.ok) throw new Error((x.j && x.j.error) || 'Create failed');
          if (newName) newName.value = '';
          if (newPass) newPass.value = '';
          setStatus('User created.', false);
          if (x.j.users) renderTable(x.j.users, auth.username);
        })
        .catch(function (err) {
          setStatus(err.message || 'Create failed', true);
        })
        .finally(function () {
          if (addBtn) addBtn.disabled = false;
        });
    });
  }
})();
