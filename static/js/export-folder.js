/**
 * Remembered export folders (File System Access API).
 * The first save for a key asks the user for a folder; the handle is kept in IndexedDB so later
 * saves for that key write straight into it. Browsers without the API (Firefox/Safari, non-secure
 * origins) report supported === false and callers fall back to a normal download.
 */
(function() {
  var DB_NAME = 'areco-reporting';
  var STORE = 'handles';
  var supported = typeof window.showDirectoryPicker === 'function' && !!window.indexedDB;

  function withStore(mode, fn) {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function() {
        req.result.createObjectStore(STORE);
      };
      req.onerror = function() {
        reject(req.error);
      };
      req.onsuccess = function() {
        var db = req.result;
        var tx = db.transaction(STORE, mode);
        var r = fn(tx.objectStore(STORE));
        tx.oncomplete = function() {
          db.close();
          resolve(r && r.result);
        };
        tx.onerror = function() {
          db.close();
          reject(tx.error);
        };
      };
    });
  }

  function storeKey(key) {
    return 'export-dir:' + key;
  }

  function load(key) {
    return withStore('readonly', function(s) {
      return s.get(storeKey(key));
    }).catch(function() {
      return null;
    });
  }

  function pick(key) {
    return window.showDirectoryPicker({ id: 'export-' + key, mode: 'readwrite' }).then(function(handle) {
      return withStore('readwrite', function(s) {
        return s.put(handle, storeKey(key));
      })
        .catch(function() {})
        .then(function() {
          return handle;
        });
    });
  }

  // Must run inside a click gesture: requestPermission() needs user activation.
  function ensure(key) {
    return load(key).then(function(handle) {
      if (!handle) return pick(key);
      var opts = { mode: 'readwrite' };
      return handle.queryPermission(opts).then(function(p) {
        if (p === 'granted') return handle;
        return handle.requestPermission(opts).then(function(p2) {
          return p2 === 'granted' ? handle : pick(key);
        });
      });
    });
  }

  function exists(dir, filename) {
    return dir.getFileHandle(filename).then(
      function() {
        return true;
      },
      function(err) {
        if (err && err.name === 'NotFoundError') return false;
        throw err;
      }
    );
  }

  function write(dir, filename, blob) {
    return dir
      .getFileHandle(filename, { create: true })
      .then(function(fh) {
        return fh.createWritable();
      })
      .then(function(w) {
        return w.write(blob).then(function() {
          return w.close();
        });
      });
  }

  window.ArecoExportFolder = {
    supported: supported,
    pick: pick,
    ensure: ensure,
    exists: exists,
    write: write
  };
})();
