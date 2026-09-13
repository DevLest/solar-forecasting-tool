(function () {
  'use strict';

  var MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function isoFromYMD(y, m, d) {
    return y + '-' + pad2(m + 1) + '-' + pad2(d);
  }

  function todayIso() {
    var d = new Date();
    return isoFromYMD(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /**
   * Wrap a native <input type="date"> with a popover month-grid calendar, matching the
   * Reporting panel's picker design. The native input stays in the DOM (visually hidden) as
   * the single source of truth: existing code that reads/writes `.value`, sets `min`/`max`,
   * or listens for `input`/`change`/`blur` keeps working unmodified.
   */
  function attach(inputEl, options) {
    if (!inputEl || inputEl.__arecoCalPicker) return inputEl && inputEl.__arecoCalPicker;
    options = options || {};

    var wrap = document.createElement('div');
    wrap.className = 'acp-wrap relative inline-block ' + (options.wrapClass || '');
    inputEl.parentNode.insertBefore(wrap, inputEl);
    wrap.appendChild(inputEl);
    inputEl.classList.add('sr-only');
    inputEl.setAttribute('tabindex', '-1');
    inputEl.setAttribute('aria-hidden', 'true');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.className = options.btnClass ||
      'flex items-center gap-2 bg-brand-dark border border-brand-border rounded-lg px-3 py-1.5 text-sm font-mono text-brand-text hover:border-brand-accent/50 focus:outline-none focus:ring-2 focus:ring-brand-accent/40';
    btn.innerHTML =
      '<svg class="h-4 w-4 text-brand-muted shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
      '<path fill-rule="evenodd" d="M5.75 2a.75.75 0 01.75.75V4h7V2.75a.75.75 0 011.5 0V4h.5A2.75 2.75 0 0118.25 6.75v8.5A2.75 2.75 0 0115.5 18h-11A2.75 2.75 0 011.75 15.25v-8.5A2.75 2.75 0 014.5 4H5V2.75A.75.75 0 015.75 2zM3.25 8.5v6.75c0 .69.56 1.25 1.25 1.25h11c.69 0 1.25-.56 1.25-1.25V8.5H3.25z" clip-rule="evenodd" />' +
      '</svg>' +
      '<span class="acp-label"></span>';
    var labelEl = btn.querySelector('.acp-label');

    // The popover is appended to <body> (not `wrap`) and positioned with `fixed` coordinates
    // computed from the button's rect. That's deliberate: `wrap` often sits inside a card with
    // `overflow-y-auto`/`overflow-hidden` (e.g. the Forecast Ref card), which clips an
    // absolutely-positioned child regardless of z-index. A body-level, fixed-position popover
    // can't be clipped by an ancestor's overflow.
    var pop = document.createElement('div');
    pop.className = 'hidden fixed z-[95] w-72 rounded-xl border border-brand-border bg-brand-card shadow-2xl p-3';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML =
      '<div class="flex items-center justify-between mb-2">' +
      '<button type="button" class="acp-prev h-7 w-7 grid place-items-center rounded-md border border-brand-border hover:bg-brand-border/30 text-brand-muted" aria-label="Previous month">‹</button>' +
      '<span class="acp-month-label text-xs font-semibold text-brand-text"></span>' +
      '<button type="button" class="acp-next h-7 w-7 grid place-items-center rounded-md border border-brand-border hover:bg-brand-border/30 text-brand-muted" aria-label="Next month">›</button>' +
      '</div>' +
      '<div class="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-brand-muted mb-1">' +
      '<span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>' +
      '</div>' +
      '<div class="acp-grid grid grid-cols-7 gap-1"></div>' +
      (options.legendHtml
        ? '<div class="acp-legend mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-brand-muted border-t border-brand-border/60 pt-2">' + options.legendHtml + '</div>'
        : '');

    wrap.appendChild(btn);
    document.body.appendChild(pop);

    var gridEl = pop.querySelector('.acp-grid');
    var monthLabelEl = pop.querySelector('.acp-month-label');
    var prevBtn = pop.querySelector('.acp-prev');
    var nextBtn = pop.querySelector('.acp-next');

    var state = { year: new Date().getFullYear(), month: new Date().getMonth(), open: false };

    function currentValue() {
      return (inputEl.value || '').trim();
    }

    function updateLabel() {
      var v = currentValue();
      labelEl.textContent = v || (options.placeholder || '— Select day —');
    }

    function isDisabledIso(iso) {
      var minAttr = inputEl.getAttribute('min') || '';
      var maxAttr = inputEl.getAttribute('max') || '';
      if (minAttr && iso < minAttr) return true;
      if (maxAttr && iso > maxAttr) return true;
      if (typeof options.isDayDisabled === 'function' && options.isDayDisabled(iso)) return true;
      return false;
    }

    function renderGrid() {
      gridEl.innerHTML = '';
      monthLabelEl.textContent = MONTH_NAMES[state.month] + ' ' + state.year;
      var firstOfMonth = new Date(state.year, state.month, 1);
      var startWeekday = firstOfMonth.getDay();
      var daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
      var totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;
      var selected = currentValue();
      var todayStr = todayIso();
      for (var i = 0; i < totalCells; i++) {
        var dayNum = i - startWeekday + 1;
        var cell = document.createElement('button');
        cell.type = 'button';
        if (dayNum < 1 || dayNum > daysInMonth) {
          cell.className = 'h-8 opacity-0 pointer-events-none';
          cell.disabled = true;
          gridEl.appendChild(cell);
          continue;
        }
        var iso = isoFromYMD(state.year, state.month, dayNum);
        var disabled = isDisabledIso(iso);
        var isToday = iso === todayStr;
        var isSelected = iso === selected;
        var extra = typeof options.getDayClass === 'function'
          ? (options.getDayClass(iso, { isToday: isToday, isFuture: iso > todayStr, isPast: iso < todayStr }) || '')
          : '';
        var cls = 'relative h-8 rounded-md text-xs font-mono flex items-center justify-center transition-colors';
        if (disabled) {
          cls += ' opacity-30 cursor-not-allowed text-brand-muted';
        } else {
          cls += extra || ' text-brand-muted hover:bg-brand-border/30';
        }
        if (isSelected) cls += ' ring-2 ring-brand-accent';
        if (isToday) cls += ' font-bold underline underline-offset-2';
        cell.className = cls;
        cell.textContent = String(dayNum);
        var title = typeof options.getDayTitle === 'function' ? options.getDayTitle(iso) : iso;
        if (title) cell.title = title;
        cell.setAttribute('data-iso', iso);
        if (disabled) {
          cell.disabled = true;
        } else {
          cell.addEventListener('click', function () {
            selectDay(this.getAttribute('data-iso'));
          });
        }
        gridEl.appendChild(cell);
      }
    }

    function selectDay(iso) {
      setValueSilently(iso);
      close();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof options.onSelect === 'function') options.onSelect(iso);
    }

    function setValueSilently(iso) {
      inputEl.value = iso;
    }

    function positionPopover() {
      var rect = btn.getBoundingClientRect();
      var popWidth = pop.offsetWidth || 288;
      var popHeight = pop.offsetHeight || 320;
      var left = rect.left;
      var maxLeft = window.innerWidth - popWidth - 8;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      if (left < 8) left = 8;
      var top = rect.bottom + 4;
      if (top + popHeight > window.innerHeight - 8 && rect.top - popHeight - 4 >= 8) {
        top = rect.top - popHeight - 4; // flip above the button if there's no room below
      }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }

    function onReflow() {
      close();
    }

    function open() {
      var v = currentValue() ||
        (typeof options.getInitialMonth === 'function' && options.getInitialMonth()) ||
        todayIso();
      var parts = v.split('-');
      if (parts.length === 3) {
        state.year = parseInt(parts[0], 10);
        state.month = parseInt(parts[1], 10) - 1;
      }
      renderGrid();
      pop.classList.remove('hidden');
      positionPopover();
      state.open = true;
      btn.setAttribute('aria-expanded', 'true');
      // Reposition would drift out of sync with a scrolling ancestor; simplest robust fix is to
      // close on scroll (capture=true catches scrolling inside nested overflow containers too).
      window.addEventListener('scroll', onReflow, true);
      window.addEventListener('resize', onReflow);
    }

    function close() {
      pop.classList.add('hidden');
      state.open = false;
      btn.setAttribute('aria-expanded', 'false');
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    }

    function toggle() {
      if (inputEl.disabled) return;
      if (state.open) close();
      else open();
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle();
    });
    prevBtn.addEventListener('click', function () {
      state.month -= 1;
      if (state.month < 0) {
        state.month = 11;
        state.year -= 1;
      }
      renderGrid();
    });
    nextBtn.addEventListener('click', function () {
      state.month += 1;
      if (state.month > 11) {
        state.month = 0;
        state.year += 1;
      }
      renderGrid();
    });
    document.addEventListener('click', function (e) {
      if (!state.open) return;
      if (wrap.contains(e.target) || pop.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (state.open && e.key === 'Escape') close();
    });

    // Let a <label for="..."> pointing at the (now hidden) input open the picker instead of
    // trying to focus it.
    if (inputEl.id) {
      var lbl = document.querySelector('label[for="' + inputEl.id + '"]');
      if (lbl) {
        lbl.addEventListener('click', function (e) {
          e.preventDefault();
          toggle();
        });
      }
    }

    // Keep the button label (and an open grid) in sync whenever ANYTHING sets `.value`
    // programmatically elsewhere in the app (e.g. restoring a saved forecast), without that
    // code having to know the picker exists.
    (function wrapValueProperty() {
      var proto = Object.getPrototypeOf(inputEl);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (!desc || !desc.set || !desc.get) return;
      Object.defineProperty(inputEl, 'value', {
        configurable: true,
        get: function () {
          return desc.get.call(inputEl);
        },
        set: function (v) {
          desc.set.call(inputEl, v);
          updateLabel();
          if (state.open) renderGrid();
        }
      });
    })();

    updateLabel();

    var controller = {
      buttonEl: btn,
      wrapEl: wrap,
      refresh: function () {
        updateLabel();
        if (state.open) renderGrid();
      },
      open: open,
      close: close,
      getValue: currentValue,
      setValue: function (iso) {
        selectDay(iso);
      }
    };
    inputEl.__arecoCalPicker = controller;
    return controller;
  }

  window.ArecoCalendarPicker = { attach: attach };
})();
