package com.dbx.agent;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class JdbcDatabaseInfo {
    private static final String OPENGAUSS_VERSION_SQL = "SELECT version()";
    private static final Pattern OPENGAUSS_VERSION_PATTERN = Pattern.compile("(?i)(?:openGauss|GaussDB)\\s+([0-9]+(?:\\.[0-9]+)+)");
    private JdbcDatabaseInfo() {
    }

    static Map<String, String> from(Connection connection) {
        if (connection == null) {
            return Collections.emptyMap();
        }

        final DatabaseMetaData metadata;
        try {
            metadata = connection.getMetaData();
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return Collections.emptyMap();
        }
        if (metadata == null) {
            return Collections.emptyMap();
        }

        Map<String, String> info = new LinkedHashMap<>();
        putText(info, "productName", () -> metadata.getDatabaseProductName());
        putText(info, "productVersion", () -> metadata.getDatabaseProductVersion());
        putIdentifierCase(
            info,
            "unquotedIdentifierCase",
            () -> metadata.storesLowerCaseIdentifiers(),
            () -> metadata.storesUpperCaseIdentifiers(),
            () -> metadata.storesMixedCaseIdentifiers()
        );
        putIdentifierCase(
            info,
            "quotedIdentifierCase",
            () -> metadata.storesLowerCaseQuotedIdentifiers(),
            () -> metadata.storesUpperCaseQuotedIdentifiers(),
            () -> metadata.storesMixedCaseQuotedIdentifiers()
        );
        putText(info, "driverName", () -> metadata.getDriverName());
        putText(info, "driverVersion", () -> metadata.getDriverVersion());

        Integer jdbcMajor = readInteger(() -> metadata.getJDBCMajorVersion());
        Integer jdbcMinor = readInteger(() -> metadata.getJDBCMinorVersion());
        if (jdbcMajor != null && jdbcMinor != null && jdbcMajor >= 0 && jdbcMinor >= 0) {
            info.put("jdbcVersion", jdbcMajor + "." + jdbcMinor);
        }

        // PostgreSQL-compatible openGauss JDBC drivers commonly expose the
        // wire-compatibility identity (PostgreSQL 9.2.4) through JDBC metadata.
        // Ask the server for its product banner so callers can show the real
        // openGauss release instead of that protocol baseline.
        if ("postgresql".equalsIgnoreCase(info.get("productName"))) {
            String openGaussVersion = queryOpenGaussVersion(connection);
            if (openGaussVersion != null) {
                info.put("productName", "openGauss");
                info.put("productVersion", openGaussVersion);
            }
        }
        return info;
    }

    private static String queryOpenGaussVersion(Connection connection) {
        try (Statement statement = connection.createStatement()) {
            if (statement == null) {
                return null;
            }
            try {
                statement.setQueryTimeout(5);
            } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
                // Some older JDBC drivers do not implement statement timeouts;
                // the outer metadata call must still get a chance to read the banner.
            }
            try (ResultSet result = statement.executeQuery(OPENGAUSS_VERSION_SQL)) {
                if (result == null || !result.next()) {
                    return null;
                }
                String banner = result.getString(1);
                if (banner == null) {
                    return null;
                }
                Matcher matcher = OPENGAUSS_VERSION_PATTERN.matcher(banner.trim());
                return matcher.find() ? matcher.group(1) : null;
            }
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return null;
        }
    }

    private static void putText(Map<String, String> target, String key, SqlSupplier<String> supplier) {
        String value = read(supplier);
        if (value != null && !value.trim().isEmpty()) {
            target.put(key, value.trim());
        }
    }

    private static void putIdentifierCase(
        Map<String, String> target,
        String key,
        SqlSupplier<Boolean> lower,
        SqlSupplier<Boolean> upper,
        SqlSupplier<Boolean> mixed
    ) {
        if (Boolean.TRUE.equals(read(lower))) {
            target.put(key, "lower");
        } else if (Boolean.TRUE.equals(read(upper))) {
            target.put(key, "upper");
        } else if (Boolean.TRUE.equals(read(mixed))) {
            target.put(key, "mixed");
        }
    }

    private static Integer readInteger(SqlSupplier<Integer> supplier) {
        return read(supplier);
    }

    private static <T> T read(SqlSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return null;
        }
    }

    private interface SqlSupplier<T> {
        T get() throws SQLException;
    }
}
