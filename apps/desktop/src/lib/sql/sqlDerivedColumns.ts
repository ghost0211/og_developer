import type { SqlCompletionColumn, SqlCompletionContext, SqlCompletionReferencedTable } from "@/lib/sql/sqlCompletion";
import type { SqlSemanticDerivedQuery, SqlSemanticRowSource } from "@/lib/sql/semantic/types";

function referenceForSource(source: SqlSemanticRowSource): SqlCompletionReferencedTable {
  return { name: source.name, alias: source.alias, schema: source.metadataTarget?.schema ?? source.qualifierParts[source.qualifierParts.length - 1], database: source.metadataTarget?.database, columns: source.columns, derivedQuery: source.derivedQuery, columnAliases: source.columnAliases };
}

function wildcardSources(query: SqlSemanticDerivedQuery, qualifier: string[]): SqlSemanticRowSource[] {
  if (!qualifier.length) return query.sources;
  const name = qualifier.join(".").toLowerCase();
  return query.sources.filter((source) => [source.alias, source.name, [...source.qualifierParts, source.name].join(".")].some((candidate) => candidate?.toLowerCase() === name));
}

/** Real metadata dependencies only; a derived alias must never become a catalog query. */
export function getSqlCompletionColumnMetadataTables(context: Pick<SqlCompletionContext, "referencedTables">): SqlCompletionReferencedTable[] {
  const result = new Map<string, SqlCompletionReferencedTable>();
  const visited = new Set<SqlSemanticDerivedQuery>();
  function collect(ref: SqlCompletionReferencedTable) {
    if (ref.derivedQuery) {
      if (visited.has(ref.derivedQuery)) return;
      visited.add(ref.derivedQuery);
      for (const projection of ref.derivedQuery.projections) {
        if (projection.wildcardQualifier) {
          for (const source of wildcardSources(ref.derivedQuery, projection.wildcardQualifier)) collect(referenceForSource(source));
        }
      }
    } else if (ref.columns === undefined) {
      result.set([ref.database, ref.schema, ref.name].join("."), ref);
    }
  }
  for (const ref of context.referencedTables) collect(ref);
  return [...result.values()];
}

/** Expand stars using loaded metadata, retaining the outer query's visible aliases. */
export function resolveSqlCompletionDerivedColumns(context: Pick<SqlCompletionContext, "referencedTables">, metadata: Map<string, SqlCompletionColumn[]>, currentSchema?: string): Map<string, SqlCompletionColumn[]> {
  if (!context.referencedTables.some((ref) => ref.derivedQuery || ref.columns !== undefined)) return metadata;
  const result = new Map(metadata);
  const resolving = new Set<SqlSemanticDerivedQuery>();
  function resolve(ref: SqlCompletionReferencedTable): SqlCompletionColumn[] {
    let columns: SqlCompletionColumn[] = [];
    if (ref.derivedQuery && !resolving.has(ref.derivedQuery)) {
      const query = ref.derivedQuery;
      resolving.add(query);
      for (const projection of query.projections) {
        if (projection.wildcardQualifier) {
          for (const source of wildcardSources(query, projection.wildcardQualifier)) columns.push(...resolve(referenceForSource(source)));
        } else columns.push({ name: projection.name, table: ref.name });
      }
      resolving.delete(query);
    } else if (ref.columns !== undefined) {
      columns = ref.columns.map((name) => ({ name, table: ref.name }));
    } else {
      const schema = ref.schema ?? currentSchema;
      const keys = [ref.database && schema ? `${ref.database}.${schema}.${ref.name}` : undefined, schema ? `${schema}.${ref.name}` : undefined, ref.name];
      for (const key of keys) {
        if (key && metadata.has(key)) {
          columns = metadata.get(key)!;
          break;
        }
      }
    }
    return columns.map((column, index) => ({ ...column, name: ref.columnAliases?.[index] ?? column.name, table: ref.name, schema: ref.schema }));
  }
  for (const ref of context.referencedTables) {
    if (ref.derivedQuery || ref.columns !== undefined) result.set(ref.schema ? `${ref.schema}.${ref.name}` : ref.name, resolve(ref));
  }
  return result;
}
