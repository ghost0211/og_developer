import { describe, expect, it } from "vitest";
import { getSqlFunctionSignatureHelp, getSqlSignatureCallContext, type SqlCompletionObject } from "@/lib/sql/sqlCompletion";

describe("getSqlSignatureCallContext", () => {
  it("光标在括号内时返回调用名与参数下标", () => {
    const sql = "select count_by_error_code('app', )";
    const ctx = getSqlSignatureCallContext(sql, sql.length - 1);
    expect(ctx).toEqual({ name: "count_by_error_code", argumentIndex: 1 });
  });

  it("schema 限定名原样返回", () => {
    const sql = "select public.gen_random_uuid(";
    expect(getSqlSignatureCallContext(sql, sql.length)).toEqual({ name: "public.gen_random_uuid", argumentIndex: 0 });
  });

  it("嵌套括号取最内层调用", () => {
    const sql = "select coalesce(gen_random_uuid(), ";
    expect(getSqlSignatureCallContext(sql, sql.length)).toEqual({ name: "coalesce", argumentIndex: 1 });
  });

  it("光标不在调用中时返回 null", () => {
    expect(getSqlSignatureCallContext("select 1", 8)).toBeNull();
    const sql = "select count(1)";
    expect(getSqlSignatureCallContext(sql, sql.length)).toBeNull();
  });

  it("字符串里的括号不算调用", () => {
    const sql = "select 'a(b' ";
    expect(getSqlSignatureCallContext(sql, sql.length)).toBeNull();
  });
});

describe("getSqlFunctionSignatureHelp", () => {
  const objects: SqlCompletionObject[] = [
    { name: "count_by_error_code", schema: "app", type: "function", signature: "p_schema text, p_code integer DEFAULT 0" },
    { name: "count_by_error_code", schema: "app", type: "function", signature: "p_code integer" }, // 重载
    { name: "do_work", schema: "app", type: "procedure", signature: "p_id bigint" },
  ];

  it("按名字匹配缓存中的函数签名并高亮当前参数", () => {
    const sql = "select count_by_error_code('x', ";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", objects, "app");
    expect(help).not.toBeNull();
    expect(help!.name).toBe("count_by_error_code");
    expect(help!.overloads).toHaveLength(2);
    expect(help!.overloads[0].signature).toBe("count_by_error_code(p_schema text, p_code integer DEFAULT 0)");
    expect(help!.overloads[0].activeParameter).toBe(1);
  });

  it("schema 限定调用只匹配同 schema 的例程", () => {
    const sql = "call app.do_work(";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", objects, "public");
    expect(help).not.toBeNull();
    // 保留输入时的限定名显示
    expect(help!.overloads[0].signature).toBe("app.do_work(p_id bigint)");
  });

  it("缓存未命中时回退内置函数签名表", () => {
    const sql = "select substr('abc', ";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", [], "public");
    expect(help).not.toBeNull();
    expect(help!.name).toBe("SUBSTR");
  });

  it("限定名不匹配缓存时不回退内置签名", () => {
    const sql = "select app.substr('abc', ";
    expect(getSqlFunctionSignatureHelp(sql, sql.length, "opengauss", [], "public")).toBeNull();
  });
});
