# SpotKeeper — Remember where you put everything

A private, offline single-page app that helps you remember where you stored
physical belongings. Record an item's exact location, search for it later,
and update its location when you move it.

## Features

- **Dashboard** — total items, total locations, items updated this week,
  recently updated items (up to 5), and quick search. First launch shows
  "Never lose track of your things again" with an Add First Item action.
- **My Items** — add, edit, move, delete, and view details for items.
  Each item has a name (1–80 characters), a category (Documents,
  Electronics, Clothing, Tools, Household, Other), a location, an optional
  specific spot (max 120 characters), and optional notes (max 500
  characters). Item names may repeat. Dates are generated automatically.
- **Locations** — create, rename, edit, and delete named storage
  locations (name max 60 characters, description max 200). Duplicate
  names are rejected (case-insensitive). Each location shows a live item
  count, and a location holding items cannot be deleted until those items
  are moved or deleted. Open a location to see its contents.
- **Search, filter, sort** — case-insensitive search across item names,
  specific spots, notes, category labels, and location names. Category
  and location filters combine with search, and results update
  immediately. Sort by Recently Updated, Name A–Z, Name Z–A, or Oldest
  Added.
- **Backup & restore** — export all data as a JSON file (schema version
  1, with export timestamp) and import it back. Imports are fully
  validated (structure, field lengths, IDs, categories, timestamps,
  location references) and rejected files leave existing data unchanged.
  A valid import replaces data only after confirmation, in a single
  atomic transaction. Files over 5 MB are rejected.
- **Settings** — Light / Dark / System theme (saved locally, applied
  before first paint), storage usage where supported, and Delete All
  Data guarded by typing DELETE.
- **Accessibility** — responsive at 320, 375, 768, 1024, and 1440 px;
  keyboard-accessible dialogs and navigation; visible focus indicators;
  descriptive error messages; 44 px minimum touch targets; empty states
  for zero items, zero locations, and no search results; reduced-motion
  preferences respected.

## Storage

All data lives in IndexedDB in this browser only: database
`spotkeeper-db`, version 1, with `items` and `locations` stores. IDs are
generated with `crypto.randomUUID()`. There are no accounts, no cloud,
no backend, no analytics, and no external requests. The app starts
completely empty — no demo or sample data is ever created.

## Running locally

Serve the folder over HTTP (module scripts and IndexedDB need a real
origin in some browsers) and open `index.html`. For example:

```sh
python3 -m http.server 8000
```

Then visit `http://127.0.0.1:8000/`.

## Backup format

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-11-17T03:00:00.000Z",
  "items": [
    {
      "id": "…",
      "name": "Passport",
      "category": "Documents",
      "locationId": "…",
      "spot": "Bedroom drawer, top",
      "notes": "",
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "locations": [
    { "id": "…", "name": "Bedroom", "description": "", "createdAt": "…", "updatedAt": "…" }
  ]
}
```

## Files

- `index.html` — accessible app markup, sections, and dialogs
- `styles.css` — responsive layouts, light/dark themes
- `app.js` — UI, validation, search, navigation
- `db.js` — IndexedDB operations and transactions
- `backup.js` — backup validation, export, and import format
- `README.md` — this file
