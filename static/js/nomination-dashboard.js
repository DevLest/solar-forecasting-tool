    /** Use current page origin so save/history/weather work when opening from another device (e.g. http://HOST_IP:8765). */
    var API_BASE = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';

    const STORAGE_KEY = 'areco_forecast_import';
    const LIVE_STREAM_STORAGE_KEY = 'areco_live_stream_url';
    const WEATHER_LOCATION_KEY = 'areco_weather_location';
    var weatherLocation = { lat: 10.638755644610793, lon: 123.00417639451439 };
    const DEFAULT_LIVE_STREAM_URL = 'https://vdo.ninja/?view=2vNAR9X';
    const PLANT_MAX_MW = 50;
    function clampMw(v) {
      var n = Number(v);
      if (isNaN(n) || n < 0) return 0;
      return Math.min(PLANT_MAX_MW, Math.round(n * 1000) / 1000);
    }

    /** Minutes since midnight for interval label "HH:MM" (hour 0–23, or 24:00 = end of day). */
    function intervalLabelToMinutes(s) {
      if (!s || typeof s !== 'string') return NaN;
      var parts = s.trim().split(':');
      var h = parseInt(parts[0], 10);
      var m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
      if (h === 24 && (isNaN(m) || m === 0)) return 24 * 60;
      if (isNaN(h) || h < 0 || h > 23) return NaN;
      if (isNaN(m)) m = 0;
      return h * 60 + m;
    }

    function todayIsoLocal() {
      var d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /** Local Date at interval end (label = end of 5-minute slot) on the given forecast ref day. */
    function intervalEndLocalDate(refIso, intervalStr) {
      if (!refIso || !/^\d{4}-\d{2}-\d{2}$/.test(refIso)) return null;
      var p = refIso.split('-');
      var y = parseInt(p[0], 10), mo = parseInt(p[1], 10), day = parseInt(p[2], 10);
      var s = (intervalStr || '').trim();
      if (/^24:00$/.test(s)) return new Date(y, mo - 1, day + 1, 0, 0, 0, 0);
      var mins = intervalLabelToMinutes(intervalStr);
      if (isNaN(mins)) return null;
      var hh = Math.floor(mins / 60);
      var mm = mins % 60;
      return new Date(y, mo - 1, day, hh, mm, 0, 0);
    }

    /**
     * RTD cell editable: past forecast calendar day = all locked; future forecast day = all editable;
     * today = editable only while interval end is still in the future (past intervals locked).
     */
    function isIntervalRtdEditable(intervalStr, now) {
      now = now || new Date();
      var refIso = getForecastRefDateString();
      if (!refIso) return true;
      var today = todayIsoLocal();
      if (refIso < today) return false;
      if (refIso > today) return true;
      var end = intervalEndLocalDate(refIso, intervalStr);
      if (!end || isNaN(end.getTime())) return true;
      return now.getTime() < end.getTime();
    }

    function updateRtdIntervalLocks() {
      var refIso = getForecastRefDateString();
      var today = todayIsoLocal();
      document.querySelectorAll('.interval-data-tbody tr.interval-row').forEach(function(tr) {
        var intervalStr = tr.getAttribute('data-interval') || '';
        var inp = tr.querySelector('.rtd-input');
        if (!inp) return;
        var editable = isIntervalRtdEditable(intervalStr, new Date());
        inp.readOnly = !editable;
        var lockTitle = 'Locked';
        if (!editable) {
          if (refIso && refIso < today) lockTitle = 'Locked: Forecast Ref is before today';
          else lockTitle = 'Locked: interval already ended for today’s date';
        }
        inp.title = editable ? ('RTD (MW), interval end ' + intervalStr) : lockTitle;
        tr.classList.toggle('interval-row-rtd-locked', !editable);
      });
    }
    window.updateRtdIntervalLocks = updateRtdIntervalLocks;

    const IDB_NAME = 'arecoSolarDB';
    const IDB_STORE = 'forecast';
    const IDB_KEY = 'main';

    const hours = Array.from({ length: 25 }, (_, i) => i);
    let nomData = [0,0,0,0,0,0,4,12,16,20,22,22,20,18,12,8,4,0,0,0,0,0,0,0,0];
    let weatherData = Array(25).fill(0);
    let weatherSummaryText = '';
    let weatherDateStr = '';
    var intervalsData = [];
    var selectedInterval = null;
    var rtdData = Array(25).fill(0);
    var historicalExportsList = [];

    function idbOpen() {
      return new Promise(function(resolve, reject) {
        var r = indexedDB.open(IDB_NAME, 1);
        r.onerror = function() { reject(r.error); };
        r.onsuccess = function() { resolve(r.result); };
        r.onupgradeneeded = function(e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        };
      });
    }
    function idbPut(payload) {
      return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.oncomplete = function() { resolve(); };
          tx.onerror = function() { reject(tx.error); };
          var row = Object.assign({ id: IDB_KEY }, payload);
          tx.objectStore(IDB_STORE).put(row);
        });
      });
    }
    function idbGet() {
      return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var q = tx.objectStore(IDB_STORE).get(IDB_KEY);
          q.onsuccess = function() { resolve(q.result || null); };
          q.onerror = function() { reject(q.error); };
        });
      }).catch(function() { return null; });
    }

    /** Read forecast ref date from the date picker (YYYY-MM-DD). */
    function getForecastRefDateString() {
      var el = document.getElementById('forecast-ref-date');
      return el ? (el.value || '').trim() : '';
    }

    /** Parse any date string to YYYY-MM-DD for the date input (handles legacy "Month dd, YYYY" from storage). */
    function toIsoDateString(str) {
      if (!str || typeof str !== 'string') return '';
      var s = str.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      var d = new Date(s);
      if (isNaN(d.getTime())) return '';
      var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    }

    /** Format date for display as "Month dd, YYYY" (e.g. March 16, 2026). */
    function formatDateForDisplay(isoOrAny) {
      if (!isoOrAny || typeof isoOrAny !== 'string') return '';
      var d = new Date(isoOrAny.trim());
      if (isNaN(d.getTime())) return isoOrAny;
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    function showPersistHint() {
      var el = document.getElementById('persist-hint');
      if (!el) return;
      if (location.protocol === 'file:') {
        el.classList.remove('hidden');
        el.textContent = 'Open via http://127.0.0.1:8765 (python run_dashboard.py) so imports persist after refresh. file:// often blocks storage.';
      } else {
        el.classList.add('hidden');
        if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
          el.classList.remove('hidden');
          el.textContent = 'Using server at ' + API_BASE + ' — save and history work from this device.';
        }
      }
    }

    function normalizeNum(v) {
      if (v == null || v === '') return NaN;
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
      return isNaN(n) ? NaN : n;
    }

    function findPredictedPowerColumn(headers) {
      const lower = headers.map(function(h) { return String(h || '').toLowerCase().trim(); });
      // Prefer column that explicitly says predicted power / day-ahead (Column B in typical files)
      const preferred = lower.findIndex(function(s) {
        return (s.indexOf('predicted') >= 0 && (s.indexOf('power') >= 0 || s.indexOf('mw') >= 0)) ||
          (s.indexOf('day') >= 0 && s.indexOf('ahead') >= 0) ||
          s === 'power' || s === 'mw' || s === 'power (mw)' || s === 'predicted power' || s === 'day ahead (mw)';
      });
      if (preferred >= 0) return preferred;
      // Among power/mw/forecast columns, prefer one that suggests "predicted" or "day ahead"
      const powerLike = lower.map(function(s, i) { return /power|mw|forecast/i.test(s) ? i : -1; }).filter(function(i) { return i >= 0; });
      for (let j = 0; j < powerLike.length; j++) {
        const idx = powerLike[j];
        const s = lower[idx];
        if (s.indexOf('predicted') >= 0 || (s.indexOf('day') >= 0 && s.indexOf('ahead') >= 0) || s.indexOf('short term') >= 0) return idx;
      }
      return powerLike.length ? powerLike[0] : headers.findIndex(function(h) { return /power|mw|forecast/i.test(String(h || '')); });
    }

    function findTimeColumn(headers, powerCol) {
      const timeLike = ['time', 'date', 'datetime', 'hour', 'interval', 'timestamp', 'period'];
      for (let i = 0; i < headers.length; i++) {
        const s = String(headers[i] || '').toLowerCase();
        if (i !== powerCol && timeLike.some(function(t) { return s.indexOf(t) >= 0; })) return i;
      }
      return powerCol === 0 ? 1 : 0;
    }

    /** Parse hour (0-24) from datetime string. Uses only explicit time (HH:MM), never date parts like day 16. */
    function parseHourFromDatetime(s) {
      var str = String(s || '').trim();
      if (!str) return NaN;
      var hour = NaN;
      var afterT = str.indexOf('T') >= 0 ? str.split('T')[1] : null;
      if (afterT) {
        var hm = afterT.match(/^(\d{1,2}):(\d{2})/);
        if (hm) hour = parseInt(hm[1], 10);
      }
      if (isNaN(hour)) {
        var parts = str.split(/\s+/);
        var timePart = parts.length > 1 ? parts[parts.length - 1] : null;
        if (timePart && /^\d{1,2}:\d{2}/.test(timePart)) {
          var hm2 = timePart.match(/^(\d{1,2}):(\d{2})/);
          if (hm2) hour = parseInt(hm2[1], 10);
        }
      }
      if (isNaN(hour)) {
        var anyTime = str.match(/(\d{1,2}):(\d{2})/);
        if (anyTime) hour = parseInt(anyTime[1], 10);
      }
      return (hour >= 0 && hour <= 24) ? hour : NaN;
    }

    /** Try to parse a date from a filename (e.g. VRE_NOM_Plant_2026-03-16.csv or report_20260316.csv). Returns Date or null. */
    function parseDateFromFilename(filename) {
      if (!filename || typeof filename !== 'string') return null;
      var s = filename.replace(/\.[^.]*$/, ''); // strip extension
      // YYYY-MM-DD or YYYY_MM_DD
      var iso = s.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
      if (iso) {
        var d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
        if (!isNaN(d.getTime())) return d;
      }
      // YYYYMMDD (8 digits)
      var compact = s.match(/(\d{4})(\d{2})(\d{2})/);
      if (compact) {
        var d2 = new Date(parseInt(compact[1], 10), parseInt(compact[2], 10) - 1, parseInt(compact[3], 10));
        if (!isNaN(d2.getTime())) return d2;
      }
      // DD-MM-YYYY or DD_MM_YYYY (day first when 01-31)
      var dmy = s.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4})/);
      if (dmy) {
        var day = parseInt(dmy[1], 10), month = parseInt(dmy[2], 10) - 1, year = parseInt(dmy[3], 10);
        if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
          var d3 = new Date(year, month, day);
          if (!isNaN(d3.getTime())) return d3;
        }
      }
      return null;
    }

    /** Get interval label (HH:MM) from datetime. Uses only explicit time, never date. */
    function intervalLabelFromDatetime(s) {
      var str = String(s || '').trim();
      if (!str) return null;
      var afterT = str.indexOf('T') >= 0 ? str.split('T')[1] : null;
      if (afterT) {
        var hm = afterT.match(/^(\d{1,2}):(\d{2})/);
        if (hm) return (hm[1].length === 1 ? '0' + hm[1] : hm[1]) + ':' + hm[2];
      }
      var parts = str.split(/\s+/);
      var timePart = parts.length > 1 ? parts[parts.length - 1] : null;
      if (timePart && /^\d{1,2}:\d{2}/.test(timePart)) {
        var hm2 = timePart.match(/^(\d{1,2}):(\d{2})/);
        if (hm2) return (hm2[1].length === 1 ? '0' + hm2[1] : hm2[1]) + ':' + hm2[2];
      }
      var anyTime = str.match(/(\d{1,2}):(\d{2})/);
      if (anyTime) return (anyTime[1].length === 1 ? '0' + anyTime[1] : anyTime[1]) + ':' + anyTime[2];
      return null;
    }

    function parseCsv(text) {
      const lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
      if (lines.length < 2) return [];
      const headers = lines[0].split(/[,;\t]/).map(function(c) { return c.trim().replace(/^["']|["']$/g, ''); });
      const powerCol = findPredictedPowerColumn(headers);
      const timeCol = findTimeColumn(headers, powerCol);
      if (powerCol < 0) return [];
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(/[,;\t]/).map(function(c) { return c.trim().replace(/^["']|["']$/g, ''); });
        const power = normalizeNum(cells[powerCol]);
        if (isNaN(power)) continue;
        const timeStr = cells[timeCol] || '';
        var hour = parseHourFromDatetime(timeStr);
        if (isNaN(hour) || hour < 0 || hour > 24) hour = rows.length;
        rows.push({ hour: hour, value: clampMw(power), timeLabel: timeStr || null });
      }
      return rows;
    }

    function parseXls(buffer) {
      if (typeof XLSX === 'undefined') return [];
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) return [];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (data.length < 2) return [];
      const headers = data[0].map(function(c) { return String(c || '').trim(); });
      const powerCol = findPredictedPowerColumn(headers);
      const timeCol = findTimeColumn(headers, powerCol);
      if (powerCol < 0) return [];
      const rows = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const power = normalizeNum(row[powerCol]);
        if (isNaN(power)) continue;
        const timeVal = row[timeCol];
        let timeLabel = '';
        let hour = NaN;
        if (timeVal instanceof Date) {
          hour = timeVal.getHours();
          var min = timeVal.getMinutes();
          timeLabel = (hour < 10 ? '0' + hour : '' + hour) + ':' + (min < 10 ? '0' + min : '' + min);
        } else if (typeof timeVal === 'number' && timeVal > 1) {
          var d = new Date((timeVal - 25569) * 86400 * 1000);
          if (!isNaN(d.getTime())) {
            hour = d.getHours();
            var min = d.getMinutes();
            timeLabel = (hour < 10 ? '0' + hour : '' + hour) + ':' + (min < 10 ? '0' + min : '' + min);
          }
        }
        if (isNaN(hour)) {
          timeLabel = String(timeVal || '');
          hour = parseHourFromDatetime(timeLabel);
        }
        if (isNaN(hour) || hour < 0 || hour > 24) hour = rows.length;
        rows.push({ hour: hour, value: clampMw(power), timeLabel: timeLabel || null });
      }
      return rows;
    }

    function rowsToHourlyAndIntervals(rows) {
      const hourly = Array(25).fill(0);
      const byHour = {};
      rows.forEach(function(r) {
        const h = Math.min(24, Math.max(0, Math.floor(r.hour)));
        if (!byHour[h]) byHour[h] = [];
        byHour[h].push(r.value);
      });
      for (let h = 0; h <= 24; h++) {
        if (byHour[h] && byHour[h].length) {
          const sum = byHour[h].reduce(function(a, b) { return a + b; }, 0);
          hourly[h] = Math.round((sum / byHour[h].length) * 1000) / 1000;
        }
      }
      const intervals = rows.map(function(r, i) {
        const h = Math.min(24, Math.max(0, Math.floor(r.hour)));
        var intervalStr = intervalLabelFromDatetime(r.timeLabel);
        if (!intervalStr) {
          var mmMatch = r.timeLabel && String(r.timeLabel).match(/:(\d{2})/);
          var mm = mmMatch ? mmMatch[1] : (i < 12 ? String(i * 5).padStart(2, '0') : '00');
          intervalStr = (h < 10 ? '0' + h : String(h)) + ':' + mm;
        }
        return { interval: intervalStr, dayAhead: r.value, rtd: 0 };
      });
      return { hourly: hourly, intervals: intervals };
    }

    function applyForecastToSystem(payload) {
      if (payload.nomination && payload.nomination.length) {
        nomData = payload.nomination.length === 25 ? payload.nomination.slice() : payload.nomination.slice(0, 25);
        while (nomData.length < 25) nomData.push(0);
        nomData = nomData.map(clampMw);
      }
      if (payload.weatherHourly && payload.weatherHourly.length >= 25) {
        weatherData = payload.weatherHourly.slice(0, 25).map(clampMw);
        while (weatherData.length < 25) weatherData.push(0);
      }
      if (payload.weatherSummary != null) weatherSummaryText = String(payload.weatherSummary);
      if (payload.weatherDate) weatherDateStr = String(payload.weatherDate);
      if (typeof chart !== 'undefined' && chart.data && chart.data.datasets) {
        chart.data.datasets[0].data = nomData;
        chart.data.datasets[1].data = weatherData.slice();
        updateRtdChartSeries();
      }
      var ws = document.getElementById('weather-summary');
      if (ws && weatherSummaryText) ws.textContent = weatherSummaryText;
      if (payload.forecastRefDate && document.getElementById('forecast-ref-date')) {
        var dateInput = document.getElementById('forecast-ref-date');
        var iso = toIsoDateString(payload.forecastRefDate) || payload.forecastRefDate;
        var today = dateInput.getAttribute('min') || (new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0'));
        if (iso) dateInput.value = iso < today ? today : iso;
      }
      var percentInp = document.getElementById('percent-value');
      if (percentInp && payload.rtdPercent != null) {
        var p = Math.min(200, Math.max(1, Math.round(Number(payload.rtdPercent))));
        percentInp.value = p;
      }
      var mode = payload.rtdForecastMode;
      if (mode && typeof mode === 'string') {
        var radio = document.querySelector('input[name="forecast"][value="' + mode + '"]');
        if (radio) radio.checked = true;
      }
      if (payload.intervalRev != null) {
        var revSpan = document.getElementById('interval-rev-number');
        if (revSpan) {
          var r = Math.max(1, Math.min(999, parseInt(payload.intervalRev, 10) || 1));
          revSpan.textContent = r;
        }
      }
      if (payload.weatherCondition != null && document.getElementById('ops-weather-condition')) {
        document.getElementById('ops-weather-condition').value = String(payload.weatherCondition);
      }
      if (payload.revisionReason != null && document.getElementById('ops-revision-reason')) {
        document.getElementById('ops-revision-reason').value = String(payload.revisionReason);
      }
      if (payload.traderDuty != null && document.getElementById('ops-trader-duty')) {
        var tdEl = document.getElementById('ops-trader-duty');
        var tdv = String(payload.traderDuty);
        if (tdv === 'DR Cosas') tdv = 'DR COSAS';
        tdEl.value = tdv;
      }
      /** Full day: each hour HH has HH:05…HH:55 plus (HH+1):00 (last closes as 24:00). */
      function getFixedIntervalSlotsFullDay() {
        var slots = [];
        function pad2(n) { return (n < 10 ? '0' : '') + n; }
        for (var h = 0; h < 24; h++) {
          for (var mm = 5; mm < 60; mm += 5) {
            slots.push(pad2(h) + ':' + pad2(mm));
          }
          slots.push(h === 23 ? '24:00' : pad2(h + 1) + ':00');
        }
        return slots;
      }
      function normalizeIntervalStr(s) {
        if (!s || typeof s !== 'string') return '';
        var t = s.trim();
        if (/^24\s*:\s*00$/i.test(t)) return '24:00';
        var p = t.split(':');
        var h = parseInt(p[0], 10);
        var m = p.length > 1 ? parseInt(p[1], 10) : 0;
        if (isNaN(h)) return '';
        if (h === 24) return '24:00';
        if (h < 0 || h > 23) return '';
        return (h < 10 ? '0' + h : '' + h) + ':' + (isNaN(m) ? '00' : (m < 10 ? '0' + m : '' + m));
      }
      var fixedSlots = getFixedIntervalSlotsFullDay();
      var lookup = {};
      if (payload.intervals && payload.intervals.length) {
        payload.intervals.forEach(function(r) {
          var k = normalizeIntervalStr(r.interval);
          if (k) lookup[k] = { dayAhead: r.dayAhead, rtd: r.rtd };
        });
      }
      intervalsData = fixedSlots.map(function(slot) {
        var d = lookup[slot];
        return {
          interval: slot,
          dayAhead: d && d.dayAhead != null ? d.dayAhead : 0,
          rtd: d && d.rtd != null ? d.rtd : 0
        };
      });
      const tbody = document.querySelector('.interval-data-tbody');
      if (tbody && intervalsData.length) {
        tbody.innerHTML = intervalsData.map(function(row) {
          var dayAhead = typeof row.dayAhead === 'number' ? row.dayAhead.toFixed(3) : (row.dayAhead != null ? row.dayAhead : '0');
          var rtd = row.rtd != null ? Number(row.rtd) : 0;
          rtd = isNaN(rtd) ? 0 : clampMw(rtd);
          return '<tr class="interval-row hover:bg-brand-border/20 transition-colors" data-interval="' + (row.interval || '') + '"><td class="interval-cell-time">' + (row.interval || '') + '</td><td class="text-right pr-3 day-ahead-cell">' + dayAhead + '</td><td class="text-right"><input type="number" class="rtd-input bg-brand-dark border border-brand-border rounded text-right font-mono" min="0" max="50" step="0.001" value="' + rtd + '"/></td></tr>';
        }).join('');
        attachIntervalRowHandlers();
        populateIntervalHourFilter();
      }
      if (payload.plantNameForVreExport && document.getElementById('vre-plant-name')) {
        document.getElementById('vre-plant-name').value = payload.plantNameForVreExport;
      }
      renderVreTable();
    }

    function intervalsToDayAheadCurve(intervals) {
      var curve = Array(25).fill(0);
      if (!intervals || !intervals.length) return curve;
      var byHour = {};
      intervals.forEach(function(row) {
        var interval = row.interval || '';
        var parts = interval.split(':');
        var h = parseInt(parts[0], 10);
        if (isNaN(h) || h < 0 || h > 24) return;
        if (!byHour[h]) byHour[h] = [];
        byHour[h].push(clampMw(Number(row.dayAhead) || 0));
      });
      for (var h = 0; h <= 24; h++) {
        if (byHour[h] && byHour[h].length) {
          var sum = byHour[h].reduce(function(a, b) { return a + b; }, 0);
          curve[h] = Math.round((sum / byHour[h].length) * 1000) / 1000;
        }
      }
      return curve;
    }

    function intervalsToRtdCurve(intervals) {
      var curve = Array(25).fill(0);
      if (!intervals || !intervals.length) return curve;
      var byHour = {};
      intervals.forEach(function(row) {
        var interval = row.interval || '';
        var parts = interval.split(':');
        var h = parseInt(parts[0], 10);
        if (isNaN(h) || h < 0 || h > 24) return;
        if (!byHour[h]) byHour[h] = [];
        byHour[h].push(clampMw(Number(row.rtd) || 0));
      });
      for (var h = 0; h <= 24; h++) {
        if (byHour[h] && byHour[h].length) {
          var sum = byHour[h].reduce(function(a, b) { return a + b; }, 0);
          curve[h] = Math.round((sum / byHour[h].length) * 1000) / 1000;
        }
      }
      return curve;
    }

    /** Returns { low, mid, high } 25-point curves for shadow reference lines. P10 = percent×0.1, P50 = percent×0.5, P90 = percent×0.9. */
    function getLowMidHighCurves() {
      var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
      var dayAheadHourly = (intervals && intervals.length) ? intervalsToDayAheadCurve(intervals) : nomData.slice();
      var percentInp = document.getElementById('percent-value');
      var pct = percentInp ? parseFloat(percentInp.value) : 100;
      if (isNaN(pct) || pct <= 0) pct = 100;
      var low = dayAheadHourly.map(function(v) { return clampMw(v * (pct * 0.9) / 100); });
      var mid = dayAheadHourly.map(function(v) { return clampMw(v * (pct * 1.0) / 100); });
      var high = dayAheadHourly.map(function(v) { return clampMw(v * (pct * 1.1) / 100); });
      return { low: low, mid: mid, high: high };
    }

    function updateShadowCurves() {
      var curves = getLowMidHighCurves();
      if (typeof chart !== 'undefined' && chart.data && chart.data.datasets.length >= 5) {
        chart.data.datasets[2].data = curves.low.slice();
        chart.data.datasets[3].data = curves.mid.slice();
        chart.data.datasets[4].data = curves.high.slice();
      }
    }

    function updateRtdChartSeries() {
      var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
      rtdData = intervalsToRtdCurve(intervals);
      updateShadowCurves();
      if (typeof chart !== 'undefined' && chart.data && chart.data.datasets.length >= 6) {
        chart.data.datasets[5].data = rtdData.slice();
        chart.update();
      }
    }

    function getIntervalsFromTable() {
      var rows = document.querySelectorAll('.interval-data-tbody tr.interval-row');
      var out = [];
      rows.forEach(function(tr) {
        var interval = tr.getAttribute('data-interval') || '';
        var dayAheadCell = tr.querySelector('.day-ahead-cell') || (tr.querySelectorAll('td')[1]);
        var dayAhead = dayAheadCell ? parseFloat(dayAheadCell.textContent) : 0;
        if (isNaN(dayAhead)) dayAhead = 0;
        var rtdIn = tr.querySelector('.rtd-input');
        var rtd = rtdIn ? clampMw(parseFloat(rtdIn.value) || 0) : 0;
        out.push({ interval: interval, dayAhead: dayAhead, rtd: rtd });
      });
      return out;
    }

    /** Multipliers for Low/Mid/High: P10 = percent×0.1, P50 = percent×0.5, P90 = percent×0.9. */
    var MODE_MULTIPLIER = { low: 0.9, mid: 1.0, high: 1.1, custom: 1.0 };

    /** Fill RTD from Day Ahead using: (percentage × mode multiplier). P10=×0.1, P50=×0.5, P90=×0.9. Custom: do not overwrite RTD inputs. */
    function applyPercentageToRtd() {
      var percentInp = document.getElementById('percent-value');
      var pct = percentInp ? parseFloat(percentInp.value) : NaN;
      if (isNaN(pct) || pct <= 0) return;
      var modeEl = document.querySelector('input[name="forecast"]:checked');
      var mode = modeEl ? modeEl.value : 'custom';
      if (mode === 'custom') {
        var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
        rtdData = intervalsToRtdCurve(intervals);
        updateShadowCurves();
        if (typeof chart !== 'undefined' && chart.data && chart.data.datasets.length >= 6) {
          chart.data.datasets[5].data = rtdData.slice();
          chart.update();
        }
        return;
      }
      var mult = MODE_MULTIPLIER[mode] != null ? MODE_MULTIPLIER[mode] : 1;
      var effectivePct = (pct * mult) / 100;
      var rows = document.querySelectorAll('.interval-data-tbody tr.interval-row');
      rows.forEach(function(tr) {
        var intervalStr = tr.getAttribute('data-interval') || '';
        if (!isIntervalRtdEditable(intervalStr)) return;
        var dayAheadCell = tr.querySelector('.day-ahead-cell') || (tr.querySelectorAll('td')[1]);
        var dayAhead = dayAheadCell ? parseFloat(dayAheadCell.textContent) : 0;
        if (isNaN(dayAhead)) dayAhead = 0;
        var rtdIn = tr.querySelector('.rtd-input');
        if (rtdIn) {
          var rtdVal = clampMw(dayAhead * effectivePct);
          rtdIn.value = rtdVal;
        }
      });
      intervalsData = getIntervalsFromTable();
      saveForecastLocally({ intervals: intervalsData });
      updateRtdChartSeries();
      if (window.updateNavbarTimeAndInterval) window.updateNavbarTimeAndInterval();
    }

    function applyIntervalFilter() {
      var sel = document.getElementById('interval-hour-filter');
      var hour = (sel && sel.value) ? sel.value : 'all';
      var nextHour00 = hour !== 'all' && hour !== '24' ? (String(parseInt(hour, 10) + 1).padStart(2, '0') + ':00') : '';
      document.querySelectorAll('.interval-data-tbody tr.interval-row').forEach(function(tr) {
        var interval = tr.getAttribute('data-interval') || '';
        var match = false;
        if (hour === 'all') match = true;
        else if (hour === '24') match = interval === '24:00';
        else match = interval.indexOf(hour + ':') === 0 || interval === nextHour00;
        tr.style.display = match ? '' : 'none';
      });
    }

    /** Rebuild hour filter from interval rows (00–23 plus 24 when 24:00 exists). */
    function populateIntervalHourFilter() {
      try {
        var sel = document.getElementById('interval-hour-filter');
        if (!sel) return;
        var rows = document.querySelectorAll('.interval-data-tbody tr.interval-row');
        var hours = {};
        for (var i = 0; i < rows.length; i++) {
          var interval = (rows[i].getAttribute && rows[i].getAttribute('data-interval')) || '';
          if (interval === '24:00') {
            hours['24'] = true;
            continue;
          }
          var part = (interval.split(':')[0] || '').trim();
          if (part && /^\d{1,2}$/.test(part)) hours[('0' + part).slice(-2)] = true;
        }
        var hourList = Object.keys(hours).sort(function(a, b) {
          var na = a === '24' ? 24 : parseInt(a, 10);
          var nb = b === '24' ? 24 : parseInt(b, 10);
          return na - nb;
        });
        var currentVal = sel.value;
        sel.innerHTML = '<option value="all">All</option>' + hourList.map(function(h) { return '<option value="' + h + '">' + h + '</option>'; }).join('');
        if (currentVal !== 'all' && hourList.indexOf(currentVal) === -1) sel.value = 'all';
        else if (hourList.indexOf(currentVal) !== -1) sel.value = currentVal;
        applyIntervalFilter();
      } catch (e) {}
    }

    function attachIntervalRowHandlers() {
      document.querySelectorAll('.interval-data-tbody .interval-row').forEach(function(row) {
        row.addEventListener('click', function() {
          document.querySelectorAll('.interval-data-tbody .interval-row').forEach(function(r) {
            r.classList.remove('interval-row-active');
            r.querySelectorAll('td').forEach(function(td) { td.classList.remove('text-brand-accent', 'font-bold'); });
          });
          this.classList.add('interval-row-active');
          this.querySelectorAll('td').forEach(function(td) { td.classList.add('text-brand-accent', 'font-bold'); });
          selectedInterval = this.getAttribute('data-interval');
        });
        var rtdIn = row.querySelector('.rtd-input');
        if (rtdIn) {
          rtdIn.addEventListener('change', function() {
            var v = clampMw(parseFloat(this.value) || 0);
            this.value = v;
            intervalsData = getIntervalsFromTable();
            saveForecastLocally({ intervals: intervalsData });
            updateRtdChartSeries();
            renderVreTable();
            if (window.updateNavbarTimeAndInterval) window.updateNavbarTimeAndInterval();
          });
          rtdIn.addEventListener('input', function() {
            var v = parseFloat(this.value);
            if (!isNaN(v) && (v < 0 || v > PLANT_MAX_MW)) return;
            intervalsData = getIntervalsFromTable();
            updateRtdChartSeries();
            if (window.updateNavbarTimeAndInterval) window.updateNavbarTimeAndInterval();
          });
        }
      });
      var firstActive = document.querySelector('.interval-data-tbody .interval-row-active');
      selectedInterval = firstActive ? firstActive.getAttribute('data-interval') : (intervalsData[0] && intervalsData[0].interval);
      if (!intervalsData.length) intervalsData = getIntervalsFromTable();
      updateRtdChartSeries();
      renderVreTable();
      applyIntervalFilter();
      if (typeof updateRtdIntervalLocks === 'function') updateRtdIntervalLocks();
      if (window.updateNavbarTimeAndInterval) window.updateNavbarTimeAndInterval();
    }

    function buildPersistPayload(extra) {
      extra = extra || {};
      var intervals = extra.intervals && extra.intervals.length ? extra.intervals : (getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData);
      var percentEl = document.getElementById('percent-value');
      var percentVal = percentEl && !isNaN(parseFloat(percentEl.value)) ? Math.round(parseFloat(percentEl.value)) : 100;
      var modeEl = document.querySelector('input[name="forecast"]:checked');
      var modeVal = modeEl ? modeEl.value : 'custom';
      var vrePlantEl = document.getElementById('vre-plant-name');
      var plantNameForVre = (vrePlantEl && vrePlantEl.value && vrePlantEl.value.trim()) ? vrePlantEl.value.trim() : '';
      var revEl = document.getElementById('interval-rev-number');
      var revNum = (revEl && revEl.textContent) ? (parseInt(revEl.textContent, 10) || 1) : 1;
      revNum = Math.max(1, Math.min(999, revNum));
      if (extra.intervalRev != null) revNum = Math.max(1, Math.min(999, parseInt(extra.intervalRev, 10) || 1));
      var weatherCondEl = document.getElementById('ops-weather-condition');
      var revisionReasonEl = document.getElementById('ops-revision-reason');
      var traderEl = document.getElementById('ops-trader-duty');
      return {
        forecastRefDate: extra.forecastRefDate || getForecastRefDateString(),
        nomination: extra.nomination || nomData.slice(),
        intervals: intervals,
        rtdPercent: extra.rtdPercent != null ? extra.rtdPercent : percentVal,
        rtdForecastMode: extra.rtdForecastMode != null ? extra.rtdForecastMode : modeVal,
        intervalRev: extra.intervalRev != null ? extra.intervalRev : revNum,
        weatherHourly: extra.weatherHourly != null ? extra.weatherHourly : weatherData.slice(),
        weatherSummary: extra.weatherSummary != null ? extra.weatherSummary : weatherSummaryText,
        weatherDate: extra.weatherDate != null ? extra.weatherDate : weatherDateStr,
        weatherCondition: extra.weatherCondition != null ? extra.weatherCondition : (weatherCondEl ? weatherCondEl.value : ''),
        revisionReason: extra.revisionReason != null ? extra.revisionReason : (revisionReasonEl ? revisionReasonEl.value : ''),
        traderDuty: extra.traderDuty != null ? extra.traderDuty : (traderEl ? traderEl.value : ''),
        plantNameForVreExport: extra.plantNameForVreExport != null ? extra.plantNameForVreExport : plantNameForVre,
        savedAt: new Date().toISOString()
      };
    }

    function saveForecastLocally(payload) {
      var full = buildPersistPayload(payload);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(full)); } catch (e) {}
      idbPut(full).catch(function() {});
      try { sessionStorage.setItem(STORAGE_KEY + '_ram', JSON.stringify(full)); } catch (e) {}
    }

    function applyStoredRecord(data) {
      if (!data) return;
      var hasImport = data.nomination && data.nomination.length;
      var hasIntervals = data.intervals && data.intervals.length;
      var hasWeather = data.weatherHourly && data.weatherHourly.length;
      if (!hasImport && !hasIntervals && !hasWeather) return;
      applyForecastToSystem(data);
    }

    var shadowCurves = getLowMidHighCurves();
    const chart = new Chart(document.getElementById('nominationChart').getContext('2d'), {
      type: 'line',
      data: {
        labels: hours,
        datasets: [
          { label: 'Import (CSV)', data: nomData, borderColor: '#10b981', borderWidth: 2, pointRadius: 0, fill: { target: 'origin', above: 'rgba(16, 185, 129, 0.05)' }, tension: 0.4 },
          { label: 'Weather', data: weatherData.slice(), borderColor: '#f59e0b', borderWidth: 2, borderDash: [4, 4], pointRadius: 0, fill: false, tension: 0.4 },
          { label: 'Low (P10)', data: shadowCurves.low.slice(), borderColor: 'rgba(56, 189, 248, 0.7)', borderWidth: 1, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0.4 },
          { label: 'Mid (P50)', data: shadowCurves.mid.slice(), borderColor: 'rgba(148, 163, 184, 0.6)', borderWidth: 1, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0.4 },
          { label: 'High (P90)', data: shadowCurves.high.slice(), borderColor: 'rgba(253, 186, 116, 0.7)', borderWidth: 1, borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0.4 },
          { label: 'RTD', data: rtdData.slice(), borderColor: '#a78bfa', borderWidth: 2, pointRadius: 0, fill: false, tension: 0.4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min: 0, max: PLANT_MAX_MW, grid: { color: 'rgba(51, 65, 85, 0.3)' }, ticks: { color: '#94a3b8', font: { size: 9 } }, title: { display: true, text: 'MW (max 50)', color: '#94a3b8', font: { size: 10 } } },
          x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 9 } }, title: { display: true, text: 'Hour', color: '#94a3b8', font: { size: 10 } } }
        }
      }
    });

    (function syncNominationChartSize() {
      var canvas = document.getElementById('nominationChart');
      var section = canvas && canvas.closest('section');
      if (!section || typeof ResizeObserver === 'undefined') {
        requestAnimationFrame(function() { chart.resize(); });
        return;
      }
      var ro = new ResizeObserver(function() { chart.resize(); });
      ro.observe(section);
      requestAnimationFrame(function() { chart.resize(); });
    })();

    document.querySelectorAll('input[name="forecast"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        applyPercentageToRtd();
      });
    });

    document.getElementById('percent-value').addEventListener('change', function() {
      var p = parseFloat(this.value);
      if (isNaN(p) || p < 1 || p > 200) {
        this.value = 100;
      } else {
        this.value = Math.round(p);
      }
      applyPercentageToRtd();
    });
    document.getElementById('percent-value').addEventListener('input', function() {
      var p = parseFloat(this.value);
      if (!isNaN(p) && p >= 1 && p <= 200) applyPercentageToRtd();
    });

    var RESOURCE_MRID = '06VISTASOL_G01';
    var MARKET_PARTICIPANT_MRID = 'ARECO_01';
    var PLT_CODE_VRE = '06_VISTASOL_G01';
    var DEPENDABLE_CAPACITY_MW = 50.1;

    function escapeXml(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }

    function formatDateTime(date) {
      var y = date.getFullYear();
      var m = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      var h = String(date.getHours()).padStart(2, '0');
      var min = String(date.getMinutes()).padStart(2, '0');
      var sec = String(date.getSeconds()).padStart(2, '0');
      return y + '-' + m + '-' + d + 'T' + h + ':' + min + ':' + sec;
    }

    /** ISO timestamp for MessageHeader: YYYY-MM-DDTHH:mm:ss.000Z */
    function formatTimeDateZ(date) {
      var y = date.getFullYear();
      var m = String(date.getMonth() + 1).padStart(2, '0');
      var d = String(date.getDate()).padStart(2, '0');
      var h = String(date.getHours()).padStart(2, '0');
      var min = String(date.getMinutes()).padStart(2, '0');
      var sec = String(date.getSeconds()).padStart(2, '0');
      return y + '-' + m + '-' + d + 'T' + h + ':' + min + ':' + sec + '.000Z';
    }

    /** Nomination interval time: YYYY-MM-DDTHH:mm:ss.000+08:00 */
    function formatNominationTime(y, m, d, hour, minute, second) {
      var yy = String(y);
      var mm = String(m).padStart(2, '0');
      var dd = String(d).padStart(2, '0');
      var hh = String(hour).padStart(2, '0');
      var min = String(minute).padStart(2, '0');
      var ss = String(second).padStart(2, '0');
      return yy + '-' + mm + '-' + dd + 'T' + hh + ':' + min + ':' + ss + '.000+08:00';
    }

    /** Hourly average (VRE_NOM) per hour 1–24 from Day Ahead intervals. */
    function getVreHourlyAverages() {
      var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
      var byHour = {};
      for (var h = 1; h <= 24; h++) byHour[h] = [];
      intervals.forEach(function(row) {
        var interval = (row.interval || '').trim();
        var parts = interval.split(':');
        var hour = parseInt(parts[0], 10);
        var minute = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        if (hour === 24 && minute === 0) {
          byHour[24].push(clampMw(Number(row.dayAhead) || 0));
          return;
        }
        if (hour >= 0 && hour <= 23) {
          var deliveryHour = hour === 0 ? 24 : hour;
          byHour[deliveryHour].push(clampMw(Number(row.dayAhead) || 0));
        }
      });
      var out = [];
      for (var h = 1; h <= 24; h++) {
        var vals = byHour[h];
        var avg = (vals && vals.length) ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length : 0;
        out.push({ deliveryHour: h, vreNom: Math.round(avg * 10) / 10 });
      }
      return out;
    }

    /** 5-minute columns within each delivery hour (display matrix only). */
    var VRE_MINUTE_COLUMNS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

    /** Interval map for Day Ahead MW only — same key rules as nomination export lookup. */
    function getDayAheadLookupForDisplay() {
      var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
      var map = {};
      intervals.forEach(function(row) {
        var interval = (row.interval || '').trim();
        var parts = interval.split(':');
        var hour = parseInt(parts[0], 10);
        var minute = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        if (isNaN(minute)) minute = 0;
        var val = clampMw(Number(row.dayAhead) || 0);
        if (hour === 24 && minute === 0) {
          map['24,0'] = val;
          return;
        }
        if (isNaN(hour) || hour < 0 || hour > 23) return;
        map[hour + ',' + minute] = val;
      });
      return map;
    }

    function getDayAheadMwAt(map, clockHour, minuteOfHour) {
      if (minuteOfHour === 60) {
        if (clockHour === 23 && map['24,0'] != null) return map['24,0'];
        return map[clockHour + ',55'] != null ? map[clockHour + ',55'] : (map[clockHour + ',0'] != null ? map[clockHour + ',0'] : 0);
      }
      return map[clockHour + ',' + minuteOfHour] != null ? map[clockHour + ',' + minuteOfHour] : 0;
    }

    /** Delivery hour 1–24 → clock hour in interval keys (matches getVreHourlyAverages: hour 0 → delivery 24). */
    function deliveryHourToClockHour(dh) {
      return dh === 24 ? 0 : dh;
    }

    function formatMinuteMwForVreGrid(n) {
      var x = Number(n);
      if (!isFinite(x)) return '';
      if (x === 0) return '0';
      var s = x.toFixed(3);
      s = s.replace(/0+$/, '');
      s = s.replace(/\.$/, '');
      return s;
    }

    function getVreDeliveryDate() {
      var refStr = getForecastRefDateString();
      var d = refStr ? new Date(refStr) : new Date();
      if (isNaN(d.getTime())) d = new Date();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      var y = d.getFullYear();
      return m + '/' + day + '/' + y;
    }

    function renderVreTable() {
      var tbody = document.getElementById('vre-tbody');
      if (!tbody) return;
      var vreRows = getVreHourlyAverages();
      var daMap = getDayAheadLookupForDisplay();
      tbody.innerHTML = vreRows.map(function(r) {
        var clockH = deliveryHourToClockHour(r.deliveryHour);
        var hourCell = '<td class="vre-col-hour">' + String(r.deliveryHour) + '</td>';
        var vreCell = '<td class="vre-col-vre">' + String(r.vreNom) + '</td>';
        var dataCells = VRE_MINUTE_COLUMNS.map(function(min) {
          var mw = getDayAheadMwAt(daMap, clockH, min);
          var isZero = mw === 0;
          var cls = 'vre-col-mw' + (isZero ? ' vre-cell-zero' : '');
          return '<td class="' + cls + '">' + formatMinuteMwForVreGrid(mw) + '</td>';
        }).join('');
        return '<tr>' + hourCell + vreCell + dataCells + '</tr>';
      }).join('');
    }

    function buildVreCsvContent() {
      var vreRows = getVreHourlyAverages();
      var deliveryDate = getVreDeliveryDate();
      var lines = ['PLT_CODE,DELIVERY_DATE,DELIVERY_HOUR,UNIT_NO,VRE_NOM, DEPENDABLE_CAPACITY'];
      vreRows.forEach(function(r) {
        lines.push([PLT_CODE_VRE, deliveryDate, r.deliveryHour, 1, r.vreNom, DEPENDABLE_CAPACITY_MW].join(','));
      });
      lines.push('EOF,,,,,');
      return lines.join('\r\n');
    }

    /** Build lookup (hour, minute) -> MW from table/intervals; used for export. Export always 00:00–23:59. Uses RTD when set, else Day Ahead so export is not all zeros after import. */
    function getRtdLookupForExport() {
      var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
      var map = {};
      intervals.forEach(function(row) {
        var interval = (row.interval || '').trim();
        var parts = interval.split(':');
        var hour = parseInt(parts[0], 10);
        var minute = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        if (isNaN(minute)) minute = 0;
        var rtd = Number(row.rtd) || 0;
        var dayAhead = Number(row.dayAhead) || 0;
        var val = clampMw(rtd > 0 ? rtd : dayAhead);
        if (hour === 24 && minute === 0) {
          map['24,0'] = val;
          return;
        }
        if (isNaN(hour) || hour < 0 || hour > 23) return;
        map[hour + ',' + minute] = val;
      });
      return map;
    }

    function buildRawBidSetXml() {
      var rtdLookup = getRtdLookupForExport();
      var refDateStr = getForecastRefDateString();
      var bidDate = refDateStr ? new Date(refDateStr) : new Date();
      if (isNaN(bidDate.getTime())) bidDate = new Date();
      var y = bidDate.getFullYear(), mo = bidDate.getMonth() + 1, day = bidDate.getDate();
      var m = String(mo).padStart(2, '0'), d = String(day).padStart(2, '0');
      var startTime = formatNominationTime(y, mo, day, 0, 0, 0);
      var nextDay = new Date(bidDate.getFullYear(), bidDate.getMonth(), bidDate.getDate() + 1);
      var stopTimeNextDay = formatNominationTime(nextDay.getFullYear(), nextDay.getMonth() + 1, nextDay.getDate(), 0, 0, 0);
      var nowZ = formatTimeDateZ(new Date());
      var ns = 'http://pemc/soa/RawBidSet.xsd';
      var xsi = 'http://www.w3.org/2001/XMLSchema-instance';
      var minutesInHour = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];

      function getMw(hour, minute) {
        if (minute === 60) {
          if (hour === 23 && rtdLookup['24,0'] != null) return rtdLookup['24,0'];
          return rtdLookup[hour + ',55'] != null ? rtdLookup[hour + ',55'] : (rtdLookup[hour + ',0'] != null ? rtdLookup[hour + ',0'] : 0);
        }
        return rtdLookup[hour + ',' + minute] != null ? rtdLookup[hour + ',' + minute] : 0;
      }

      var sb = [];
      sb.push('<?xml version="1.0" encoding="UTF-8"?>');
      sb.push('<m:RawBidSet xmlns:m="' + ns + '" xmlns:xsi="' + xsi + '" xsi:schemaLocation="' + ns + ' RawBidSet.xsd">');
      sb.push(' <m:MessageHeader>');
      sb.push('  <m:TimeDate>' + nowZ + '</m:TimeDate>');
      sb.push('  <m:Source>Default</m:Source>');
      sb.push(' </m:MessageHeader>');
      sb.push(' <m:MessagePayload>');
      sb.push('  <m:GeneratingBid>');
      sb.push('   <m:name>' + escapeXml(RESOURCE_MRID) + '</m:name>');
      sb.push('   <m:startTime>' + startTime + '</m:startTime>');
      sb.push('   <m:stopTime>' + stopTimeNextDay + '</m:stopTime>');
      sb.push('   <m:RegisteredGenerator>');
      sb.push('    <m:mrid>' + escapeXml(RESOURCE_MRID) + '</m:mrid>');
      sb.push('   </m:RegisteredGenerator>');
      sb.push('   <m:MarketParticipant>');
      sb.push('    <m:mrid>' + escapeXml(MARKET_PARTICIPANT_MRID) + '</m:mrid>');
      sb.push('   </m:MarketParticipant>');
      sb.push('   <m:ProductBid>');

      for (var h = 0; h < 24; h++) {
        var tStart = formatNominationTime(y, mo, day, h, 0, 0);
        var tEnd = h < 23 ? formatNominationTime(y, mo, day, h + 1, 0, 0) : stopTimeNextDay;
        sb.push('    <m:Nomination>');
        sb.push('     <m:timeIntervalStart>' + tStart + '</m:timeIntervalStart>');
        sb.push('     <m:timeIntervalEnd>' + tEnd + '</m:timeIntervalEnd>');
        minutesInHour.forEach(function(min) {
          var mw = getMw(h, min);
          sb.push('     <m:minuteMW>');
          sb.push('      <m:minuteOfHour>' + min + '</m:minuteOfHour>');
          sb.push('      <m:quantity>' + Number(mw).toFixed(1) + '</m:quantity>');
          sb.push('     </m:minuteMW>');
        });
        sb.push('    </m:Nomination>');
      }

      sb.push('   </m:ProductBid>');
      sb.push('  </m:GeneratingBid>');
      sb.push(' </m:MessagePayload>');
      sb.push('</m:RawBidSet>');
      return sb.join('\n');
    }

    /** Build snapshot for historical export (saved to server JSON, one per forecast date). */
    function buildExportSnapshot() {
      var full = buildPersistPayload({});
      full.exportedAt = new Date().toISOString();
      full.vreHourly = getVreHourlyAverages();
      var refStr = getForecastRefDateString();
      var d = refStr ? new Date(refStr) : new Date();
      if (!isNaN(d.getTime())) {
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        full.forecastRefDateIso = y + '-' + m + '-' + day;
        full.forecastRefDate = formatDateForDisplay(refStr);
      }
      return full;
    }

    function saveExportToHistory(snapshot, onDone) {
      if (!snapshot) snapshot = buildExportSnapshot();
      fetch(API_BASE + '/api/save-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot)
      }).then(function(r) {
        if (!r.ok) {
          return r.text().then(function(t) {
            var errMsg = r.status + ' ' + (r.statusText || '');
            try { var j = JSON.parse(t); if (j && j.error) errMsg = j.error; } catch (e) {}
            return Promise.reject(new Error(errMsg));
          });
        }
        return r.json();
      }).then(function(res) {
        if (res && res.ok) {
          historicalExportsList = historicalExportsList.filter(function(r) { return r.forecastRefDateIso !== (snapshot.forecastRefDateIso || ''); });
          historicalExportsList.unshift(snapshot);
          renderHistoryTable(historicalExportsList);
          renderAnalytics();
          loadHistory();
        }
        if (typeof onDone === 'function') onDone();
      }).catch(function(err) {
        var msg = (err && err.message) ? err.message : 'Could not save to history.';
        console.warn('saveExportToHistory failed:', msg);
        setNominationExportStatus('Export file saved but history sync failed: ' + msg + ' — start the app and use Refresh history.', true);
        if (typeof onDone === 'function') onDone();
      });
    }

    function formatHistoryExportedAt(iso) {
      if (!iso) return '—';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      } catch (e) { return iso; }
    }

    function renderHistoryTable(records) {
      var tbody = document.getElementById('history-tbody');
      if (!tbody) return;
      if (!records || records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-4 text-brand-muted text-center">No history yet. Use EXPORT or Export CSV to save (when using the server).</td></tr>';
        return;
      }
      var list = records.slice();
      list.sort(function(a, b) {
        var ta = a.exportedAt || a.savedAt || '';
        var tb = b.exportedAt || b.savedAt || '';
        return tb.localeCompare(ta);
      });
      tbody.innerHTML = list.map(function(rec, idx) {
        var exportedAt = formatHistoryExportedAt(rec.exportedAt || rec.savedAt);
        var forecastRef = formatDateForDisplay(rec.forecastRefDateIso || rec.forecastRefDate) || '—';
        var intervalCount = (rec.intervals && rec.intervals.length) ? rec.intervals.length : 0;
        var revNum = rec.intervalRev != null ? (parseInt(rec.intervalRev, 10) || 1) : '—';
        var rtdPct = rec.rtdPercent != null ? rec.rtdPercent : '—';
        var mode = (rec.rtdForecastMode || '—').toString();
        return '<tr class="history-row cursor-pointer hover:bg-brand-border/20 transition-colors" data-history-index="' + idx + '"><td class="px-4 py-2 text-brand-muted">' + exportedAt + '</td><td class="px-4 py-2 text-brand-accent">' + forecastRef + '</td><td class="px-4 py-2">' + intervalCount + '</td><td class="px-4 py-2">' + revNum + '</td><td class="px-4 py-2">' + rtdPct + '</td><td class="px-4 py-2">' + mode + '</td></tr>';
      }).join('');
      list.forEach(function(rec, i) {
        var row = tbody.querySelector('[data-history-index="' + i + '"]');
        if (row) row._historyRecord = list[i];
      });
    }

    function computeHistoryAnalytics(records) {
      if (!records || records.length === 0) {
        return { totalExports: 0, uniqueDates: 0, dateRange: '—', avgRtdPct: '—', modeCounts: {}, avgPeakMw: '—', totalDayAheadMwh: '—', last7d: 0, last30d: 0, avgIntervals: '—' };
      }
      var now = Date.now();
      var sevenDays = 7 * 24 * 60 * 60 * 1000;
      var thirtyDays = 30 * 24 * 60 * 60 * 1000;
      var dates = {};
      var rtdSum = 0, rtdCount = 0;
      var modeCounts = { low: 0, mid: 0, high: 0, custom: 0 };
      var peakSum = 0, peakCount = 0;
      var mwhSum = 0, mwhCount = 0;
      var intervalCountSum = 0;
      var last7d = 0, last30d = 0;
      var firstDate = null, lastDate = null;
      records.forEach(function(r) {
        var iso = r.forecastRefDateIso || r.forecastRefDate;
        if (iso) { dates[iso] = true; if (!firstDate || iso < firstDate) firstDate = iso; if (!lastDate || iso > lastDate) lastDate = iso; }
        if (r.rtdPercent != null && !isNaN(Number(r.rtdPercent))) { rtdSum += Number(r.rtdPercent); rtdCount++; }
        var mode = (r.rtdForecastMode || 'custom').toLowerCase();
        if (modeCounts[mode] !== undefined) modeCounts[mode]++; else modeCounts.custom++;
        var intervals = r.intervals || [];
        intervalCountSum += intervals.length;
        var peak = 0, totalMw = 0;
        intervals.forEach(function(iv) {
          var mw = Number(iv.dayAhead);
          if (!isNaN(mw)) { if (mw > peak) peak = mw; totalMw += mw * (5 / 60); }
        });
        if (intervals.length) { peakSum += peak; peakCount++; mwhSum += totalMw; mwhCount++; }
        var exportedAt = r.exportedAt || r.savedAt || '';
        if (exportedAt) {
          var t = new Date(exportedAt).getTime();
          if (now - t <= sevenDays) last7d++;
          if (now - t <= thirtyDays) last30d++;
        }
      });
      var avgRtd = rtdCount ? Math.round(rtdSum / rtdCount) : '—';
      var avgPeak = peakCount ? (Math.round((peakSum / peakCount) * 100) / 100) : '—';
      var avgMwh = mwhCount ? (Math.round((mwhSum / mwhCount) * 10) / 10) : '—';
      var dateRange = (firstDate && lastDate) ? (formatDateForDisplay(firstDate) + ' → ' + formatDateForDisplay(lastDate)) : '—';
      var avgIntervals = records.length ? Math.round(intervalCountSum / records.length) : '—';
      return { totalExports: records.length, uniqueDates: Object.keys(dates).length, dateRange: dateRange, avgRtdPct: avgRtd, modeCounts: modeCounts, avgPeakMw: avgPeak, totalDayAheadMwh: avgMwh, last7d: last7d, last30d: last30d, avgIntervals: avgIntervals };
    }

    function renderAnalyticsCards(analytics) {
      var container = document.getElementById('analytics-cards');
      if (!container) return;
      if (analytics.totalExports === 0) {
        container.innerHTML = '<p class="col-span-full text-sm text-brand-muted">No history yet. Export or save CSV to build analytics.</p>';
        return;
      }
      var modeStr = Object.keys(analytics.modeCounts).filter(function(m) { return analytics.modeCounts[m] > 0; }).map(function(m) { return m.charAt(0).toUpperCase() + m.slice(1) + ': ' + analytics.modeCounts[m]; }).join(' · ');
      var cards = [
        { label: 'Total exports', value: analytics.totalExports, sub: 'saved forecasts', span: '' },
        { label: 'Unique forecast dates', value: analytics.uniqueDates, sub: '', span: '' },
        { label: 'Date range', value: analytics.dateRange, sub: '', span: ' lg:col-span-2' },
        { label: 'Avg RTD %', value: analytics.avgRtdPct, sub: 'across exports', span: '' },
        { label: 'Avg peak MW', value: analytics.avgPeakMw, sub: 'max per day', span: '' },
        { label: 'Avg day-ahead (MWh equiv)', value: analytics.totalDayAheadMwh, sub: '5-min intervals', span: '' },
        { label: 'Exports (last 7 days)', value: analytics.last7d, sub: '', span: '' },
        { label: 'Exports (last 30 days)', value: analytics.last30d, sub: '', span: '' },
        { label: 'Avg intervals per export', value: analytics.avgIntervals, sub: '', span: '' },
        { label: 'Mode usage', value: modeStr, sub: '', span: ' lg:col-span-2' }
      ];
      container.innerHTML = cards.map(function(c) {
        var val = c.value !== undefined && c.value !== null && c.value !== '' ? String(c.value) : '—';
        var spanClass = c.span || '';
        return '<div class="bg-brand-dark/60 border border-brand-border rounded-lg px-4 py-3' + spanClass + '"><div class="text-[10px] text-brand-muted uppercase tracking-wider">' + c.label + '</div><div class="text-lg font-bold text-brand-accent mt-1 break-words">' + val + '</div>' + (c.sub ? '<div class="text-[10px] text-brand-muted mt-0.5">' + c.sub + '</div>' : '') + '</div>';
      }).join('');
    }

    function renderAnalytics() {
      renderAnalyticsCards(computeHistoryAnalytics(historicalExportsList));
    }

    function loadHistory() {
      fetch(API_BASE + '/api/historical-exports').then(function(r) {
        if (!r.ok) return r.text().then(function() { return []; });
        return r.json();
      }).then(function(data) {
        historicalExportsList = Array.isArray(data) ? data : (data && data.error ? [] : []);
        renderHistoryTable(historicalExportsList);
        renderAnalytics();
      }).catch(function() {
        historicalExportsList = [];
        renderHistoryTable([]);
        renderAnalytics();
      });
    }

    function onHistoryRowClick(record, highlightRow) {
      if (!record) return;
      restoreFromRecord(record);
      if (typeof chart !== 'undefined' && chart) {
        updateRtdChartSeries();
        chart.update();
      }
      renderVreTable();
      document.querySelectorAll('#history-tbody .history-row').forEach(function(r) {
        r.classList.remove('bg-brand-accent/20', 'ring-1', 'ring-brand-accent');
      });
      if (highlightRow) highlightRow.classList.add('bg-brand-accent/20', 'ring-1', 'ring-brand-accent');
    }

    var historyTbody = document.getElementById('history-tbody');
    if (historyTbody) {
      historyTbody.addEventListener('click', function(e) {
        var row = e.target.closest('.history-row');
        if (!row || !row._historyRecord) return;
        onHistoryRowClick(row._historyRecord, row);
      });
    }
    var btnRefreshHistory = document.getElementById('btn-refresh-history');
    if (btnRefreshHistory) btnRefreshHistory.addEventListener('click', loadHistory);

    function updateWeatherCoordsDisplay() {
      var el = document.getElementById('weather-coords-display');
      if (el) el.textContent = 'Weather location: ' + (weatherLocation.lat != null && weatherLocation.lon != null ? weatherLocation.lat.toFixed(4) + ', ' + weatherLocation.lon.toFixed(4) : '—');
    }

    function initWeatherLocation() {
      try {
        var s = localStorage.getItem(WEATHER_LOCATION_KEY);
        if (s) {
          var parsed = JSON.parse(s);
          if (parsed && typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
            weatherLocation = { lat: parsed.lat, lon: parsed.lon };
          }
        }
      } catch (e) {}
      updateWeatherCoordsDisplay();
    }

    function getExportDetailStrings() {
      var refStr = getForecastRefDateString();
      var d = refStr ? new Date(refStr) : new Date();
      if (isNaN(d.getTime())) d = new Date();
      var mm = String(d.getMonth() + 1).padStart(2, '0');
      var dd = String(d.getDate()).padStart(2, '0');
      var yyyy = d.getFullYear();
      var intervals = getIntervalsFromTable().length ? getIntervalsFromTable() : intervalsData;
      var forecastDateDisplay = refStr ? formatDateForDisplay(refStr) : (mm + '/' + dd + '/' + yyyy);
      return { mm: mm, dd: dd, yyyy: yyyy, forecastDate: forecastDateDisplay, intervalCount: (intervals && intervals.length) ? intervals.length : 0 };
    }

    function setNominationExportStatus(msg, isErr) {
      var el = document.getElementById('nomination-export-status');
      if (!el) return;
      el.textContent = msg || '';
      el.className = 'text-xs min-h-[1.25rem] ' + (isErr ? 'text-red-400' : 'text-brand-muted');
    }

    function saveNominationFileToServer(filename, content) {
      return fetch(API_BASE + '/api/nomination-save-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: filename, content: content })
      }).then(function(r) {
        return r.json().then(function(j) {
          if (!r.ok) throw new Error((j && j.error) ? j.error : (r.statusText || 'Request failed'));
          return j;
        });
      });
    }

    function downloadBlobFallback(blob, filename) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    document.getElementById('btn-export').addEventListener('click', function() {
      var detail = getExportDetailStrings();
      var filename = 'ARECO_' + detail.mm + '_' + detail.dd + '_' + detail.yyyy + '.xml';
      var xml = buildRawBidSetXml();
      setNominationExportStatus('Saving XML to server folder…');
      saveNominationFileToServer(filename, xml)
        .then(function(res) {
          var snapshot = buildExportSnapshot();
          saveExportToHistory(snapshot, function() {
            var path = (res && res.path) ? res.path : filename;
            setNominationExportStatus('Saved: ' + path + ' — history updated.');
          });
        })
        .catch(function(err) {
          console.warn('Server XML export failed:', err);
          var blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
          downloadBlobFallback(blob, filename);
          setNominationExportStatus('Server unavailable — file downloaded in browser. Run the app to save under the automate folder (see App settings).', true);
        });
    });

    document.getElementById('btn-export-vre-csv').addEventListener('click', function() {
      var detail = getExportDetailStrings();
      var dateStr = String(detail.yyyy) + detail.mm + detail.dd;
      var filename = 'VRE_NOM_{Vista Alegre Solar Power Plant}_' + dateStr + '.csv';
      var csv = buildVreCsvContent();
      setNominationExportStatus('Saving VRE CSV to server folder…');
      saveNominationFileToServer(filename, csv)
        .then(function(res) {
          var snapshot = buildExportSnapshot();
          saveExportToHistory(snapshot, function() {
            var path = (res && res.path) ? res.path : filename;
            setNominationExportStatus('Saved: ' + path + ' — history updated.');
          });
        })
        .catch(function(err) {
          console.warn('Server VRE export failed:', err);
          var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
          downloadBlobFallback(blob, filename);
          setNominationExportStatus('Server unavailable — file downloaded in browser. Run the app to save under the automate folder (see App settings).', true);
        });
    });

    document.getElementById('btn-import').addEventListener('click', function() {
      document.getElementById('forecast-file-input').click();
    });

    var forecastRefDateEl = document.getElementById('forecast-ref-date');
    if (forecastRefDateEl) {
      forecastRefDateEl.addEventListener('blur', function() {
        saveForecastLocally({ forecastRefDate: getForecastRefDateString() });
      });
      forecastRefDateEl.addEventListener('change', function() {
        if (typeof window.updateRtdIntervalLocks === 'function') window.updateRtdIntervalLocks();
      });
    }

    var opsWeatherEl = document.getElementById('ops-weather-condition');
    var opsRevisionEl = document.getElementById('ops-revision-reason');
    var opsTraderEl = document.getElementById('ops-trader-duty');
    if (opsWeatherEl) opsWeatherEl.addEventListener('change', function() { saveForecastLocally({}); });
    if (opsRevisionEl) opsRevisionEl.addEventListener('change', function() { saveForecastLocally({}); });
    if (opsTraderEl) opsTraderEl.addEventListener('change', function() { saveForecastLocally({}); });

    var intervalFilterEl = document.getElementById('interval-hour-filter');
    if (intervalFilterEl) intervalFilterEl.addEventListener('change', applyIntervalFilter);

    (function initIntervalRevStepper() {
      var revSpan = document.getElementById('interval-rev-number');
      var revUp = document.getElementById('interval-rev-up');
      var revDown = document.getElementById('interval-rev-down');
      var revMin = 1;
      var revMax = 999;
      function getRev() { return parseInt(revSpan && revSpan.textContent ? revSpan.textContent : 1, 10) || revMin; }
      function setRev(n) {
        n = Math.max(revMin, Math.min(revMax, n));
        if (revSpan) revSpan.textContent = n;
        if (typeof saveForecastLocally === 'function') saveForecastLocally({ intervalRev: n });
      }
      if (revUp) revUp.addEventListener('click', function() { setRev(getRev() + 1); });
      if (revDown) revDown.addEventListener('click', function() { setRev(getRev() - 1); });
    })();

    attachIntervalRowHandlers();

    document.getElementById('forecast-file-input').addEventListener('change', function() {
      const file = this.files && this.files[0];
      if (!file) return;
      const isCsv = /\.csv$/i.test(file.name);
      const isExcel = /\.xls[x]?$/i.test(file.name);
      const reader = new FileReader();
      reader.onload = function() {
        let rows = [];
        if (isCsv) rows = parseCsv(reader.result);
        else if (isExcel && typeof XLSX !== 'undefined') rows = parseXls(reader.result);
        if (!rows.length) {
          showConfirmationModal({
            title: 'Import failed',
            body: 'No "predicted power" (or similar) column found, or no valid numeric rows.',
            confirmLabel: 'OK',
            hideCancel: true
          });
          return;
        }
        var plantNameFromFile = file.name.replace(/\.[^.]*$/, '').trim();
        if (plantNameFromFile) {
          var vrePlantEl = document.getElementById('vre-plant-name');
          if (vrePlantEl) vrePlantEl.value = plantNameFromFile;
        }
        var dateFromFilename = parseDateFromFilename(file.name);
        var today = new Date();
        var forecastRefDateIso = dateFromFilename
          ? (dateFromFilename.getFullYear() + '-' + String(dateFromFilename.getMonth() + 1).padStart(2, '0') + '-' + String(dateFromFilename.getDate()).padStart(2, '0'))
          : (today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0'));
        const result = rowsToHourlyAndIntervals(rows);
        // Include all intervals (including zero MW) so e.g. 05:05 with 0 displays correctly
        const payload = {
          forecastRefDate: forecastRefDateIso,
          nomination: result.hourly,
          intervals: result.intervals,
          plantNameForVreExport: plantNameFromFile || (document.getElementById('vre-plant-name') && document.getElementById('vre-plant-name').value) || undefined
        };
        saveForecastLocally(payload);
        applyForecastToSystem(payload);
        renderVreTable();
        var dateMsg = dateFromFilename ? ' Date set from filename: ' + formatDateForDisplay(forecastRefDateIso) + '.' : '';
        showConfirmationModal({
          title: 'Import complete',
          body: 'Imported ' + rows.length + ' rows.' + dateMsg + '\n\nForecast Ref is editable—change it if needed, then export. Saved to browser storage (localStorage + IndexedDB).',
          confirmLabel: 'OK',
          hideCancel: true
        });
      };
      if (isCsv) reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
      this.value = '';
    });

    function restoreFromRecord(data) {
      if (!data) return;
      applyStoredRecord(data);
      if (data.intervalRev != null) {
        var revSpan = document.getElementById('interval-rev-number');
        if (revSpan) {
          var r = Math.max(1, Math.min(999, parseInt(data.intervalRev, 10) || 1));
          revSpan.textContent = r;
        }
      }
      if (data.weatherHourly && data.weatherHourly.length) {
        weatherData = data.weatherHourly.slice(0, 25);
        while (weatherData.length < 25) weatherData.push(0);
        chart.data.datasets[1].data = weatherData.slice();
        if (data.weatherSummary) document.getElementById('weather-summary').textContent = data.weatherSummary;
        chart.update();
      }
    }

    idbGet().then(function(idbRow) {
      var ls = null;
      try { ls = localStorage.getItem(STORAGE_KEY); } catch (e) {}
      var fromLs = ls ? JSON.parse(ls) : null;
      var fromSess = null;
      try { var s = sessionStorage.getItem(STORAGE_KEY + '_ram'); if (s) fromSess = JSON.parse(s); } catch (e) {}
      var best = idbRow || fromLs || fromSess;
      if (best && best.id) delete best.id;
      if (best) restoreFromRecord(best);
      else {
        try {
          var ls2 = localStorage.getItem(STORAGE_KEY);
          if (ls2) restoreFromRecord(JSON.parse(ls2));
        } catch (e2) {}
      }
      if (!intervalsData || intervalsData.length === 0) applyForecastToSystem({});
      populateIntervalHourFilter();
      renderVreTable();
      showPersistHint();
      loadHistory();
      initWeatherLocation();
      if (typeof window.updateRtdIntervalLocks === 'function') window.updateRtdIntervalLocks();
    });

    (function initNavbarTimeAndDateMin() {
      function todayIso() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
      var timeEl = document.getElementById('navbar-current-time');
      var rtdEl = document.getElementById('navbar-rtd-mw');
      function updateNavbarTimeAndInterval() {
        if (timeEl) timeEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        var now = new Date();
        var currentMins = now.getHours() * 60 + now.getMinutes();
        var rows = document.querySelectorAll('.interval-data-tbody .interval-row');
        var entries = [];
        for (var i = 0; i < rows.length; i++) {
          var intervalStr = rows[i].getAttribute('data-interval');
          var intervalMins = intervalLabelToMinutes(intervalStr);
          if (isNaN(intervalMins)) continue;
          var rtdInput = rows[i].querySelector('.rtd-input');
          var raw = rtdInput && rtdInput.value !== '' ? parseFloat(rtdInput.value) : NaN;
          var rtdVal = (raw != null && !isNaN(raw)) ? raw : 0;
          entries.push({ mins: intervalMins, row: rows[i], rtd: rtdVal });
        }
        entries.sort(function(a, b) { return a.mins - b.mins; });
        var prev = null;
        var next = null;
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].mins <= currentMins) prev = entries[j];
          if (entries[j].mins >= currentMins) { next = entries[j]; break; }
        }
        var displayVal = null;
        /* Interval-aligned (step): show RTD for the last row at or before current clock — no linear blend between rows */
        if (prev) {
          displayVal = prev.rtd;
        } else if (next) {
          displayVal = next.rtd;
        }
        if (rtdEl) rtdEl.textContent = displayVal != null ? displayVal.toFixed(3) : '—';
        if (typeof window.updateRtdIntervalLocks === 'function') window.updateRtdIntervalLocks();
      }
      if (timeEl || rtdEl) {
        updateNavbarTimeAndInterval();
        setInterval(updateNavbarTimeAndInterval, 1000);
      }
      window.updateNavbarTimeAndInterval = updateNavbarTimeAndInterval;
      var dateInput = document.getElementById('forecast-ref-date');
      if (dateInput) {
        dateInput.setAttribute('min', todayIso());
        var val = (dateInput.value || '').trim();
        if (val && val < todayIso()) dateInput.value = todayIso();
      }
    })();

    (function initLiveStreamUrl() {
      var saved = '';
      try { saved = localStorage.getItem(LIVE_STREAM_STORAGE_KEY) || ''; } catch (e) {}
      var url = (saved && saved.trim()) ? saved.trim() : DEFAULT_LIVE_STREAM_URL;
      var iframe = document.getElementById('vdo-ninja-stream');
      var input = document.getElementById('live-stream-url');
      if (iframe) iframe.src = url;
      if (input) input.value = url;
      if (!saved || !saved.trim()) {
        try { localStorage.setItem(LIVE_STREAM_STORAGE_KEY, url); } catch (e2) {}
      }
      function applyUrl() {
        var u = (input && input.value) ? input.value.trim() : '';
        if (!u) return;
        try { localStorage.setItem(LIVE_STREAM_STORAGE_KEY, u); } catch (e3) {}
        if (iframe) iframe.src = u;
      }
      var applyBtn = document.getElementById('live-stream-apply');
      if (applyBtn) applyBtn.addEventListener('click', applyUrl);
      if (input) input.addEventListener('blur', applyUrl);
      if (input) input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } });
    })();

    document.getElementById('btn-weather').addEventListener('click', function() {
      var btn = this;
      var originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Loading…';
      btn.classList.add('opacity-75', 'cursor-not-allowed');
      var dateInput = document.getElementById('forecast-ref-date');
      var d = (dateInput && dateInput.value) ? dateInput.value : new Date().toISOString().slice(0, 10);
      fetch(API_BASE + '/api/weather-forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: d, lat: weatherLocation.lat, lon: weatherLocation.lon })
      }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, status: r.status, j: j }; }); })
        .then(function(_ref) {
          var j = _ref.j;
          if (j.error) {
            alert('Weather error: ' + j.error + '\n\nIf OpenAI failed, the server tries AccuWeather then Open-Meteo. Ensure the Flask app is running (python run_dashboard.py) and set OPENAI_API_KEY / ACCUWEATHER_API_KEY in .env (see .env.example) or use the key txt files.');
            return;
          }
          if (!j.hourly_mw || !j.hourly_mw.length) {
            alert('Weather: no hourly data in response.');
            return;
          }
          weatherData = j.hourly_mw.slice(0, 25).map(clampMw);
          while (weatherData.length < 25) weatherData.push(0);
          weatherSummaryText = (j.summary || '') + (j.message ? ' — ' + j.message : '') + (j.from_cache ? ' [cached today]' : '');
          weatherDateStr = j.date || d;
          chart.data.datasets[1].data = weatherData.slice();
          chart.update();
          document.getElementById('weather-summary').textContent = weatherSummaryText;
          saveForecastLocally({ weatherHourly: weatherData, weatherSummary: weatherSummaryText, weatherDate: weatherDateStr });
        })
        .catch(function(err) {
          alert('Cannot reach /api/weather-forecast. Start the server: python run_dashboard.py');
        })
        .finally(function() {
          btn.disabled = false;
          btn.textContent = originalText;
          btn.classList.remove('opacity-75', 'cursor-not-allowed');
        });
    });

    ['link-privacy', 'link-status', 'link-support'].forEach(id => {
      document.getElementById(id).addEventListener('click', function(e) {
        e.preventDefault();
        const t = this.textContent.trim();
        alert(t + ' — placeholder. Link would open here.');
      });
    });

    document.querySelectorAll('.interval-row').forEach(row => {
      row.addEventListener('click', function() {
        document.querySelectorAll('.interval-row').forEach(r => {
          r.classList.remove('interval-row-active');
          r.querySelectorAll('td').forEach(td => { td.classList.remove('text-brand-accent', 'font-bold'); });
        });
        this.classList.add('interval-row-active');
        this.querySelectorAll('td').forEach(td => { td.classList.add('text-brand-accent', 'font-bold'); });
      });
    });

    // Live stream value: cross-origin prevents reading iframe pixels from this page.
    // Use window.updateStreamMw(value) or a backend/OCR service that POSTs or exposes /api/stream-mw to push the parsed MW.
    window.updateStreamMw = function(mw) {
      var mwC = (mw != null && !isNaN(Number(mw))) ? clampMw(mw) : null;
      var el = document.getElementById('stream-mw');
      if (el) el.textContent = mwC != null ? mwC.toFixed(3) : (mw != null ? String(mw) : '—');
      var currentMw = document.getElementById('current-mw');
      if (currentMw && mwC != null) {
        currentMw.textContent = mwC.toFixed(3);
        var pct = Math.min(100, (mwC / PLANT_MAX_MW) * 100);
        var ub = document.getElementById('util-bar');
        var ut = document.getElementById('util-text');
        if (ub) ub.style.width = pct + '%';
        if (ut) ut.textContent = pct.toFixed(1) + '% of ' + PLANT_MAX_MW + 'MW';
      }
    };
    // Optional: set window.STREAM_MW_API = '/api/stream-mw' (or your OCR backend URL) to poll for stream-derived MW.
    (function pollStreamMw() {
      var url = window.STREAM_MW_API || '';
      if (url) {
        fetch(url).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
          if (d && typeof d.mw === 'number') window.updateStreamMw(d.mw);
        }).catch(function() {});
      }
      setTimeout(pollStreamMw, 5000);
    })();
