import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildObjectGroupPlaceholderNodes } from "@/lib/table/tableTree";
import { sidebarObjectKindsForDatabase } from "@/lib/database/databaseObjectCapabilities";

const source = readFileSync(new URL("../CreateJobDialog.vue", import.meta.url), "utf8");

describe("CreateJobDialog", () => {
  it("includes classic job and dbms_scheduler creation support", () => {
    expect(source).toContain("pkg_service.job_submit");
    expect(source).toContain("dbms_scheduler.create_job");
  });

  it("edits classic jobs via pkg_service.job_update and schedulers via dbms_scheduler.update_job", () => {
    // openGauss PKG_SERVICE has no job_change; JOB_UPDATE(id, next_time,
    // interval_time, content) is the documented alter-attributes procedure.
    expect(source).toContain("pkg_service.job_update");
    expect(source).not.toContain("pkg_service.job_change");
    expect(source).toContain("dbms_scheduler.update_job");
  });

  it("never auto-creates the dbms_scheduler compatibility package", () => {
    // The compat package (dbms_scheduler.create_job/update_job/...) must be
    // installed by the user (see README); the dialog only calls it. Creating it
    // here would require sysadmin privileges regular users do not have.
    expect(source).not.toContain("CREATE OR REPLACE PROCEDURE dbms_scheduler");
    expect(source).not.toContain("CREATE SCHEMA IF NOT EXISTS dbms_scheduler");
    expect(source).not.toContain("SECURITY DEFINER");
  });

  it("contains preset intervals and custom expressions", () => {
    expect(source).toContain("sysdate + 1/1440");
    expect(source).toContain("sysdate + 5/1440");
    expect(source).toContain("sysdate + 1/24");
    expect(source).toContain("sysdate + 1");
    expect(source).toContain("TRUNC(sysdate + 1)");
  });

  it("supports open in SQL editor and live preview copy", () => {
    expect(source).toContain('emit("openInEditor"');
    expect(source).toContain("navigator.clipboard.writeText");
  });
});

describe("Table tree job and scheduler group mapping", () => {
  it("lists both JOB and SCHEDULER in openGauss database object capabilities", () => {
    const kinds = sidebarObjectKindsForDatabase("opengauss", "A");
    expect(kinds).toContain("JOB");
    expect(kinds).toContain("SCHEDULER");
  });

  it("generates group-jobs and group-schedulers group placeholder nodes", () => {
    const nodes = buildObjectGroupPlaceholderNodes({
      nodeId: "conn-1:db1:public",
      connectionId: "conn-1",
      database: "db1",
      schema: "public",
      objectTypes: ["JOB", "SCHEDULER"],
    });

    const jobGroup = nodes.find((n) => n.type === "group-jobs");
    const schedulerGroup = nodes.find((n) => n.type === "group-schedulers");

    expect(jobGroup).toBeDefined();
    expect(jobGroup?.label).toBe("tree.jobs");

    expect(schedulerGroup).toBeDefined();
    expect(schedulerGroup?.label).toBe("tree.schedulers");
  });
});
