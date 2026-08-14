<div align="center">

# og developer

**An openGauss-specific database development tool — Desktop (Tauri) + Web.**

A deep-customized fork of [dbx](https://github.com/t8y2/dbx), focused on one
database only: openGauss. Dialect details and PL/SQL development experience are
done to the extreme.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Based on](https://img.shields.io/badge/based%20on-dbx-Apache2.0)](https://github.com/t8y2/dbx)

</div>

---

## Why og developer

dbx supports 70+ databases; og developer goes the other way — it strips the
entry surface down to **openGauss only** and invests all effort in:

- **openGauss dialect depth**: PL/SQL-aware statement splitting, A-compatibility
  types, package/synonym catalogs (`gs_package`, `pg_synonym`, `gs_source`),
  source reconstruction, and `sql_compatibility` (A/B/C/PG/M) awareness.
- **PL/SQL development experience**: graphical debugger on `dbe_pldebugger`,
  DBMS_OUTPUT / `RAISE NOTICE` capture, compile-error line mapping, package
  tree with subprogram hierarchy and invalid-object badges.
- **Zero-friction connection**: the official openGauss JDBC driver
  (`org.opengauss.Driver`) is embedded by default, which fixes SHA-256
  authentication out of the box; the native wire protocol remains available.

The upstream dbx codebase is kept intact as much as possible: the connection
type whitelist is the only entry cut — relaxing it restores all other databases.

## Features

### openGauss deep integration

- **Connection**: bundled official JDBC driver (auto-seeded, supports
  `jdbc:opengauss://`), plus the native wire protocol with RAISE NOTICE
  capture (vendored `tokio-postgres` fork).
- **PL/SQL splitter**: openGauss reuses the GaussDB dialect profile — PL/SQL
  blocks, `/` line terminator, dollar-quoted routine bodies — so
  `CREATE PACKAGE BODY` and friends are never chopped by `;`.
- **Object tree**: `PACKAGE` / `PACKAGE_BODY` / `SYNONYM` / `TYPE` / `JOB`
  nodes, package subprogram hierarchy, invalid-object (compile-failed) badges,
  ghost sources, group counts, expand-all, save-as, create templates for
  tables / views / materialized views / packages.
- **Source view**: original `CREATE` text from `gs_source` with `gs_package`
  fallback; package/synonym DDL is reconstructed into executable form and can
  be edited and re-run in a loop.
- **Execution feedback**: DBMS_OUTPUT and `RAISE NOTICE` messages are drained
  through both JDBC and native drivers and shown in the result view;
  compile errors map `LINE n` back to editor positions.
- **A-compatibility types**: `NUMBER`, `VARCHAR2`, `NVARCHAR2`, `RAW`, `BLOB`,
  `BINARY_INTEGER`/`PLS_INTEGER`, `BINARY_FLOAT`, `BINARY_DOUBLE`, `JSONB`,
  `INTERVAL`.
- **Graphical PL/SQL debugger**: breakpoints in the editor, variable table,
  call stack, step/next/continue/finish, based on the `dbe_pldebugger`
  two-session model (verified end-to-end against openGauss-lite 7.0.0-RC3).
- **Compatibility-mode awareness**: `sql_compatibility` is probed after
  connect and drives tree node visibility, editor dialect and info panels
  (A/PG rules verified on a real instance).

### Inherited from dbx

- SQL editor with completion, formatting (with sample preview), bookmarks,
  3-mode search, editor commands, workspace projects.
- Result grid with export, graphical routine calls, sessions, schema browser,
  extension management and more.

## Relationship to upstream

This repository is a **derivative fork of [dbx](https://github.com/t8y2/dbx)**
(Copyright (c) dbx contributors), distributed under the Apache License 2.0.

- All modifications relative to upstream are listed in [NOTICE](NOTICE).
- The full git history of dbx is preserved for complete attribution.
- The product is named "og developer" and does not claim any endorsement by,
  or affiliation with, the dbx project.

### Branches

- `main` — the product line: branding, entry trimming and openGauss features.
- `opengauss-fixes` — a clean, self-contained set of openGauss fixes, kept
  ready to be submitted as pull requests to upstream dbx.

Upstream is tracked as the `upstream` remote and merged periodically.

## Getting started

### Prerequisites

- Node.js 22 (see `.nvmrc`) and pnpm 10
- Rust (stable) for the Tauri backend
- Linux: `webkit2gtk`, `fontconfig` and other Tauri system libraries
- Windows: see [BUILD_WINDOWS.md](BUILD_WINDOWS.md) (MSVC toolchain required)
- NixOS: see [README-NIX.md](README-NIX.md)

### Install & run

```bash
pnpm install          # frontend dependencies
pnpm dev              # frontend dev server (Vite)
pnpm dev:tauri        # desktop app (Tauri)
```

Web mode (frontend + backend separately):

```bash
pnpm dev:web          # web frontend on :5173
pnpm dev:backend      # web backend
```

### Build & package

```bash
pnpm build            # type-check + build frontend
pnpm tauri build      # desktop installer (.deb/.rpm/.msi/...)
```

### Tests

```bash
npx vitest run        # frontend tests
cargo test -p dbx-core --no-default-features \
  --features duckdb-sidecar,mq-admin,sqlite-sqlcipher --lib   # Rust tests
```

A local Docker instance (`openGauss-lite` 7.0.0-RC3, port 5432) is used as
the test target; see the `db-*` targets in the [Makefile](Makefile).

## Documentation

- [OG_DEVELOPER.md](OG_DEVELOPER.md) — repo layout, differences from upstream
- [OPENGAUSS_FIXES.md](OPENGAUSS_FIXES.md) — the openGauss fix set (splitter /
  object tree / source / types), verified against a real 7.0 instance
- [OPENGAUSS_ROADMAP.md](OPENGAUSS_ROADMAP.md) — feature roadmap based on the
  official 6.0 manual and 7.0 hands-on testing
- `docs/` — documentation site (run `make docs` to serve it)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (or
[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)). The cleanest way to give back
is to submit the openGauss fixes from the `opengauss-fixes` branch as PRs to
[upstream dbx](https://github.com/t8y2/dbx).

## License

Apache License 2.0. This project is a derivative work of
[dbx](https://github.com/t8y2/dbx) (Copyright (c) dbx contributors); see
[LICENSE](LICENSE) and [NOTICE](NOTICE).
