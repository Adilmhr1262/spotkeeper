/* SpotKeeper — backup.js
   JSON export / import. Backup format:
   { "schemaVersion": 1, "exportedAt": "<ISO timestamp>",
     "items": [...], "locations": [...] }
   Import validates everything before touching the database, so an
   invalid file leaves existing data unchanged. */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
  var CATEGORIES = ['Documents', 'Electronics', 'Clothing', 'Tools', 'Household', 'Other'];

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function isIsoString(v) {
    return typeof v === 'string' && !isNaN(Date.parse(v));
  }

  function checkString(v, min, max) {
    return typeof v === 'string' && v.length >= min && v.length <= max;
  }

  function validateLocation(loc, errors) {
    if (!isPlainObject(loc)) { errors.push('Location entry is not an object.'); return null; }
    if (!checkString(loc.id, 1, 200)) { errors.push('Location has a missing or invalid id.'); return null; }
    if (!checkString(loc.name, 1, 60)) { errors.push('Location "' + (loc.id || '?') + '" name must be 1-60 characters.'); return null; }
    if (loc.description !== undefined && loc.description !== null && !checkString(loc.description, 0, 200)) {
      errors.push('Location "' + loc.name + '" description must be at most 200 characters.'); return null;
    }
    if (!isIsoString(loc.createdAt) || !isIsoString(loc.updatedAt)) {
      errors.push('Location "' + loc.name + '" has invalid timestamps.'); return null;
    }
    return {
      id: loc.id,
      name: loc.name,
      description: typeof loc.description === 'string' ? loc.description : '',
      createdAt: loc.createdAt,
      updatedAt: loc.updatedAt
    };
  }

  function validateItem(item, locationIds, errors) {
    if (!isPlainObject(item)) { errors.push('Item entry is not an object.'); return null; }
    if (!checkString(item.id, 1, 200)) { errors.push('Item has a missing or invalid id.'); return null; }
    if (!checkString(item.name, 1, 80)) { errors.push('Item "' + (item.id || '?') + '" name must be 1-80 characters.'); return null; }
    if (CATEGORIES.indexOf(item.category) === -1) {
      errors.push('Item "' + item.name + '" has an invalid category.'); return null;
    }
    if (typeof item.locationId !== 'string' || !locationIds.has(item.locationId)) {
      errors.push('Item "' + item.name + '" refers to an unknown location.'); return null;
    }
    if (item.spot !== undefined && item.spot !== null && !checkString(item.spot, 0, 120)) {
      errors.push('Item "' + item.name + '" specific spot must be at most 120 characters.'); return null;
    }
    if (item.notes !== undefined && item.notes !== null && !checkString(item.notes, 0, 500)) {
      errors.push('Item "' + item.name + '" notes must be at most 500 characters.'); return null;
    }
    if (!isIsoString(item.createdAt) || !isIsoString(item.updatedAt)) {
      errors.push('Item "' + item.name + '" has invalid timestamps.'); return null;
    }
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      locationId: item.locationId,
      spot: typeof item.spot === 'string' ? item.spot : '',
      notes: typeof item.notes === 'string' ? item.notes : '',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  /* Validate a parsed backup object. Returns
     { ok: true, items, locations } or { ok: false, errors: [...] }. */
  function validateBackup(data) {
    var errors = [];
    if (!isPlainObject(data)) return { ok: false, errors: ['Backup file is not a JSON object.'] };
    if (data.schemaVersion !== SCHEMA_VERSION) {
      return { ok: false, errors: ['Unsupported backup schema version: ' + String(data.schemaVersion) + ' (expected ' + SCHEMA_VERSION + ').'] };
    }
    if (!isIsoString(data.exportedAt)) {
      return { ok: false, errors: ['Backup is missing a valid export timestamp.'] };
    }
    if (!Array.isArray(data.items) || !Array.isArray(data.locations)) {
      return { ok: false, errors: ['Backup must contain "items" and "locations" arrays.'] };
    }

    var locations = [];
    var locationIds = new Set();
    var seenLocIds = new Set();
    data.locations.forEach(function (loc) {
      var clean = validateLocation(loc, errors);
      if (!clean) return;
      if (seenLocIds.has(clean.id)) { errors.push('Duplicate location id: ' + clean.id); return; }
      seenLocIds.add(clean.id);
      locationIds.add(clean.id);
      locations.push(clean);
    });

    // Duplicate location names (case-insensitive, trimmed) are rejected too.
    var seenNames = new Set();
    locations.forEach(function (loc) {
      var key = loc.name.trim().toLowerCase();
      if (seenNames.has(key)) errors.push('Duplicate location name: ' + loc.name);
      seenNames.add(key);
    });

    var items = [];
    var seenItemIds = new Set();
    data.items.forEach(function (item) {
      var clean = validateItem(item, locationIds, errors);
      if (!clean) return;
      if (seenItemIds.has(clean.id)) { errors.push('Duplicate item id: ' + clean.id); return; }
      seenItemIds.add(clean.id);
      items.push(clean);
    });

    if (errors.length > 0) return { ok: false, errors: errors };
    return { ok: true, items: items, locations: locations };
  }

  function buildBackup(items, locations) {
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      items: items,
      locations: locations
    };
  }

  function fileNameFor(date) {
    function p(n) { return String(n).padStart(2, '0'); }
    return 'spotkeeper-backup-' + date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) + '.json';
  }

  global.SpotKeeperBackup = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    CATEGORIES: CATEGORIES,
    validateBackup: validateBackup,
    buildBackup: buildBackup,
    fileNameFor: fileNameFor
  };
})(window);
