(function initGridTicker() {
  var root = document.getElementById('grid-ticker');
  if (!root) return;

  var statusEl = document.getElementById('grid-ticker-status');
  var viewport = document.getElementById('grid-ticker-viewport');
  var track = document.getElementById('grid-ticker-track');
  var pop = document.getElementById('grid-ticker-pop');
  var popTitle = document.getElementById('grid-ticker-pop-title');
  var listEl = document.getElementById('grid-ticker-list');
  var sourceLink = document.getElementById('grid-ticker-source');
  var fetchedEl = document.getElementById('grid-ticker-fetched');

  var REFRESH_MS = 15000;       // browser poll; server asks IEMOP at most every 30 s
  var SHOW_MS = 60000;          // how long a new advisory stays up
  var GROUP_MS = 5 * 60000;     // advisories first seen within 5 min of the newest are shown together
  var MIN_PASSES = 2;           // a group stays up long enough to scroll past twice
  var SPEED_PX_PER_S = 70;
  var SHORT = { Luzon: 'LUZ', Visayas: 'VIS', Mindanao: 'MIN' };
  var LEVEL_TEXT = {
    NORMAL: 'Normal: supply and reserves sufficient.',
    BLUE: 'Blue alert: precaution for an expected typhoon/calamity.',
    YELLOW: 'Yellow alert: operating margin below the contingency requirement; no brownouts.',
    RED: 'Red alert: supply short of demand + regulating requirement; rotating brownouts possible.'
  };
  var lastSignature = '';
  var items = [];
  var clockOffsetMs = 0;
  var shownKey = '';
  var passMs = 0;
  var newsEl = document.getElementById('grid-ticker-news');
  var labelEl = document.getElementById('grid-ticker-label');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderStatus(regions) {
    statusEl.textContent = '';
    statusEl.appendChild(el('span', 'text-[10px] font-bold uppercase tracking-widest text-brand-muted mr-1', 'Grid'));
    regions.forEach(function (r) {
      var chip = el('span', 'alert-chip' + (r.is_plant_grid ? ' is-plant' : ''));
      chip.setAttribute('data-level', r.level || 'NORMAL');
      chip.setAttribute('data-state', r.state || '');
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(el('span', 'grid-name', r.region + (r.is_plant_grid ? ' · plant' : '')));
      chip.appendChild(el('span', '', r.label || r.level));
      var tip = [r.region + ': ' + (r.label || r.level), LEVEL_TEXT[r.level] || ''];
      if (r.capacity_mw && r.peak_mw) tip.push('Capacity ' + r.capacity_mw + ' MW · peak ' + r.peak_mw + ' MW (grid update ' + (r.updated || '').slice(11) + ')');
      chip.title = tip.filter(Boolean).join('\n');
      statusEl.appendChild(chip);
    });
  }

  function itemNode(it) {
    var n = el('span', 'ticker-item');
    if (it.level && it.level !== 'NORMAL') n.setAttribute('data-level', it.level);
    n.setAttribute('data-kind', it.kind || '');
    n.appendChild(el('span', 't', (it.time || '').slice(11)));
    n.appendChild(el('span', 'g', (it.region || '').split('/').map(function (r) { return SHORT[r] || r; }).join('/')));
    n.appendChild(el('span', '', it.text));
    return n;
  }

  // ---- "New advisories" strip --------------------------------------------------------
  // An advisory is new from the moment the server first saw it (first_seen), because IEMOP
  // publishes in batches long after the advisory time. Rules:
  //  - nothing first seen in the past minute (and no group still showing) -> strip hidden
  //  - one new advisory -> show just that one for SHOW_MS
  //  - several first seen within GROUP_MS of the newest -> show them all, scrolling, for
  //    max(SHOW_MS, MIN_PASSES full passes) so each one is readable, then hide again
  function serverNow() { return Date.now() + clockOffsetMs; }
  function seenMs(it) { return it.first_seen ? new Date(it.first_seen + '+08:00').getTime() : NaN; }

  function currentGroup() {
    var seen = items.filter(function (it) { return !isNaN(seenMs(it)); });
    if (!seen.length) return null;
    var newest = Math.max.apply(null, seen.map(seenMs));
    var group = seen.filter(function (it) { return seenMs(it) >= newest - GROUP_MS; });
    group.sort(function (x, y) { return (y.time || '').localeCompare(x.time || ''); });
    return { newest: newest, items: group, key: group.map(function (i) { return i.first_seen + i.text; }).join('|') };
  }

  function renderGroup(group) {
    track.textContent = '';
    labelEl.textContent = group.items.length === 1 ? 'New SO advisory' : group.items.length + ' new SO advisories';
    var single = group.items.length === 1;
    group.items.forEach(function (it) { track.appendChild(itemNode(it)); });
    track.style.animation = 'none';
    passMs = 0;
    requestAnimationFrame(function () {
      var width = track.scrollWidth;
      // A single advisory that fits stays still; anything wider (or a group) scrolls in a loop.
      if (single && width <= viewport.clientWidth) return;
      group.items.forEach(function (it) { track.appendChild(itemNode(it)); }); // 2nd copy for a seamless loop
      passMs = Math.max(8000, width / SPEED_PX_PER_S * 1000);
      track.style.setProperty('--ticker-duration', passMs / 1000 + 's');
      track.style.animation = '';
    });
  }

  function updateStrip() {
    var group = currentGroup();
    var visible = false;
    if (group) {
      if (group.key !== shownKey) {
        // Only start showing a group that is actually fresh (e.g. not one that expired before a reload).
        if (serverNow() - group.newest <= SHOW_MS) {
          shownKey = group.key;
          renderGroup(group);
          visible = true;
        }
      } else {
        var showFor = group.items.length === 1 ? SHOW_MS : Math.max(SHOW_MS, MIN_PASSES * passMs);
        visible = serverNow() < group.newest + showFor;
      }
    }
    newsEl.classList.toggle('hidden', !visible);
  }

  function renderList(items) {
    listEl.textContent = '';
    if (!items.length) {
      listEl.appendChild(el('li', 'py-2 text-brand-muted', 'No advisories loaded.'));
      return;
    }
    items.forEach(function (it) {
      var li = el('li', 'py-2 flex gap-3');
      var meta = el('div', 'shrink-0 w-24 text-brand-muted font-mono');
      meta.appendChild(el('div', '', (it.time || '').slice(5)));
      meta.appendChild(el('div', 'text-[10px] font-bold tracking-wider text-brand-accent', (it.region || '').toUpperCase()));
      var body = el('div', 'min-w-0 text-brand-text leading-relaxed', it.text);
      if (it.level && it.level !== 'NORMAL') {
        body.className += it.level === 'RED' ? ' text-rose-200' : it.level === 'YELLOW' ? ' text-amber-200' : ' text-blue-200';
      }
      if (it.kind === 'outage_unplanned') meta.appendChild(el('div', 'text-[10px] text-rose-300', 'UNPLANNED'));
      li.appendChild(meta);
      li.appendChild(body);
      listEl.appendChild(li);
    });
  }

  function render(data) {
    if (data.source_url && sourceLink) sourceLink.href = data.source_url;
    if (data.server_time) clockOffsetMs = new Date(data.server_time + '+08:00').getTime() - Date.now();
    if (fetchedEl) {
      fetchedEl.textContent = (data.fetched_at ? 'Last check ' + data.fetched_at.slice(11) + '.' : '') +
        (data.error ? ' ' + data.error : '');
    }
    if (!data.ok && !(data.regions || []).length) {
      statusEl.textContent = '';
      statusEl.appendChild(el('span', 'text-xs text-rose-300', 'Grid status unavailable'));
      statusEl.title = data.error || '';
      return;
    }
    items = data.items || [];
    var sig = JSON.stringify([data.regions, items.map(function (i) { return i.time + i.text; })]);
    if (sig !== lastSignature) {
      lastSignature = sig;
      renderStatus(data.regions || []);
      renderList(items);
    }
    updateStrip();
  }

  function load() {
    fetch('/api/so-advisories')
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        if (!lastSignature) render({ ok: false, error: 'Network error', regions: [], items: [] });
      });
  }

  function openPop(which) {
    pop.querySelectorAll('[data-ticker-section]').forEach(function (s) {
      s.classList.toggle('hidden', s.getAttribute('data-ticker-section') !== which);
    });
    popTitle.textContent = which === 'list' ? 'SO advisories (last 36 hours)' : 'Grid alert levels';
    pop.classList.remove('hidden');
  }
  function closePop() { pop.classList.add('hidden'); }

  root.querySelectorAll('[data-ticker-open]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var which = btn.getAttribute('data-ticker-open');
      var visible = !pop.classList.contains('hidden');
      var current = pop.querySelector('[data-ticker-section="' + which + '"]');
      if (visible && current && !current.classList.contains('hidden')) closePop();
      else openPop(which);
    });
  });
  statusEl.addEventListener('click', function () { openPop('levels'); });
  viewport.addEventListener('click', function () { openPop('list'); });
  document.getElementById('grid-ticker-pop-close').addEventListener('click', closePop);
  document.addEventListener('click', function (e) {
    if (!pop.classList.contains('hidden') && !root.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

  load();
  setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(updateStrip, 1000); // hide on time even between polls
})();
