import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

export interface SqlRoutineParameter {
  declaration: string;
  name?: string;
  mode: string;
}

/** Metadata can contain types, named declarations, modes and SQL default expressions. */
export function parseSqlRoutineParameters(signature = ""): SqlRoutineParameter[] {
  const parts: string[] = [];
  let start = 0;
  for (const token of tokenizeSqlSemantic(signature, "postgres")) {
    if (token.kind === "punctuation" && token.text === "," && token.depth === 0) {
      parts.push(signature.slice(start, token.span.start).trim());
      start = token.span.end;
    }
  }
  parts.push(signature.slice(start).trim());
  return parts.filter(Boolean).map((declaration) => {
    const tokens = tokenizeSqlSemantic(declaration, "postgres").filter((token) => token.kind !== "comment");
    const defaultToken = tokens.find((token) => token.depth === 0 && (token.normalized === "default" || token.text === "="));
    let definition = declaration.slice(0, defaultToken?.span.start).trim();
    let mode = "IN";
    const leadingMode = /^(IN\s+OUT|INOUT|IN|OUT|VARIADIC)\s+/i.exec(definition);
    if (leadingMode) {
      mode = leadingMode[1]!.replace(/\s+/g, "").toUpperCase();
      definition = definition.slice(leadingMode[0].length);
    }
    // These are unnamed multi-word types, not a parameter name followed by its type.
    const multiWordType = /^(?:double\s+precision|(?:character|char|bit)\s+varying|national\s+(?:character|char)(?:\s+varying)?|(?:character|binary)\s+large\s+object|(?:timestamp|time)(?:\s*\([^)]*\))?\s+(?:with|without)\s+time\s+zone|interval\s+(?:year|month|day|hour|minute|second))\b/i.test(
      definition,
    );
    const named = /^("(?:[^"\n]|"")*"|`(?:[^`\n]|``)*`|[\p{L}_][\p{L}\p{N}_$]*)\s+(.+)$/su.exec(definition);
    let name: string | undefined;
    if (named && !multiWordType && !/^[.([%]/.test(named[2]!.trim())) {
      name = named[1];
      const trailingMode = /^(IN\s+OUT|INOUT|IN|OUT|VARIADIC)\b/i.exec(named[2]!);
      if (trailingMode) mode = trailingMode[1]!.replace(/\s+/g, "").toUpperCase();
    }
    return { declaration, name, mode };
  });
}

export function routineCallParameters(signature: string | undefined, routineType: string): SqlRoutineParameter[] {
  return parseSqlRoutineParameters(signature).filter((parameter) => routineType !== "function" || parameter.mode !== "OUT");
}

export function buildSqlRoutineCallSnippet(name: string, signature: string | undefined, routineType: string): string {
  const parameters = routineCallParameters(signature, routineType);
  if (!parameters.length) return `${name}()`;
  const fields = parameters.map((parameter, index) => {
    // Braces cannot be represented in CodeMirror's numbered field names.
    const placeholder = parameter.name && !/[{}]/.test(parameter.name) ? parameter.name : `arg${index + 1}`;
    return `\${${index + 1}:${placeholder}}`;
  });
  // CodeMirror orders numeric fields literally; use the next index, not VS Code's $0.
  return `${name}(${fields.join(", ")})\${${parameters.length + 1}}`;
}
