import { describe, expect, it } from "vitest";
import { splitTopLevelSqlStatements, stripCommentOnStatements } from "@/lib/sql/sqlCommentStatements";

describe("splitTopLevelSqlStatements", () => {
  it("splits plain statements and keeps the semicolon", () => {
    expect(splitTopLevelSqlStatements("CREATE TABLE t (id int);\nCREATE INDEX i ON t (id);")).toEqual(["CREATE TABLE t (id int);", "\nCREATE INDEX i ON t (id);"]);
  });

  it("does not split inside string literals, quoted identifiers, dollar bodies or comments", () => {
    const sql = [
      "CREATE TABLE t (note text DEFAULT 'a;b');",
      "COMMENT ON COLUMN t.note IS 'line1\nline2; still comment';",
      `COMMENT ON COLUMN t."weird;col" IS 'x';`,
      "SELECT $$body;with;semis$$;",
      "SELECT E'esc\\';not-end';",
      "-- leading; comment\nSELECT 1;",
      "/* block; /* nested; */ still */ SELECT 2",
    ].join("\n");
    const statements = splitTopLevelSqlStatements(sql);
    expect(statements).toHaveLength(7);
    expect(statements[1]).toContain("line1\nline2; still comment");
    expect(statements[6].trim()).toBe("/* block; /* nested; */ still */ SELECT 2");
  });
});

describe("stripCommentOnStatements", () => {
  it("removes COMMENT ON statements and keeps structural DDL verbatim", () => {
    const ddl = [
      `CREATE TABLE "yi_prod"."prod_menu" (`,
      `  "menu_id" integer NOT NULL,`,
      `  "menu_name" character varying(128) NOT NULL`,
      ");",
      `COMMENT ON TABLE "yi_prod"."prod_menu" IS '产品服务模型-菜单权限点定义';`,
      `COMMENT ON COLUMN "yi_prod"."prod_menu"."menu_id" IS '菜单主键';`,
      `CREATE UNIQUE INDEX "uk_prod_menu_menu_code" ON "yi_prod"."prod_menu" ("menu_code");`,
    ].join("\n");
    const stripped = stripCommentOnStatements(ddl);
    expect(stripped).not.toContain("COMMENT ON");
    expect(stripped).toContain(`CREATE TABLE "yi_prod"."prod_menu" (`);
    expect(stripped).toContain(`CREATE UNIQUE INDEX "uk_prod_menu_menu_code"`);
  });

  it("handles comment text containing semicolons, newlines and fake SQL lines", () => {
    const ddl = "CREATE TABLE t (id int);\nCOMMENT ON TABLE t IS '第一行\nDROP TABLE t; -- 伪装的行\n第二行';";
    const stripped = stripCommentOnStatements(ddl);
    expect(stripped).toBe("CREATE TABLE t (id int);");
  });

  it("keeps inline MySQL-style column comments (not COMMENT ON statements)", () => {
    const ddl = "CREATE TABLE `t` (`id` int COMMENT '主键');";
    expect(stripCommentOnStatements(ddl)).toBe(ddl);
  });

  it("is a no-op when there are no COMMENT ON statements", () => {
    const ddl = `CREATE TABLE "s"."t" (\n  "id" int\n);`;
    expect(stripCommentOnStatements(ddl)).toBe(ddl);
  });

  it("strips comments from synonym + target combined DDL", () => {
    const ddl = [`CREATE OR REPLACE SYNONYM "yi_ddd"."prod_menu" FOR "yi_prod"."prod_menu";`, "", `CREATE TABLE "yi_prod"."prod_menu" (`, `  "menu_id" integer NOT NULL`, ");", `COMMENT ON COLUMN "yi_prod"."prod_menu"."menu_id" IS '菜单主键';`].join("\n");
    const stripped = stripCommentOnStatements(ddl);
    expect(stripped).toContain("CREATE OR REPLACE SYNONYM");
    expect(stripped).toContain(`CREATE TABLE "yi_prod"."prod_menu" (`);
    expect(stripped).not.toContain("COMMENT ON");
  });
});
