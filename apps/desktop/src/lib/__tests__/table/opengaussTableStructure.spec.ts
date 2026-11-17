import { describe, expect, it } from "vitest";
import {
  augmentCreateTableSqlWithOpenGauss,
  buildOpenGaussAlterTableStatements,
  createDefaultOpenGaussPartitionDraft,
  createDefaultOpenGaussTableOptions,
  fetchOpenGaussTableOptions,
  fetchOpenGaussTablePartitions,
  fetchTableCheckConstraints,
  parsePartitionBoundaries,
  parseReloptions,
  stripCheckConstraintWrapper,
  type EditableTableCheckConstraint,
  type OpenGaussMetadataQueryRunner,
  type OpenGaussTablePartitionMetadata,
} from "@/lib/table/opengaussTableStructure";
import { getTableMetadataCapabilities, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";

describe("opengaussTableStructure", () => {
  describe("parseReloptions", () => {
    it("parses string array format", () => {
      const parsed = parseReloptions(["orientation=row", "storage_type=ustore", "compression=yes", "fillfactor=85"]);
      expect(parsed).toEqual({
        orientation: "row",
        storageType: "ustore",
        compression: "yes",
        fillfactor: 85,
        extraOptions: {},
      });
    });

    it("parses PostgreSQL/openGauss {k=v,...} literal string format", () => {
      const parsed = parseReloptions("{orientation=column,compression=high,autovacuum_enabled=true}");
      expect(parsed).toEqual({
        orientation: "column",
        storageType: "astore",
        compression: "high",
        fillfactor: null,
        extraOptions: {
          autovacuum_enabled: "true",
        },
      });
    });

    it("returns safe defaults for null, empty, or {} input", () => {
      expect(parseReloptions(null)).toEqual({
        orientation: "row",
        storageType: "astore",
        compression: "no",
        fillfactor: null,
        extraOptions: {},
      });
      expect(parseReloptions("{}")).toEqual({
        orientation: "row",
        storageType: "astore",
        compression: "no",
        fillfactor: null,
        extraOptions: {},
      });
    });
  });

  describe("stripCheckConstraintWrapper", () => {
    it("unwraps pg_get_constraintdef CHECK ((...)) cleanly while keeping inner compound parens", () => {
      expect(stripCheckConstraintWrapper("CHECK ((age >= 0))")).toBe("age >= 0");
      expect(stripCheckConstraintWrapper("CHECK (((price > (0)::numeric) AND (qty > 0)))")).toBe("(price > (0)::numeric) AND (qty > 0)");
      expect(stripCheckConstraintWrapper("CHECK ((tag = 'a)b'))")).toBe("tag = 'a)b'");
    });
  });

  describe("parsePartitionBoundaries", () => {
    it("formats RANGE, MAXVALUE, LIST, DEFAULT, and HASH boundaries", () => {
      expect(parsePartitionBoundaries("{2026-01-01}", "range").boundaryDisplay).toBe("VALUES LESS THAN ('2026-01-01')");
      expect(parsePartitionBoundaries("{NULL}", "range").boundaryDisplay).toBe("VALUES LESS THAN (MAXVALUE)");
      expect(parsePartitionBoundaries("{BJ,SH}", "list").boundaryDisplay).toBe("VALUES ('BJ', 'SH')");
      expect(parsePartitionBoundaries("{NULL}", "list").boundaryDisplay).toBe("VALUES (DEFAULT)");
      expect(parsePartitionBoundaries("{0}", "hash").boundaryDisplay).toBe("HASH");
    });
  });

  describe("augmentCreateTableSqlWithOpenGauss", () => {
    const baseCreate = ['CREATE TABLE "public"."orders" (\n  "id" bigint NOT NULL,\n  "created_at" timestamp NOT NULL,\n  "region" varchar(16)\n)'];

    it("injects WITH storage options, PARTITION BY RANGE + INTERVAL + ENABLE ROW MOVEMENT, and CHECK constraints", () => {
      const storageOptions = {
        ...createDefaultOpenGaussTableOptions(),
        orientation: "row" as const,
        storageType: "ustore" as const,
        fillfactor: 90,
      };
      const partitionDraft = {
        ...createDefaultOpenGaussPartitionDraft(),
        enabled: true,
        strategy: "range" as const,
        partitionKeys: ["created_at"],
        interval: "1 month",
        enableRowMovement: true,
        partitions: [{ id: "p1", name: "p_2026_01", boundary: "'2026-02-01'", tablespace: "" }],
      };
      const checks: EditableTableCheckConstraint[] = [
        {
          id: "c1",
          name: "chk_orders_id",
          expression: "id > 0",
          markedForDrop: false,
        },
      ];

      const res = augmentCreateTableSqlWithOpenGauss({
        baseStatements: baseCreate,
        schema: "public",
        tableName: "orders",
        availableColumns: ["id", "created_at", "region"],
        storageOptions,
        partitionDraft,
        checks,
      });

      expect(res.warnings).toEqual([]);
      expect(res.statements).toHaveLength(2);
      expect(res.statements[0]).toContain("WITH (storage_type = ustore, fillfactor = 90)");
      expect(res.statements[0]).toContain(`PARTITION BY RANGE ("created_at") INTERVAL ('1 month') (\n  PARTITION "p_2026_01" VALUES LESS THAN ('2026-02-01')\n)`);
      expect(res.statements[0]).toContain("ENABLE ROW MOVEMENT");
      expect(res.statements[1]).toBe('ALTER TABLE "public"."orders" ADD CONSTRAINT "chk_orders_id" CHECK (id > 0)');
    });

    it("builds PARTITION BY LIST and PARTITION BY HASH clauses", () => {
      const listRes = augmentCreateTableSqlWithOpenGauss({
        baseStatements: baseCreate,
        schema: "public",
        tableName: "orders",
        partitionDraft: {
          ...createDefaultOpenGaussPartitionDraft(),
          enabled: true,
          strategy: "list",
          partitionKeys: ["region"],
          partitions: [
            { id: "p1", name: "p_north", boundary: "'BJ', 'TJ'", tablespace: "" },
            { id: "p2", name: "p_other", boundary: "DEFAULT", tablespace: "" },
          ],
        },
      });
      expect(listRes.warnings).toEqual([]);
      expect(listRes.statements[0]).toContain(`PARTITION BY LIST ("region") (\n  PARTITION "p_north" VALUES ('BJ', 'TJ'),\n  PARTITION "p_other" VALUES (DEFAULT)\n)`);

      const hashCountRes = augmentCreateTableSqlWithOpenGauss({
        baseStatements: baseCreate,
        schema: "public",
        tableName: "orders",
        partitionDraft: {
          ...createDefaultOpenGaussPartitionDraft(),
          enabled: true,
          strategy: "hash",
          partitionKeys: ["id"],
          hashPartitionCount: 4,
          partitions: [],
        },
      });
      expect(hashCountRes.warnings).toEqual([]);
      expect(hashCountRes.statements[0]).toContain('PARTITION BY HASH ("id") PARTITIONS 4');

      const hashNamedRes = augmentCreateTableSqlWithOpenGauss({
        baseStatements: baseCreate,
        schema: "public",
        tableName: "orders",
        partitionDraft: {
          ...createDefaultOpenGaussPartitionDraft(),
          enabled: true,
          strategy: "hash",
          partitionKeys: ["id"],
          partitions: [
            { id: "h0", name: "p_h0", boundary: "", tablespace: "" },
            { id: "h1", name: "p_h1", boundary: "", tablespace: "" },
          ],
        },
      });
      expect(hashNamedRes.warnings).toEqual([]);
      expect(hashNamedRes.statements[0]).toContain('PARTITION BY HASH ("id") (\n  PARTITION "p_h0",\n  PARTITION "p_h1"\n)');
    });

    it("emits warning when orientation=column is combined with storage_type=ustore", () => {
      const res = augmentCreateTableSqlWithOpenGauss({
        baseStatements: baseCreate,
        schema: "public",
        tableName: "orders",
        storageOptions: {
          ...createDefaultOpenGaussTableOptions(),
          orientation: "column",
          storageType: "ustore",
          compression: "middle",
        },
      });
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toContain("USTORE");
    });

    it("does not emit orphan ALTER TABLE statements when baseStatements has no CREATE TABLE yet", () => {
      const res = augmentCreateTableSqlWithOpenGauss({
        baseStatements: [],
        baseWarnings: ["请至少添加一个字段"],
        schema: "public",
        tableName: "orders",
        checks: [{ id: "c1", name: "chk_id", expression: "id > 0", markedForDrop: false }],
      });
      expect(res.statements).toEqual([]);
      expect(res.warnings).toContain("请至少添加一个字段");
    });
  });

  describe("buildOpenGaussAlterTableStatements", () => {
    const samplePartitionMeta: OpenGaussTablePartitionMetadata = {
      tableOid: "16384",
      strategy: "range",
      partitionKeys: ["created_at"],
      interval: "",
      subpartitionCount: 0,
      enableRowMovement: false,
      partitions: [
        {
          oid: "16385",
          name: "p_2025",
          strategy: "range",
          rawBoundaries: ["2026-01-01"],
          boundaryDisplay: "VALUES LESS THAN ('2026-01-01')",
          editableBoundary: "'2026-01-01'",
          tablespace: "",
          estimatedRows: 120,
          sizeBytes: 8192,
          subpartitionCount: 0,
        },
        {
          oid: "16386",
          name: "p_2026",
          strategy: "range",
          rawBoundaries: ["2027-01-01"],
          boundaryDisplay: "VALUES LESS THAN ('2027-01-01')",
          editableBoundary: "'2027-01-01'",
          tablespace: "",
          estimatedRows: 50,
          sizeBytes: 8192,
          subpartitionCount: 0,
        },
      ],
    };

    it("generates CHECK constraint drop, modify, and add statements", () => {
      const res = buildOpenGaussAlterTableStatements({
        schema: "public",
        tableName: "accounts",
        checks: [
          {
            id: "c1",
            name: "chk_old",
            expression: "balance >= 0",
            markedForDrop: true,
            original: { name: "chk_old", definition: "CHECK ((balance >= 0))", expression: "balance >= 0" },
          },
          {
            id: "c2",
            name: "chk_status_v2",
            expression: "status IN (1, 2, 3)",
            markedForDrop: false,
            original: { name: "chk_status", definition: "CHECK ((status IN (1, 2)))", expression: "status IN (1, 2)" },
          },
          {
            id: "c3",
            name: "chk_age",
            expression: "age >= 18",
            markedForDrop: false,
          },
        ],
      });

      expect(res.warnings).toEqual([]);
      expect(res.statements).toEqual([
        'ALTER TABLE "public"."accounts" DROP CONSTRAINT "chk_old"',
        'ALTER TABLE "public"."accounts" DROP CONSTRAINT "chk_status"',
        'ALTER TABLE "public"."accounts" ADD CONSTRAINT "chk_status_v2" CHECK (status IN (1, 2, 3))',
        'ALTER TABLE "public"."accounts" ADD CONSTRAINT "chk_age" CHECK (age >= 18)',
      ]);
    });

    it("generates fillfactor SET / RESET and ENABLE ROW MOVEMENT statements", () => {
      const setRes = buildOpenGaussAlterTableStatements({
        schema: "public",
        tableName: "orders",
        originalStorageOptions: {
          orientation: "row",
          storageType: "ustore",
          compression: "no",
          fillfactor: null,
          tablespace: "",
          enableRowMovement: false,
          isPartitioned: true,
        },
        storageOptions: {
          orientation: "row",
          storageType: "ustore",
          compression: "no",
          fillfactor: 80,
          tablespace: "",
          enableRowMovement: true,
        },
      });

      expect(setRes.warnings).toEqual([]);
      expect(setRes.statements).toEqual(['ALTER TABLE "public"."orders" SET (fillfactor = 80)', 'ALTER TABLE "public"."orders" ENABLE ROW MOVEMENT']);

      const resetRes = buildOpenGaussAlterTableStatements({
        schema: "public",
        tableName: "orders",
        originalStorageOptions: {
          orientation: "row",
          storageType: "astore",
          compression: "no",
          fillfactor: 85,
          tablespace: "",
          enableRowMovement: true,
          isPartitioned: true,
        },
        storageOptions: {
          orientation: "row",
          storageType: "astore",
          compression: "no",
          fillfactor: null,
          tablespace: "",
          enableRowMovement: true,
        },
      });

      expect(resetRes.warnings).toEqual([]);
      expect(resetRes.statements).toEqual(['ALTER TABLE "public"."orders" RESET (fillfactor)']);
    });

    it("generates ADD, SPLIT, TRUNCATE, RENAME, and DROP PARTITION statements with UPDATE GLOBAL INDEX", () => {
      const res = buildOpenGaussAlterTableStatements({
        schema: "public",
        tableName: "orders",
        partitionMetadata: samplePartitionMeta,
        partitionEditDraft: {
          updateGlobalIndex: true,
          pendingOps: [
            {
              id: "op1",
              type: "add",
              partitionName: "p_2027",
              boundary: "2028-01-01",
            },
            {
              id: "op2",
              type: "split",
              partitionName: "p_2026",
              atValue: "'2026-07-01'",
              firstPartitionName: "p_2026_h1",
              secondPartitionName: "p_2026_h2",
            },
            {
              id: "op3",
              type: "truncate",
              partitionName: "p_2025",
            },
            {
              id: "op4",
              type: "rename",
              partitionName: "p_2027",
              newPartitionName: "p_2027_full",
            },
            {
              id: "op5",
              type: "drop",
              partitionName: "p_2025",
            },
          ],
        },
      });

      expect(res.warnings).toEqual([]);
      expect(res.statements).toEqual([
        `ALTER TABLE "public"."orders" ADD PARTITION "p_2027" VALUES LESS THAN ('2028-01-01')`,
        `ALTER TABLE "public"."orders" SPLIT PARTITION "p_2026" AT ('2026-07-01') INTO (PARTITION "p_2026_h1", PARTITION "p_2026_h2") UPDATE GLOBAL INDEX`,
        `ALTER TABLE "public"."orders" TRUNCATE PARTITION "p_2025" UPDATE GLOBAL INDEX`,
        `ALTER TABLE "public"."orders" RENAME PARTITION "p_2027" TO "p_2027_full"`,
        `ALTER TABLE "public"."orders" DROP PARTITION "p_2025" UPDATE GLOBAL INDEX`,
      ]);
    });

    it("prevents dropping the last remaining partition with a validation warning", () => {
      const singlePartitionMeta: OpenGaussTablePartitionMetadata = {
        ...samplePartitionMeta,
        partitions: [samplePartitionMeta.partitions[0]],
      };

      const res = buildOpenGaussAlterTableStatements({
        schema: "public",
        tableName: "orders",
        partitionMetadata: singlePartitionMeta,
        partitionEditDraft: {
          updateGlobalIndex: true,
          pendingOps: [{ id: "d1", type: "drop", partitionName: "p_2025" }],
        },
      });

      expect(res.statements).toEqual([]);
      expect(res.warnings.length).toBe(1);
      expect(res.warnings[0]).toContain("p_2025");
    });

    it("disallows ADD PARTITION on HASH / INTERVAL tables with a warning", () => {
      const hashMeta: OpenGaussTablePartitionMetadata = {
        ...samplePartitionMeta,
        strategy: "hash",
      };
      const res = buildOpenGaussAlterTableStatements({
        schema: "public",
        tableName: "orders",
        partitionMetadata: hashMeta,
        partitionEditDraft: {
          updateGlobalIndex: true,
          pendingOps: [{ id: "a1", type: "add", partitionName: "p_extra", boundary: "10" }],
        },
      });
      expect(res.statements).toEqual([]);
      expect(res.warnings.length).toBe(1);
    });
  });

  describe("catalog fetchers & capabilities", () => {
    it("fetches check constraints, options, and partitions with graceful pg_partition_size fallback", async () => {
      const runner: OpenGaussMetadataQueryRunner = async (sql) => {
        if (sql.includes("pg_constraint")) {
          return {
            columns: ["name", "definition"],
            rows: [["chk_positive", "CHECK ((amount > 0))"]],
          };
        }
        if (sql.includes("c.reloptions")) {
          return {
            columns: ["reloptions", "tablespace", "row_movement"],
            rows: [["{orientation=row,storage_type=ustore,fillfactor=90}", "pg_default", true]],
          };
        }
        if (sql.includes("r.parttype = 'r'")) {
          return {
            columns: ["table_oid", "partstrategy", "partkey", "interval_values", "row_movement"],
            rows: [["24576", "r", "2", null, true]],
          };
        }
        if (sql.includes("pg_attribute")) {
          return {
            columns: ["attnum", "attname"],
            rows: [
              [1, "id"],
              [2, "created_at"],
            ],
          };
        }
        if (sql.includes("pg_partition_size")) {
          throw new Error("function pg_partition_size does not exist");
        }
        if (sql.includes("p.parttype = 'p'")) {
          return {
            columns: ["part_oid", "name", "partstrategy", "boundaries", "tablespace", "estimated_rows", "size_bytes", "subpartition_count"],
            rows: [["24577", "p_max", "r", "{NULL}", null, 42, null, 0]],
          };
        }
        return { columns: [], rows: [] };
      };

      const checks = await fetchTableCheckConstraints(runner, "public", "orders");
      expect(checks).toEqual([
        {
          name: "chk_positive",
          definition: "CHECK ((amount > 0))",
          expression: "amount > 0",
        },
      ]);

      const opts = await fetchOpenGaussTableOptions(runner, "public", "orders");
      expect(opts.storageType).toBe("ustore");
      expect(opts.fillfactor).toBe(90);
      expect(opts.enableRowMovement).toBe(true);

      const parts = await fetchOpenGaussTablePartitions(runner, "public", "orders");
      expect(parts).not.toBeNull();
      expect(parts?.partitionKeys).toEqual(["created_at"]);
      expect(parts?.partitions[0].boundaryDisplay).toBe("VALUES LESS THAN (MAXVALUE)");
    });

    it("enables checks/partitions/options capabilities properly per databaseType", () => {
      const ogCaps = getTableMetadataCapabilities("opengauss");
      expect(ogCaps.checks).toBe(true);
      expect(ogCaps.partitions).toBe(true);
      expect(ogCaps.options).toBe(true);
      expect(isStructureMetadataTabSupported("partitions", ogCaps, true)).toBe(true);
      expect(isStructureMetadataTabSupported("options", ogCaps, false)).toBe(true);

      const pgCaps = getTableMetadataCapabilities("postgres");
      expect(pgCaps.checks).toBe(true);
      expect(pgCaps.partitions).toBe(false);
      expect(pgCaps.options).toBe(false);

      const mysqlCaps = getTableMetadataCapabilities("mysql");
      expect(mysqlCaps.checks).toBe(false);
      expect(mysqlCaps.partitions).toBe(false);
      expect(mysqlCaps.options).toBe(false);
    });
  });
});
