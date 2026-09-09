# ogdeveloper naming migration

Baseline: 0.2.6, commit 069037713225dc56423485b2bbdbeeacb3badfeb.
Branch: codex/ogdeveloper-naming-migration. User approved the broad migration.
Prepared for release 0.2.7 after user authorization. Existing repository and updater signing identity are retained.

## Implemented

- Rust workspace packages/directories/imports/snapshots and Cargo lockfile use
  ogdeveloper, ogdeveloper-core, ogdeveloper-web and ogdeveloper_lib.
- Build, CI, Nix and static Web packaging use the new names; legacy shell
  launchers remain aliases. Existing repository/update endpoints are unchanged.
- Frontend internal CSS, events and storage keys use ogdeveloper. Storage reads
  prefer the current key and consume legacy values only after persisting the new
  value. Clearing a setting clears both names to prevent old data reappearing.
- Frontend and backend encrypted config readers accept both dbx-encrypted and
  ogdeveloper-encrypted. New exports use the new format. Legacy plain config
  import remains supported.
- Both ogdeveloper://connection/new and dbx://connection/new are accepted and
  registered. The existing com.ogdeveloper.app application identity is retained.
- Web OGDEVELOPER_* environment values take precedence, with DBX_* fallback.
  Explicit empty values do not silently fall back to old authentication settings.
  Desktop data-directory selection treats empty path overrides as unset.
- New installations open ogdeveloper.db. Existing dbx.db is used IN PLACE,
  including its SQLite WAL. If both names exist, ogdeveloper.db wins. There is
  no physical database rename/copy and no deletion of the old database.
- Recovery logs use com.ogdeveloper.app; existing legacy recovery markers and
  WebView2 compatibility profiles remain usable. Startup variables accept old
  aliases. New child-process recovery flags use the current prefix.
- Web sessions use ogdeveloper_session, accept legacy cookies, and logout
  invalidates both cookie names and their server-side tokens.
- JDBC package/classes/build/launchers use the new names, with compatibility
  for old cached launcher layouts and environment variables. See validation
  below for bundled-artifact status.

## Intentional legacy identifiers

These are compatibility boundaries, not missed blind replacements:

- Existing SQLite filenames and IndexedDB physical database names.
- Older export/result archive formats, binary magic and hidden result columns.
- dbx:// links, legacy environment names and cookie names in readers/tests.
- External MCP tool names/scope variables, agent error fields and DBX error
  codes, HTTP tunnel protocol fields, and legacy JDBC protocol/launcher aliases.
- NOTICE/copyright/source provenance and real upstream download URLs.
- GitHub App secret identifiers and upstream bot repository configuration;
  migrating those requires independently configured service credentials.

## Upgrade and downgrade behavior

Existing SQL/connection data remains in one live legacy database, so a downgrade
of an upgraded installation does not switch to a stale copied database. A fresh
installation using ogdeveloper.db is not automatically readable by 0.2.6.
Frontend preferences migrated to new keys and new-format exports are also not
promised to be readable by 0.2.6. Keep a pre-upgrade profile/config backup when
validating rollback; do not equate reverting Git with reversing data migration.
No deployed user data has been changed during this development work.

## Validation status

- Frontend: 676 migration/affected regression tests passed, plus 1 new old-IDB
  load/save regression after integration review (registry simulation, not a real
  browser profile). Typecheck and production build passed before that final
  one-line physical-name compatibility correction.
- Rust: 69 storage tests, 5 Web auth tests, 8 JDBC tests and 1 Java environment
  bridging test passed. The pure environment precedence test also passed.
- Java: 75 tests passed; shadowJar and bundleZip succeeded. The tracked desktop
  JDBC ZIP was rebuilt and its extracted Windows launcher returned ok=true to
  a close request.
- Cargo locked/offline workspace check and Bash syntax checks passed in the
  engineering phase; final integration workspace check is recorded below.
- git diff --check passed.

Release gates not exercised: OS installer deep-link activation, upgrade of an
actual existing WebView profile, a real openGauss connection, and Linux/Nix
packaging. The earlier desktop test executable failed at startup with Windows
STATUS_ENTRYPOINT_NOT_FOUND; pure-parser tests and subsequent Rust core/Web
suites passed, but that does not establish desktop UI runtime compatibility.

Final integration: cargo check --offline --locked --workspace --no-default-features passed after all backend changes.
