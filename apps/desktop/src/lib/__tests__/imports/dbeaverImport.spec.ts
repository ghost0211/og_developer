import { describe, expect, it } from "vitest";
import type { SidebarLayout, SidebarOrderEntry } from "@/types/database";
import { parseDbeaverConnections, parseDbeaverImport } from "@/lib/imports/dbeaverImport";

function payload(dataSources: Record<string, unknown>) {
  return JSON.stringify({ format: "dbeaver-import", dataSources: JSON.stringify(dataSources) });
}

function pgConnection(id: string, name: string, folder?: string) {
  return {
    id,
    name,
    folder,
    provider: "postgresql",
    driver: "postgres-jdbc",
    configuration: { host: "127.0.0.1", port: 5432, database: name },
  };
}

function layoutLabels(layout: SidebarLayout, connectionNames: Map<string, string>): unknown[] {
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const visit = (entries: SidebarOrderEntry[]): unknown[] => entries.map((entry) => (entry.type === "connection" ? connectionNames.get(entry.id) : { group: groupNames.get(entry.id), children: visit(entry.children ?? []) }));
  return visit(layout.order);
}

describe("DBeaver folder import", () => {
  it("imports PostgreSQL and openGauss connections", async () => {
    const connections = await parseDbeaverConnections(
      payload({
        connections: {
          pg: {
            id: "pg",
            name: "Local Postgres",
            provider: "postgresql",
            driver: "postgres-jdbc",
            configuration: { host: "127.0.0.1", port: 5432, database: "app" },
          },
          og: {
            id: "og",
            name: "Local openGauss",
            provider: "opengauss",
            driver: "opengauss",
            configuration: { host: "127.0.0.1", port: 5432, database: "postgres" },
          },
        },
      }),
    );

    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      name: "Local Postgres",
      db_type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database: "app",
    });
    expect(connections[1]).toMatchObject({
      name: "Local openGauss",
      db_type: "opengauss",
      host: "127.0.0.1",
      port: 5432,
      database: "postgres",
    });
  });

  it("keeps parseDbeaverConnections compatible when no folders exist", async () => {
    const connections = await parseDbeaverConnections(payload({ connections: { root: pgConnection("root", "Root") } }));

    expect(connections).toHaveLength(1);
    expect(connections[0]?.name).toBe("Root");
    expect((await parseDbeaverImport(payload({ connections: {} }))).layout).toBeUndefined();
  });

  it("builds nested groups from declared folders and connection folder paths", async () => {
    const result = await parseDbeaverImport(
      payload({
        folders: {
          Environment: {},
          Region: { parent: "Environment" },
          Team: { parent: "Environment/Region" },
        },
        connections: {
          nested: pgConnection("nested", "Nested", "Environment/Region/Team"),
          root: pgConnection("root", "Root"),
        },
      }),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([
      {
        group: "Environment",
        children: [{ group: "Region", children: [{ group: "Team", children: ["Nested"] }] }],
      },
      "Root",
    ]);
  });

  it("creates implicit parents for intermediate folder path segments", async () => {
    const result = await parseDbeaverImport(
      payload({
        connections: {
          leaf: pgConnection("leaf", "Leaf", "A/B/C"),
        },
      }),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([
      {
        group: "A",
        children: [
          {
            group: "B",
            children: [
              {
                group: "C",
                children: ["Leaf"],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("creates unknown folders referenced only by a connection", async () => {
    const result = await parseDbeaverImport(payload({ connections: { nested: pgConnection("nested", "Nested", "Ad hoc/Production") } }));

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([{ group: "Ad hoc", children: [{ group: "Production", children: ["Nested"] }] }]);
  });
});
