/* SpotKeeper — app.js
   UI, validation, search, navigation. Data lives in IndexedDB (db.js);
   backup validation/export lives in backup.js. No external requests. */
(function () {
  'use strict';

  var DB = window.SpotKeeperDB;
  var Backup = window.SpotKeeperBackup;
  var CATEGORIES = Backup.CATEGORIES;

  var THEME_KEY = 'spotkeeper-theme';
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    items: [],
    locations: [],
    section: 'dashboard',
    search: '',
    categoryFilter: '',
    locationFilter: '',
    sort: 'updated-desc',
    editingItemId: null,
    editingLocationId: null,
    movingItemId: null,
    pendingDeleteItemId: null,
    pendingImport: null,
    reopenItemAfterLocation: false,
    lastFocus: null
  };

  /* ---------- helpers ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function fmtDateShort(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function locationById(id) {
    for (var i = 0; i < state.locations.length; i++) {
      if (state.locations[i].id === id) return state.locations[i];
    }
    return null;
  }

  function itemById(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  /* ---------- theme ---------- */

  function applyTheme() {
    var pref = 'system';
    try { pref = localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { /* ignore */ }
    var dark = pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.setAttribute('data-theme-pref', pref);
    var sel = $('theme-select');
    if (sel) sel.value = pref;
  }

  function setTheme(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) { /* ignore */ }
    applyTheme();
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }

  /* ---------- navigation ---------- */

  var SECTIONS = ['dashboard', 'items', 'locations', 'settings'];

  function showSection(name) {
    state.section = name;
    SECTIONS.forEach(function (s) {
      $('section-' + s).hidden = (s !== name);
    });
    document.querySelectorAll('[data-nav]').forEach(function (btn) {
      if (btn.getAttribute('data-nav') === name) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    if (name === 'dashboard') renderDashboard();
    if (name === 'items') renderItems();
    if (name === 'locations') renderLocations();
    if (name === 'settings') renderStorageInfo();
    $('main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  /* ---------- data loading ---------- */

  function loadAll() {
    return Promise.all([DB.getAllItems(), DB.getAllLocations()]).then(function (res) {
      state.items = res[0] || [];
      state.locations = res[1] || [];
      rebuildLocationOptions();
      renderDashboard();
      renderItems();
      renderLocations();
    });
  }

  function rebuildLocationOptions() {
    var filter = $('filter-location');
    var current = filter.value;
    filter.innerHTML = '';
    filter.appendChild(new Option('All locations', ''));
    state.locations.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (loc) { filter.appendChild(new Option(loc.name, loc.id)); });
    filter.value = current || '';
    if (filter.value !== current) filter.value = '';
  }

  /* ---------- dashboard ---------- */

  function renderDashboard() {
    $('stat-items').textContent = String(state.items.length);
    $('stat-locations').textContent = String(state.locations.length);
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var recentWeek = 0;
    state.items.forEach(function (it) {
      if (new Date(it.updatedAt).getTime() >= weekAgo) recentWeek++;
    });
    $('stat-recent').textContent = String(recentWeek);

    var recent = state.items.slice().sort(function (a, b) {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    }).slice(0, 5);
    var list = $('recent-list');
    list.innerHTML = '';
    $('recent-empty').hidden = recent.length > 0;
    recent.forEach(function (it) {
      list.appendChild(buildItemCard(it));
    });

    $('first-run').hidden = state.items.length > 0;
  }

  /* ---------- items ---------- */

  function filteredItems() {
    var q = state.search.trim().toLowerCase();
    var out = state.items.filter(function (it) {
      if (state.categoryFilter && it.category !== state.categoryFilter) return false;
      if (state.locationFilter && it.locationId !== state.locationFilter) return false;
      if (!q) return true;
      var loc = locationById(it.locationId);
      var hay = [it.name, it.spot, it.notes, it.category, loc ? loc.name : '']
        .join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    out.sort(function (a, b) {
      if (state.sort === 'name-asc') return a.name.localeCompare(b.name);
      if (state.sort === 'name-desc') return b.name.localeCompare(a.name);
      if (state.sort === 'created-asc') return new Date(a.createdAt) - new Date(b.createdAt);
      var d = new Date(b.updatedAt) - new Date(a.updatedAt);
      return d !== 0 ? d : new Date(b.createdAt) - new Date(a.createdAt);
    });
    return out;
  }

  function buildItemCard(it) {
    var loc = locationById(it.locationId);
    var card = el('li', 'item-card');
    var title = el('h3', null, it.name);
    card.appendChild(title);
    card.appendChild(el('span', 'badge', it.category));
    var where = loc ? loc.name : 'Unknown location';
    if (it.spot) where += ' — ' + it.spot;
    card.appendChild(el('p', 'item-meta', where));
    if (it.notes) card.appendChild(el('p', 'item-notes', it.notes));
    card.appendChild(el('p', 'item-meta', 'Added ' + fmtDateShort(it.createdAt) + ' · Updated ' + fmtDateShort(it.updatedAt)));

    var actions = el('div', 'item-actions');
    var viewBtn = el('button', 'btn btn-secondary btn-small', 'View');
    viewBtn.type = 'button';
    viewBtn.addEventListener('click', function () { openDetails(it.id); });
    var moveBtn = el('button', 'btn btn-secondary btn-small', 'Move');
    moveBtn.type = 'button';
    moveBtn.addEventListener('click', function () { openMove(it.id); });
    var editBtn = el('button', 'btn btn-secondary btn-small', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', function () { openItemDialog(it.id); });
    var delBtn = el('button', 'btn btn-danger btn-small', 'Delete');
    delBtn.type = 'button';
    delBtn.addEventListener('click', function () { askDeleteItem(it.id); });
    actions.appendChild(viewBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);
    return card;
  }

  function renderItems() {
    var list = filteredItems();
    var ul = $('items-list');
    ul.innerHTML = '';
    list.forEach(function (it) { ul.appendChild(buildItemCard(it)); });
    var total = state.items.length;
    $('items-count').textContent = total === 0
      ? ''
      : 'Showing ' + list.length + ' of ' + total + (total === 1 ? ' item' : ' items');
    $('items-empty').hidden = total > 0;
    $('items-no-results').hidden = !(total > 0 && list.length === 0);
  }

  /* ---------- locations ---------- */

  function renderLocations() {
    var ul = $('locations-list');
    ul.innerHTML = '';
    var sorted = state.locations.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    sorted.forEach(function (loc) {
      var count = 0;
      state.items.forEach(function (it) { if (it.locationId === loc.id) count++; });
      var card = el('li', 'location-card');
      card.appendChild(el('h3', null, loc.name));
      card.appendChild(el('p', 'location-count', count + (count === 1 ? ' item' : ' items')));
      if (loc.description) card.appendChild(el('p', 'location-desc', loc.description));
      card.appendChild(el('p', 'item-meta', 'Added ' + fmtDateShort(loc.createdAt)));
      var actions = el('div', 'location-actions');
      var viewBtn = el('button', 'btn btn-secondary btn-small', 'View Items');
      viewBtn.type = 'button';
      viewBtn.addEventListener('click', function () { openLocationItems(loc.id); });
      var editBtn = el('button', 'btn btn-secondary btn-small', 'Edit');
      editBtn.type = 'button';
      editBtn.addEventListener('click', function () { openLocationDialog(loc.id); });
      var delBtn = el('button', 'btn btn-danger btn-small', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () { askDeleteLocation(loc.id); });
      actions.appendChild(viewBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      ul.appendChild(card);
    });
    $('locations-empty').hidden = state.locations.length > 0;
  }

  function openLocationItems(locationId) {
    var loc = locationById(locationId);
    if (!loc) return;
    $('location-items-title').textContent = loc.name;
    $('location-items-desc').textContent = loc.description || '';
    var items = state.items.filter(function (it) { return it.locationId === locationId; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var ul = $('location-items-list');
    ul.innerHTML = '';
    items.forEach(function (it) { ul.appendChild(buildItemCard(it)); });
    $('location-items-empty').hidden = items.length > 0;
    openDialog($('location-items-dialog'));
  }

  /* ---------- dialogs ---------- */

  function openDialog(dlg) {
    state.lastFocus = document.activeElement;
    if (!dlg.open) dlg.showModal();
  }

  function closeDialog(dlg) {
    if (dlg.open) dlg.close();
    if (state.lastFocus && state.lastFocus.focus) {
      try { state.lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    state.lastFocus = null;
  }

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dlg = btn.closest('dialog');
      if (dlg) closeDialog(dlg);
    });
  });

  function setFieldError(inputId, errId, msg) {
    var input = $(inputId);
    var errEl = $(errId);
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      errEl.textContent = msg;
      errEl.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      errEl.textContent = '';
      errEl.hidden = true;
    }
  }

  /* ----- item add / edit ----- */

  function fillLocationSelect(selectEl, selectedId) {
    selectEl.innerHTML = '';
    selectEl.appendChild(new Option('Choose a location', ''));
    state.locations.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (loc) { selectEl.appendChild(new Option(loc.name, loc.id)); });
    if (selectedId) selectEl.value = selectedId;
  }

  function openItemDialog(itemId) {
    state.editingItemId = itemId || null;
    var item = itemId ? itemById(itemId) : null;
    $('item-dialog-title').textContent = item ? 'Edit Item' : 'Add Item';
    $('item-submit').textContent = item ? 'Save Changes' : 'Save Item';
    $('f-name').value = item ? item.name : '';
    $('f-category').value = item ? item.category : '';
    fillLocationSelect($('f-location'), item ? item.locationId : '');
    $('f-spot').value = item ? (item.spot || '') : '';
    $('f-notes').value = item ? (item.notes || '') : '';
    ['name', 'category', 'location', 'spot', 'notes'].forEach(function (f) {
      setFieldError('f-' + f, 'err-' + f, '');
    });
    $('item-form-error').hidden = true;
    $('no-location-hint').hidden = state.locations.length > 0;
    openDialog($('item-dialog'));
    $('f-name').focus();
  }

  $('item-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('f-name').value.trim();
    var category = $('f-category').value;
    var locationId = $('f-location').value;
    var spot = $('f-spot').value.trim();
    var notes = $('f-notes').value.trim();
    var errors = [];

    if (!name) { setFieldError('f-name', 'err-name', 'Item name is required.'); errors.push('name'); }
    else if (name.length > 80) { setFieldError('f-name', 'err-name', 'Item name must be at most 80 characters.'); errors.push('name'); }
    else setFieldError('f-name', 'err-name', '');

    if (CATEGORIES.indexOf(category) === -1) { setFieldError('f-category', 'err-category', 'Choose a valid category.'); errors.push('category'); }
    else setFieldError('f-category', 'err-category', '');

    if (!locationId || !locationById(locationId)) { setFieldError('f-location', 'err-location', 'Choose a valid location.'); errors.push('location'); }
    else setFieldError('f-location', 'err-location', '');

    if (spot.length > 120) { setFieldError('f-spot', 'err-spot', 'Specific spot must be at most 120 characters.'); errors.push('spot'); }
    else setFieldError('f-spot', 'err-spot', '');

    if (notes.length > 500) { setFieldError('f-notes', 'err-notes', 'Notes must be at most 500 characters.'); errors.push('notes'); }
    else setFieldError('f-notes', 'err-notes', '');

    var formErr = $('item-form-error');
    if (errors.length > 0) {
      formErr.textContent = 'Please fix the highlighted fields before saving.';
      formErr.hidden = false;
      return;
    }
    formErr.hidden = true;

    var now = new Date().toISOString();
    var item = state.editingItemId ? itemById(state.editingItemId) : null;
    var record = {
      id: item ? item.id : DB.newId(),
      name: name,
      category: category,
      locationId: locationId,
      spot: spot,
      notes: notes,
      createdAt: item ? item.createdAt : now,
      updatedAt: now
    };
    DB.putItem(record).then(function () {
      closeDialog($('item-dialog'));
      return loadAll();
    }).then(function () {
      toast(item ? 'Item updated.' : 'Item saved.');
    }).catch(function (err) {
      formErr.textContent = 'Could not save the item: ' + (err && err.message ? err.message : 'unknown error');
      formErr.hidden = false;
    });
  });

  /* ----- move ----- */

  function openMove(itemId) {
    var item = itemById(itemId);
    if (!item) return;
    state.movingItemId = itemId;
    var loc = locationById(item.locationId);
    $('move-item-label').textContent = '“' + item.name + '” is currently in ' + (loc ? loc.name : 'an unknown location') + '.';
    fillLocationSelect($('f-move-location'), item.locationId);
    setFieldError('f-move-location', 'err-move-location', '');
    $('move-form-error').hidden = true;
    openDialog($('move-dialog'));
  }

  $('move-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var dest = $('f-move-location').value;
    var item = itemById(state.movingItemId);
    var formErr = $('move-form-error');
    if (!item) { closeDialog($('move-dialog')); return; }
    if (!dest || !locationById(dest)) {
      setFieldError('f-move-location', 'err-move-location', 'Choose a valid destination.');
      return;
    }
    if (dest === item.locationId) {
      setFieldError('f-move-location', 'err-move-location', 'The item is already in this location.');
      return;
    }
    setFieldError('f-move-location', 'err-move-location', '');
    formErr.hidden = true;
    var updated = {
      id: item.id, name: item.name, category: item.category,
      locationId: dest, spot: item.spot, notes: item.notes,
      createdAt: item.createdAt, updatedAt: new Date().toISOString()
    };
    DB.putItem(updated).then(function () {
      closeDialog($('move-dialog'));
      return loadAll();
    }).then(function () {
      toast('Item moved.');
    }).catch(function (err) {
      formErr.textContent = 'Could not move the item: ' + (err && err.message ? err.message : 'unknown error');
      formErr.hidden = false;
    });
  });

  /* ----- details ----- */

  function openDetails(itemId) {
    var item = itemById(itemId);
    if (!item) return;
    var loc = locationById(item.locationId);
    var dl = $('details-list');
    dl.innerHTML = '';
    var rows = [
      ['Name', item.name],
      ['Category', item.category],
      ['Location', loc ? loc.name : 'Unknown location'],
      ['Specific spot', item.spot || '—'],
      ['Notes', item.notes || '—'],
      ['Date added', fmtDate(item.createdAt)],
      ['Last updated', fmtDate(item.updatedAt)]
    ];
    rows.forEach(function (r) {
      var dt = el('dt', null, r[0]);
      var dd = el('dd', null, r[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    openDialog($('details-dialog'));
  }

  /* ----- delete item ----- */

  var confirmAction = null;
  function askConfirm(title, message, yesLabel, action) {
    $('confirm-dialog-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-yes').textContent = yesLabel;
    confirmAction = action;
    openDialog($('confirm-dialog'));
  }

  $('confirm-yes').addEventListener('click', function () {
    var action = confirmAction;
    confirmAction = null;
    closeDialog($('confirm-dialog'));
    if (action) action();
  });

  function askDeleteItem(itemId) {
    var item = itemById(itemId);
    if (!item) return;
    askConfirm('Delete item?', '“' + item.name + '” will be permanently deleted. This cannot be undone.', 'Delete', function () {
      DB.deleteItem(itemId).then(loadAll).then(function () {
        toast('Item deleted.');
      }).catch(function () { toast('Could not delete the item.'); });
    });
  }

  /* ----- location add / edit ----- */

  function openLocationDialog(locationId) {
    state.editingLocationId = locationId || null;
    var loc = locationId ? locationById(locationId) : null;
    $('location-dialog-title').textContent = loc ? 'Edit Location' : 'Add Location';
    $('location-submit').textContent = loc ? 'Save Changes' : 'Save Location';
    $('f-loc-name').value = loc ? loc.name : '';
    $('f-loc-desc').value = loc ? (loc.description || '') : '';
    setFieldError('f-loc-name', 'err-loc-name', '');
    setFieldError('f-loc-desc', 'err-loc-desc', '');
    $('location-form-error').hidden = true;
    openDialog($('location-dialog'));
    $('f-loc-name').focus();
  }

  $('location-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('f-loc-name').value.trim();
    var desc = $('f-loc-desc').value.trim();
    var formErr = $('location-form-error');

    if (!name) {
      setFieldError('f-loc-name', 'err-loc-name', 'Location name is required.');
      formErr.textContent = 'Please fix the highlighted fields before saving.';
      formErr.hidden = false;
      return;
    }
    if (name.length > 60) {
      setFieldError('f-loc-name', 'err-loc-name', 'Location name must be at most 60 characters.');
      formErr.textContent = 'Please fix the highlighted fields before saving.';
      formErr.hidden = false;
      return;
    }
    setFieldError('f-loc-name', 'err-loc-name', '');
    var dup = state.locations.some(function (l) {
      return l.id !== state.editingLocationId && l.name.trim().toLowerCase() === name.toLowerCase();
    });
    if (dup) {
      setFieldError('f-loc-name', 'err-loc-name', 'A location with this name already exists.');
      formErr.textContent = 'Please fix the highlighted fields before saving.';
      formErr.hidden = false;
      return;
    }
    if (desc.length > 200) {
      setFieldError('f-loc-desc', 'err-loc-desc', 'Description must be at most 200 characters.');
      formErr.textContent = 'Please fix the highlighted fields before saving.';
      formErr.hidden = false;
      return;
    }
    setFieldError('f-loc-desc', 'err-loc-desc', '');
    formErr.hidden = true;

    var now = new Date().toISOString();
    var loc = state.editingLocationId ? locationById(state.editingLocationId) : null;
    var record = {
      id: loc ? loc.id : DB.newId(),
      name: name,
      description: desc,
      createdAt: loc ? loc.createdAt : now,
      updatedAt: now
    };
    DB.putLocation(record).then(function () {
      closeDialog($('location-dialog'));
      return loadAll();
    }).then(function () {
      toast(loc ? 'Location updated.' : 'Location saved.');
      if (state.reopenItemAfterLocation) {
        state.reopenItemAfterLocation = false;
        openItemDialog(null);
      }
    }).catch(function (err) {
      formErr.textContent = 'Could not save the location: ' + (err && err.message ? err.message : 'unknown error');
      formErr.hidden = false;
    });
  });

  function askDeleteLocation(locationId) {
    var loc = locationById(locationId);
    if (!loc) return;
    var count = 0;
    state.items.forEach(function (it) { if (it.locationId === locationId) count++; });
    if (count > 0) {
      toast('Cannot delete “' + loc.name + '”: ' + count + (count === 1 ? ' item' : ' items') + ' still live there. Move or delete them first.');
      return;
    }
    askConfirm('Delete location?', '“' + loc.name + '” will be permanently deleted. This cannot be undone.', 'Delete', function () {
      DB.deleteLocation(locationId).then(loadAll).then(function () {
        toast('Location deleted.');
      }).catch(function () { toast('Could not delete the location.'); });
    });
  }

  /* ----- delete all ----- */

  $('delete-all-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var word = $('f-delete-word').value.trim();
    var errEl = $('delete-all-error');
    if (word !== 'DELETE') {
      errEl.textContent = 'Type DELETE exactly to confirm.';
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    DB.deleteAll().then(function () {
      closeDialog($('delete-all-dialog'));
      $('f-delete-word').value = '';
      return loadAll();
    }).then(function () {
      toast('All data deleted.');
      showSection('dashboard');
    }).catch(function () {
      errEl.textContent = 'Could not delete the data. Please try again.';
      errEl.hidden = false;
    });
  });

  /* ----- export / import ----- */

  $('export-btn').addEventListener('click', function () {
    var data = Backup.buildBackup(state.items, state.locations);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = Backup.fileNameFor(new Date());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    $('backup-status').textContent = 'Backup exported: ' + state.items.length + ' item(s), ' + state.locations.length + ' location(s).';
    toast('Backup exported.');
  });

  $('import-btn').addEventListener('click', function () { $('import-file').click(); });

  $('import-file').addEventListener('change', function () {
    var file = $('import-file').files && $('import-file').files[0];
    $('import-file').value = '';
    if (!file) return;
    var status = $('backup-status');
    if (file.size > Backup.MAX_FILE_BYTES) {
      status.textContent = 'Import rejected: file is larger than 5 MB.';
      toast('Import rejected: file is larger than 5 MB.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (err) {
        status.textContent = 'Import rejected: file is not valid JSON.';
        toast('Import rejected: not valid JSON.');
        return;
      }
      var result = Backup.validateBackup(parsed);
      if (!result.ok) {
        status.textContent = 'Import rejected: ' + result.errors[0] + ' Your data is unchanged.';
        toast('Import rejected. Your data is unchanged.');
        return;
      }
      state.pendingImport = result;
      $('import-summary').textContent = 'This backup contains ' + result.items.length + ' item(s) and ' +
        result.locations.length + ' location(s), exported on ' + fmtDate(parsed.exportedAt) + '.';
      openDialog($('import-dialog'));
    };
    reader.onerror = function () {
      status.textContent = 'Import failed: could not read the file.';
      toast('Import failed: could not read the file.');
    };
    reader.readAsText(file);
  });

  $('import-confirm').addEventListener('click', function () {
    var pending = state.pendingImport;
    state.pendingImport = null;
    closeDialog($('import-dialog'));
    if (!pending) return;
    DB.replaceAll(pending.items, pending.locations).then(loadAll).then(function () {
      $('backup-status').textContent = 'Backup imported: ' + pending.items.length + ' item(s), ' + pending.locations.length + ' location(s).';
      toast('Backup imported.');
    }).catch(function () {
      $('backup-status').textContent = 'Import failed: the database could not be updated.';
      toast('Import failed.');
    });
  });

  /* ----- storage info ----- */

  function renderStorageInfo() {
    var info = $('storage-info');
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      info.textContent = 'Storage usage is not available in this browser.';
      return;
    }
    navigator.storage.estimate().then(function (est) {
      var used = est.usage || 0;
      var quota = est.quota || 0;
      function fmt(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }
      info.textContent = quota > 0
        ? 'Using ' + fmt(used) + ' of about ' + fmt(quota) + ' available. Data is stored locally in this browser (IndexedDB).'
        : 'Using about ' + fmt(used) + '. Data is stored locally in this browser (IndexedDB).';
    }).catch(function () {
      info.textContent = 'Storage usage is not available in this browser.';
    });
  }

  /* ----- wiring ----- */

  document.querySelectorAll('[data-nav]').forEach(function (btn) {
    btn.addEventListener('click', function () { showSection(btn.getAttribute('data-nav')); });
  });

  $('items-add-btn').addEventListener('click', function () { openItemDialog(null); });
  $('first-run-add').addEventListener('click', function () { openItemDialog(null); });
  $('locations-add-btn').addEventListener('click', function () { openLocationDialog(null); });
  $('delete-all-btn').addEventListener('click', function () {
    $('f-delete-word').value = '';
    $('delete-all-error').hidden = true;
    openDialog($('delete-all-dialog'));
  });

  $('goto-add-location').addEventListener('click', function () {
    state.reopenItemAfterLocation = true;
    closeDialog($('item-dialog'));
    openLocationDialog(null);
  });

  $('theme-select').addEventListener('change', function () { setTheme($('theme-select').value); });

  $('search-input').addEventListener('input', function () {
    state.search = $('search-input').value;
    renderItems();
  });
  $('filter-category').addEventListener('change', function () {
    state.categoryFilter = $('filter-category').value;
    renderItems();
  });
  $('filter-location').addEventListener('change', function () {
    state.locationFilter = $('filter-location').value;
    renderItems();
  });
  $('sort-select').addEventListener('change', function () {
    state.sort = $('sort-select').value;
    renderItems();
  });

  $('quick-search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    state.search = $('quick-search').value;
    $('search-input').value = state.search;
    showSection('items');
  });

  /* ----- boot ----- */

  applyTheme();
  loadAll().catch(function (err) {
    toast('Could not load your data: ' + (err && err.message ? err.message : 'unknown error'));
  });
})();
