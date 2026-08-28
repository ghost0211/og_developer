// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { SidebarLayout, SidebarOrderEntry } from "@/types/database";
import { matchDataGripImportFiles, parseDataGripConnections, parseDataGripImport, type DataGripImportPayload } from "@/lib/imports/datagripImport";

function payload(dataSources: string, dataSourcesLocal?: string, dbForestConfig?: string): DataGripImportPayload {
  return { format: "datagrip-import", dataSources, dataSourcesLocal, dbForestConfig };
}

function layoutLabels(layout: SidebarLayout, connectionNames: Map<string, string>): unknown[] {
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const visit = (entries: SidebarOrderEntry[]): unknown[] => entries.map((entry) => (entry.type === "connection" ? connectionNames.get(entry.id) : { group: groupNames.get(entry.id), children: visit(entry.children ?? []) }));
  return visit(layout.order);
}

describe("DataGrip connection import", () => {
  it("imports openGauss and PostgreSQL connections", () => {
    const connections = parseDataGripConnections(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Local openGauss" uuid="og-1">
              <driver-ref>opengauss</driver-ref>
              <jdbc-url>jdbc:opengauss://127.0.0.1:5432/postgres</jdbc-url>
            </data-source>
            <data-source name="Local Postgres" uuid="pg-1">
              <driver-ref>postgresql</driver-ref>
              <jdbc-url>jdbc:postgresql://localhost:5432/app</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      name: "Local openGauss",
      db_type: "opengauss",
      host: "127.0.0.1",
      port: 5432,
      database: "postgres",
    });
    expect(connections[1]).toMatchObject({
      name: "Local Postgres",
      db_type: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
    });
  });

  it("builds nested groups from DataGrip folder configurations", () => {
    const result = parseDataGripImport(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Prod DB" uuid="prod-1">
              <driver-ref>postgresql</driver-ref>
              <jdbc-url>jdbc:postgresql://prod.internal:5432/main</jdbc-url>
            </data-source>
            <data-source name="Dev DB" uuid="dev-1">
              <driver-ref>opengauss</driver-ref>
              <jdbc-url>jdbc:opengauss://dev.internal:5432/main</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(result.connections).toHaveLength(2);
  });

  it("matches DataGrip export files correctly", () => {
    expect(matchDataGripImportFiles(["dataSources.xml", "dataSources.local.xml"])).toBeTruthy();
    expect(() => matchDataGripImportFiles(["other.xml"])).toThrow();
  });
});
