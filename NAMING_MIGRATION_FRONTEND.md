# Frontend naming compatibility

Implemented in the naming migration branch:

- Product CSS classes/variables, DOM startup markers, frontend UI events and the
  four Tauri application/open-file events use ogdeveloper names at both ends.
- Preferences use ogdeveloper keys. The storage adapter reads the new key first
  (including an empty value), copies a legacy dbx key only after a successful
  write, then removes the consumed legacy key. Writes clear stale legacy keys;
  removals delete the legacy key before the current key, preventing resurrection.
  A quota failure leaves the original readable. Direct localStorage users now
  use this adapter, including diagram drafts, settings, SQL folders and debug logs.
- The pre-bootstrap theme script reads both names with new-name precedence.
- Encrypted exports use ogdeveloper-encrypted. Import accepts dbx-encrypted and
  ogdeveloper-encrypted, and plain configuration import accepts both dbx-config
  and ogdeveloper-config. The crypto algorithm and version remain unchanged.
- VITE_OGDEVELOPER_RESULT_CACHE_BACKEND/FALLBACK override legacy VITE_DBX names.

Intentional compatibility identifiers:

- The physical IndexedDB databases dbx-app-state and dbx-tab-runtime-cache are retained. Opening a
  new database without an atomic, validated migration would abandon saved results.
- Binary cache/archive magic, .dbxresults, MIME types, DBX error codes, hidden
  SQL aliases and external MCP/tunnel/JDBC protocol identifiers remain legacy.
  They require coordinated reader/writer compatibility rather than cosmetic edits.
- Original attribution and actual upstream links remain intact.

Downgrades: localStorage migration consumes old keys. Before running 0.2.6 after
using this version, close all application windows and back up the browser profile,
then copy current ogdeveloper- and ogdeveloper: keys back to their dbx equivalents
(including deleting obsolete old keys). Retaining old application binaries alone
does not preserve preferences written after this upgrade. No automatic downgrade
or user-profile rewriting is performed by this patch.

Validation: 60 frontend regression files / 397 tests passed, 34 additional naming
and editor/diagram regression files / 274 tests passed, and 5 new storage migration
regressions passed. Final frontend typecheck and production build passed (4757 modules, 21.44 s). A real
existing WebView profile upgrade and OS deep-link activation remain release gates.

Final review fix: restored dbx-app-state physical name. A focused IndexedDB
registry simulation runs the actual load/save module against seeded legacy state
and verifies writes stay in the same database (1 test passed). Both IndexedDB
open sites were audited; neither changes the physical database name. This is
not a real WebView/browser profile migration test.
