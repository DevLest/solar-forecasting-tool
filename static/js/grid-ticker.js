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
  var TICKER_HOURS = 12;        // the running text shows advisories from the last 12 hours
  var TICKER_MAX = 20;
  var SPEED_PX_PER_S = 70;
  var NEW_MS = 60 * 60000;      // in the "All" list, advisories first seen in the last hour are marked new
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
  var tickerKey = '';
  var labelEl = document.getElementById('grid-ticker-label');
  var newCountEl = document.getElementById('grid-ticker-new-count');
  var listNewKey = '';

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
    var n = el('span', 'ticker-item' + (isNew(it) ? ' is-new' : ''));
    if (isNew(it)) n.appendChild(el('span', 'so-new-badge', 'NEW'));
    n.setAttribute('data-kind', it.kind || '');
    n.appendChild(el('span', 't', (it.time || '').slice(11)));
    n.appendChild(el('span', 'g', (it.region || '').split('/').map(function (r) { return SHORT[r] || r; }).join('/')));
    n.appendChild(el('span', '', it.text));
    return n;
  }

  // ---- Running text ---------------------------------------------------------------------
  // Always scrolls the plant grid's advisories from the last TICKER_HOURS (newest first): white,
  // or yellow with a NEW badge while new. "New" is judged by when the server first saw the
  // advisory (first_seen), because IEMOP publishes in batches long after the advisory time.
  function serverNow() { return Date.now() + clockOffsetMs; }
  function seenMs(it) { return it.first_seen ? new Date(it.first_seen + '+08:00').getTime() : NaN; }
  function timeMs(it) { return it.time ? new Date(it.time.replace(' ', 'T') + ':00+08:00').getTime() : NaN; }

  function tickerItems() {
    var cutoff = serverNow() - TICKER_HOURS * 3600000;
    return items.filter(function (it) { return timeMs(it) >= cutoff || isNew(it); }).slice(0, TICKER_MAX);
  }

  function updateStrip() {
    var list = tickerItems();
    var newCount = list.filter(isNew).length;
    var key = list.map(function (it) { return it.time + it.text + (isNew(it) ? '*' : ''); }).join('|');
    if (key === tickerKey) return; // unchanged: keep the animation running smoothly
    tickerKey = key;

    labelEl.textContent = newCount ? (newCount === 1 ? 'New SO advisory' : newCount + ' new SO advisories') : 'SO advisories';
    labelEl.className = 'shrink-0 pl-3 pr-1 text-[10px] font-bold uppercase tracking-widest ' +
      (newCount ? 'text-yellow-400' : 'text-brand-muted');
    track.textContent = '';
    track.style.animation = 'none';
    if (!list.length) {
      track.appendChild(el('span', 'ticker-item', 'No Visayas advisories in the last ' + TICKER_HOURS + ' hours.'));
      return;
    }
    list.forEach(function (it) { track.appendChild(itemNode(it)); });
    requestAnimationFrame(function () {
      var width = track.scrollWidth;
      if (width <= viewport.clientWidth) return; // fits: no need to scroll
      list.forEach(function (it) { track.appendChild(itemNode(it)); }); // 2nd copy for a seamless loop
      var passMs = Math.max(8000, width / SPEED_PX_PER_S * 1000);
      track.style.setProperty('--ticker-duration', passMs / 1000 + 's');
      track.style.animation = '';
    });
  }

  function isNew(it) {
    var t = seenMs(it);
    return !isNaN(t) && serverNow() - t <= NEW_MS;
  }

  // All advisories in white; ones first seen within NEW_MS in yellow with a NEW badge.
  function renderList(items) {
    listEl.textContent = '';
    var newCount = 0;
    if (!items.length) {
      listEl.appendChild(el('li', 'py-2 text-brand-muted', 'No Visayas advisories in the last 36 hours.'));
    }
    items.forEach(function (it) {
      var fresh = isNew(it);
      if (fresh) newCount++;
      var li = el('li', 'so-item py-2 px-2 -mx-2 rounded flex gap-3' + (fresh ? ' is-new' : ''));
      var meta = el('div', 'shrink-0 w-24 text-brand-muted font-mono');
      meta.appendChild(el('div', '', (it.time || '').slice(5)));
      meta.appendChild(el('div', 'text-[10px] font-bold tracking-wider text-brand-accent', (it.region || '').toUpperCase()));
      if (fresh) meta.appendChild(el('span', 'so-new-badge mt-0.5', 'NEW'));
      if (it.level && it.level !== 'NORMAL') {
        var tag = el('div', 'so-level-tag', it.level + (it.kind === 'alert_lifted' ? ' LIFTED' : ' ALERT'));
        tag.setAttribute('data-level', it.level);
        meta.appendChild(tag);
      }
      if (it.kind === 'outage_unplanned') meta.appendChild(el('div', 'text-[10px] text-rose-300', 'UNPLANNED'));
      li.appendChild(meta);
      li.appendChild(el('div', 'min-w-0 leading-relaxed', it.text));
      listEl.appendChild(li);
    });
    if (newCountEl) {
      newCountEl.textContent = newCount ? newCount + ' new' : '';
      newCountEl.classList.toggle('hidden', !newCount);
    }
    listNewKey = listKey();
  }

  // Re-render when an item's "new" state changes (it ages out after NEW_MS).
  function listKey() {
    return items.map(function (it) { return isNew(it) ? 1 : 0; }).join('');
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
  setInterval(function () {
    updateStrip(); // re-colour advisories as they stop being new, even between polls
    if (listKey() !== listNewKey) renderList(items);
  }, 1000);
})();
