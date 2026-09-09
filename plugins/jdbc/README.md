# ogdeveloper JDBC Plugin Prototype

This JDBC sidecar is bundled with the desktop ogdeveloper app. Cached upstream plugins remain supported.

## Build

```sh
./gradlew shadowJar
cp build/libs/ogdeveloper-jdbc-plugin-all.jar lib/ogdeveloper-jdbc-plugin.jar
```

## Package for release

```sh
./package.sh
```

The package version follows the JDBC plugin version in `build.gradle` and `manifest.json`.
The package script writes both `ogdeveloper-jdbc-plugin-<version>.zip` and `ogdeveloper-jdbc-plugin-latest.zip`.

## Install for local ogdeveloper

Copy this folder to the ogdeveloper app data plugin directory:

```text
<ogdeveloper app data>/plugins/jdbc
```

The folder must contain:

```text
manifest.json
bin/ogdeveloper-jdbc-plugin
lib/ogdeveloper-jdbc-plugin.jar
```

The desktop app bundles the openGauss JDBC driver; Java must be installed separately. Install Java locally and add database-specific driver JAR paths in the ogdeveloper JDBC connection form.

The first-class JDBCX profile uses `io.github.jdbcx.WrappedDriver` and
`jdbcx:[extension:][vendor://host:port/database]` URLs. Install a JDBCX Maven bundle such as
`io.github.jdbcx:jdbcx-driver:0.8.0` in the ogdeveloper JDBC driver store, together with the database vendor's JDBC driver.
JDBCX discovers delegate drivers through JDBC `ServiceLoader`/`Driver.acceptsURL`, without vendor-specific ogdeveloper code.
Each connection selects exactly one installed JDBCX runtime bundle; ogdeveloper excludes artifacts from every other installed
JDBCX version from that connection's classpath.

ogdeveloper restricts JDBCX to the `help`, `var`, and `version` extensions by default. Shell, Script, Web, MCP, and other
high-privilege extensions can execute local commands or access external resources, so they require an explicit
per-connection opt-in in the connection dialog.

Some high-privilege extensions require optional runtime libraries that JDBCX deliberately does not bundle. Install
those libraries in the JDBC driver store and select them for the same connection. For JDBCX 0.8.0, MCP requires
`io.github.jdbcx:io.modelcontextprotocol:1.0.1`; use the dependency version declared by the selected JDBCX release.

Launchers prefer nonempty OGDEVELOPER_JAVA_BIN and OGDEVELOPER_JAVA_OPTS, falling back to DBX_JAVA_BIN and DBX_JAVA_OPTS. Existing cached upstream packages remain supported by the app. The Maven resolver uses ~/.ogdeveloper/maven for new installs and reuses ~/.dbx/maven when only that cache exists.

For cross-platform packaging, run ./gradlew bundleZip (gradlew.bat bundleZip on Windows). The result is build/distributions/ogdeveloper-jdbc-plugin-<version>.zip.
