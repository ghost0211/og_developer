import { strict as assert } from "node:assert";
import { test } from "vitest";
import { applyParsedConnectionUrl, parseConnectionUrl } from "../../apps/desktop/src/lib/connection/connectionUrl.ts";
import { connectionUrlPlaceholder } from "../../apps/desktop/src/lib/connection/connectionPresentation.ts";

test("parses postgres connection URLs", () => {
  assert.deepEqual(parseConnectionUrl("postgresql://alice:secret@db.example.com:5433/app?sslmode=require"), {
    dbType: "postgres",
    driverProfile: "postgres",
    driverLabel: "PostgreSQL",
    host: "db.example.com",
    port: 5433,
    username: "alice",
    password: "secret",
    database: "app",
    urlParams: "sslmode=require",
    ssl: true,
  });
});

test("parses opengauss connection URLs", () => {
  assert.deepEqual(parseConnectionUrl("opengauss://alice:secret@db.example.com:5433/app?sslmode=disable"), {
    dbType: "opengauss",
    driverProfile: "opengauss",
    driverLabel: "openGauss",
    host: "db.example.com",
    port: 5433,
    username: "alice",
    password: "secret",
    database: "app",
    urlParams: "sslmode=disable",
    ssl: false,
  });
});

test("shows the openGauss URL scheme in the connection form", () => {
  assert.equal(connectionUrlPlaceholder("opengauss"), "opengauss://user:password@host:port/database");
});

test("parses postgres URLs with encoded credentials", () => {
  const parsed = parseConnectionUrl("postgresql://root:p%40ss@127.0.0.1/shop?sslmode=prefer");

  assert.equal(parsed.dbType, "postgres");
  assert.equal(parsed.driverProfile, "postgres");
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 5432);
  assert.equal(parsed.username, "root");
  assert.equal(parsed.password, "p@ss");
  assert.equal(parsed.database, "shop");
  assert.equal(parsed.urlParams, "sslmode=prefer");
});

test("parses postgres URL name as decoded connection name", () => {
  const parsed = parseConnectionUrl("postgresql://root:123456@localhost/?name=%E5%85%AC%E5%8F%B8+-+%E6%9C%AC%E5%9C%B0Docker&sslmode=prefer");

  assert.equal(parsed.name, "公司 - 本地Docker");
  assert.equal(parsed.host, "localhost");
  assert.equal(parsed.username, "root");
  assert.equal(parsed.password, "123456");
  assert.equal(parsed.urlParams, "sslmode=prefer");
});

test("consumes postgres URL name when it is the only URL param", () => {
  const parsed = parseConnectionUrl("postgresql://root:123456@localhost/?name=%E5%85%AC%E5%8F%B8+-+%E6%9C%AC%E5%9C%B0Docker");

  assert.equal(parsed.name, "公司 - 本地Docker");
  assert.equal(parsed.urlParams, "");
});

test("removes only the connection name from URL params", () => {
  const parsed = parseConnectionUrl("postgresql://root@localhost/app?Name=Analytics+Local&sslmode=require");

  assert.equal(parsed.name, "Analytics Local");
  assert.equal(parsed.database, "app");
  assert.equal(parsed.urlParams, "sslmode=require");
  assert.equal(parsed.ssl, true);
});

test("parses postgres TLS URL params into the SSL switch state", () => {
  assert.equal(parseConnectionUrl("postgresql://root@db.example.com:5432/test?sslmode=require").ssl, true);
  assert.equal(parseConnectionUrl("opengauss://root@db.example.com:5432/test?sslmode=verify-full").ssl, true);
  assert.equal(parseConnectionUrl("postgresql://root@db.example.com:5432/test?sslmode=disable").ssl, false);
});

test("parses JDBC URLs by using the inner database URL", () => {
  const postgres = parseConnectionUrl("jdbc:postgresql://alice:secret@db.example.com:5433/app?sslmode=require");
  assert.equal(postgres.dbType, "postgres");
  assert.equal(postgres.driverProfile, "postgres");
  assert.equal(postgres.host, "db.example.com");
  assert.equal(postgres.port, 5433);
  assert.equal(postgres.username, "alice");
  assert.equal(postgres.password, "secret");
  assert.equal(postgres.database, "app");
  assert.equal(postgres.urlParams, "sslmode=require");
});

test("applies parsed postgres URLs over the edited connection", () => {
  const parsed = parseConnectionUrl("postgresql://alice:secret@db.example.com:5433/app");
  const applied = applyParsedConnectionUrl({ name: "hq", db_type: "postgres", username: "", password: "" } as any, parsed);

  assert.equal(applied.db_type, "postgres");
  assert.equal(applied.host, "db.example.com");
  assert.equal(applied.port, 5433);
  assert.equal(applied.database, "app");
  assert.equal(applied.username, "alice");
  assert.equal(applied.password, "secret");
  assert.equal(applied.name, "hq");
});

test("rejects unsupported URL schemes", () => {
  assert.throws(() => parseConnectionUrl("ftp://example.com"), /Unsupported connection URL scheme/);
});
