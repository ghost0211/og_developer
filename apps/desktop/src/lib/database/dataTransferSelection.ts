export interface TransferDatabaseSelection {
  connectionId: string;
  catalog: string;
  database: string;
}

export function normalizeTransferCatalog(catalog: string): string {
  return catalog.trim();
}

export function isSameTransferDatabase(source: TransferDatabaseSelection, target: TransferDatabaseSelection): boolean {
  return source.connectionId === target.connectionId && source.database === target.database && normalizeTransferCatalog(source.catalog) === normalizeTransferCatalog(target.catalog);
}
