# Changelog

Release-facing changes to Reepolee.

## 2026-07-26 - optional module installation

- Added `bun reeman add-module <name>` to register optional modules with an application.
- Optional modules can now own their installation SQL and browser assets without including them in the core installation.
- Added cross-platform marketplace installers for Studio and configured database execution for chefs-blog seed SQL.
- Added `bun reeman install <archive.tar.gz>` with backup confirmation, platform-specific installer execution, and optional cleanup of the unpacked marketplace folder.

## 2026-07-25 - canonical row display contract

- Added a canonical `display` value for generated tables and views, with optional richer `option_display` labels.
- Improved foreign-key labels and generated CRUD forms and grids.
- Fixed SQLite no-data cloning and tightened global-scope validation.

## 2026-07-24 - Reeman CLI and richer generated forms

- Consolidated generator actions under the interactive and scripted `bun reeman` CLI.
- Added Markdown fields, field hints, replay scripts, and installable marketplace demos.
- Improved the installation flow and added vendored Zod type declarations.

## 2026-07-21 - MIT open-source release preparation

- Released the framework under the MIT License.
- Updated repository metadata, installation documentation, contribution guidance, and security reporting.
