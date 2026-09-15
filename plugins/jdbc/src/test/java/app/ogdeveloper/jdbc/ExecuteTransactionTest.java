package app.ogdeveloper.jdbc;

import org.junit.jupiter.api.Test;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.jupiter.api.Assertions.*;

class ExecuteTransactionTest {
    private Connection connection() throws SQLException {
        Connection conn = DriverManager.getConnection("jdbc:h2:mem:" + UUID.randomUUID());
        try (Statement stmt = conn.createStatement()) { stmt.execute("CREATE TABLE tx_items (id INTEGER PRIMARY KEY)"); }
        return conn;
    }
    private int count(Connection conn) throws SQLException {
        try (Statement stmt = conn.createStatement(); ResultSet rows = stmt.executeQuery("SELECT COUNT(*) FROM tx_items")) {
            rows.next(); return rows.getInt(1);
        }
    }
    @Test void commitsAllStatementsAndRestoresAutoCommit() throws Exception {
        try (Connection conn = connection()) {
            assertEquals(2L, OgdeveloperJdbcPlugin.executeTransactionOnConnection(conn,
                    List.of("INSERT INTO tx_items VALUES (1)", "INSERT INTO tx_items VALUES (2)")));
            assertEquals(2, count(conn)); assertTrue(conn.getAutoCommit());
        }
    }
    @Test void rollsBackEarlierStatementWhenLaterStatementFails() throws Exception {
        try (Connection conn = connection()) {
            SQLException failure = assertThrows(SQLException.class, () -> OgdeveloperJdbcPlugin.executeTransactionOnConnection(conn,
                    List.of("INSERT INTO tx_items VALUES (1)", "INSERT INTO tx_items VALUES (1)")));
            assertTrue(failure.getMessage().contains("statement 2"));
            assertEquals("23505", failure.getSQLState()); assertEquals(0, count(conn)); assertTrue(conn.getAutoCommit());
        }
    }
    @Test void refusesAnExistingTransactionWithoutChangingIt() throws Exception {
        try (Connection conn = connection()) {
            conn.setAutoCommit(false);
            try (Statement stmt = conn.createStatement()) { stmt.execute("INSERT INTO tx_items VALUES (9)"); }
            assertThrows(SQLException.class, () -> OgdeveloperJdbcPlugin.executeTransactionOnConnection(conn, List.of("INSERT INTO tx_items VALUES (1)")));
            assertFalse(conn.getAutoCommit()); assertEquals(1, count(conn));
            conn.rollback(); assertEquals(0, count(conn));
        }
    }
    @Test void rejectsTransactionControlBeforeExecutingAnything() throws Exception {
        for (String control : List.of("-- unsafe control\nCOMMIT", "SET AUTOCOMMIT = 1", "SET /* comment */ AUTOCOMMIT = 1")) {
            try (Connection conn = connection()) {
                assertThrows(SQLException.class, () -> OgdeveloperJdbcPlugin.executeTransactionOnConnection(conn,
                        List.of("INSERT INTO tx_items VALUES (1)", control)));
                assertEquals(0, count(conn)); assertTrue(conn.getAutoCommit());
            }
        }
    }
    @Test void closesConnectionInsteadOfRestoringAutoCommitWhenRollbackFails() throws Exception {
        try (Connection delegate = connection()) {
            AtomicBoolean restored = new AtomicBoolean();
            Connection conn = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                if (method.getName().equals("rollback")) throw new SQLException("injected rollback failure");
                if (method.getName().equals("setAutoCommit") && Boolean.TRUE.equals(args[0])) restored.set(true);
                try { return method.invoke(delegate, args); } catch (InvocationTargetException error) { throw error.getCause(); }
            });
            SQLException failure = assertThrows(SQLException.class, () -> OgdeveloperJdbcPlugin.executeTransactionOnConnection(conn,
                    List.of("INSERT INTO tx_items VALUES (1)", "INSERT INTO tx_items VALUES (1)")));
            assertEquals("injected rollback failure", failure.getSuppressed()[0].getMessage());
            assertTrue(delegate.isClosed()); assertFalse(restored.get());
        }
    }
}