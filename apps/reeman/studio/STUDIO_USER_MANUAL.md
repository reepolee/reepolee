# Studio DDL Editor: User Manual

Studio is Reepolee's visual editor for house-style SQL DDL files. It runs inside the
main application and uses the normal navigation, session, language, theme, forms, and
confirmation dialogs.

## Access

1. Start the normal development server with bun dev.
2. Sign in with a user whose modules_tags includes studio.
3. Open /studio or choose Studio from navigation.

Studio edits only SQL files under:

- sql/sqlite/demos/
- sql/mysql/demos/
- marketplace/*/sqlite/
- marketplace/*/mysql/

Foundational SQL files outside those folders are deliberately excluded.

## Layout

Studio uses a dedicated application layout:

- The application sidebar selects the SQL file, table, or view. The logo returns to the main application home.
- The main panel contains the table form or a read-only view.
- The right panel contains domain types, favorites, and recent types.

On smaller screens the main and right panels stack. The wide column grid scrolls inside the main
panel instead of widening the page.

## Editing Columns

Each row supports a snake-case name, domain type, SQL type, nullability, default, primary
key, auto increment, unique, generated expression, and optional table.column reference.

Changes stay in the form until Save is pressed. Save writes only the selected table and
reloads the page from a fresh parse of the file.

### Add, Reorder, and Remove

- Add column prompts for a raw name and type.
- Clicking a domain type adds its canonical dialect-specific type.
- Types with conventional affixes prompt for a stem.
- Drag the grip to reorder a row.
- Remove opens a confirmation dialog and removes the row from the form.
- Save writes the additions, ordering, and removals.

New columns are inserted before housekeeping columns where possible.

### Hide System Columns

Hide system hides id, display, option_display, created_at, and updated_at. Hidden rows
remain in the form and are still saved. The preference is stored in the browser.

## Domain Types

The palette comes directly from the canonical SQLite or MySQL domain type configuration.
Studio resolves types from metadata embedded at the end of the SQL file first, then
conventional names and affixes.

Recognized patterns include id, name, created_at, updated_at, is_, _image, _file, _at,
_on, _minutes, _hours, _days, _months, and _years.

Favorites and the ten most recently used types are stored locally in the browser.

## DDL Preview

The preview refreshes shortly after a form change. The server validates current form
fields and calls the same writer used by Save, so preview and output match.

## Table Actions

### New Table

Creates the standard id, name, display, created_at, and updated_at columns. On write,
Studio also creates the standard drop, name index, and SQLite updated-at trigger where
applicable.

### Copy Table

Clones the current table definition under a new snake-case name. Related data, indexes,
triggers, and views are not copied.

### Delete Table

After confirmation, Delete immediately removes the table plus matching drop statement,
indexes, triggers, inserts, and generated v_<table> view. Use source control to recover
an accidental deletion.

### Generate View

Creates or replaces v_<table>. Explicit references and conventional *_id columns add
left joins and display aliases. The action writes immediately and opens the generated
read-only view.

## Views

Views are read-only in Studio. Edit one manually in SQL or regenerate it from its table.

## Safety

- Every path is checked against the editable-file allowlist.
- Mutations require Studio module access and a valid CSRF token.
- The server reloads the file before each mutation.
- Raw statements are never trusted from browser state.
- Untouched statements stay byte-identical.
- Domain mappings live in a commented reepolee-studio footer in the SQL file.
