p = "apps/desktop/src/lib/backend/tauri.ts"
s = open(p, encoding="utf-8").read()
bad_start = "export async function listExtensions(connectionId: string, database: string, schema?: string): Promise<ExtensionInfo[]> {\n\nexport interface SynonymTargetInfo {"
assert bad_start in s, "tauri bad block"
new_block = s[s.index("export interface SynonymTargetInfo {"):s.index("  return invoke(\"list_extensions\"")]
new_block = new_block.strip("\n") + "\n"
fixed = (
    "export async function listExtensions(connectionId: string, database: string, schema?: string): Promise<ExtensionInfo[]> {\n"
    "  return invoke(\"list_extensions\", { connectionId, database, schema });\n"
    "}\n"
    "\n"
    "export async function listAvailableExtensions(connectionId: string, database: string): Promise<ExtensionInfo[]> {\n"
    "  return invoke(\"list_available_extensions\", { connectionId, database });\n"
    "}\n"
    "\n"
    + new_block
    + "\n"
)
idx_ext = s.index("export async function listExtensions")
idx_next = s.index("export async function listDialectDataTypes", idx_ext)
s = s[:idx_ext] + fixed + s[idx_next:]
open(p, "w", encoding="utf-8").write(s)
print("tauri.ts fixed")
