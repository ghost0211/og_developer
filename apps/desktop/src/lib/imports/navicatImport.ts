import type { ConnectionConfig, DatabaseType, SshTunnelConfig } from "@/types/database";
import { uuid } from "@/lib/common/utils";

type PartialConnection = Omit<ConnectionConfig, "id">;

type MongoReplicaMember = { host: string; port: number };

type ParsedNode = {
  tag: string;
  values: Record<string, string>;
  members: MongoReplicaMember[];
};

const typeMap: Record<string, { dbType: DatabaseType; profile: string; label: string; port: number; user: string }> = {
  // String type identifiers
  postgresql: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  postgres: { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
  opengauss: { dbType: "opengauss", profile: "opengauss", label: "openGauss", port: 5432, user: "gaussdb" },
  gaussdb: { dbType: "opengauss", profile: "opengauss", label: "openGauss", port: 5432, user: "gaussdb" },
  // Numeric type codes (Navicat uses numeric ConnType for some exports)
  "2": { dbType: "postgres", profile: "postgres", label: "PostgreSQL", port: 5432, user: "postgres" },
};

const unsupportedTypes = new Set(["http", "https", "ftp", "sftp", "ssh"]);
let navicatCipherModule: Promise<typeof import("@noble/ciphers/aes.js")> | undefined;

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getAny(values: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = values[normalizeKey(key)];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function getSqlitePath(values: Record<string, string>) {
  return getAny(values, ["databaseFile", "databaseFileName", "databaseFilename", "filename", "fileName", "path", "databasePath", "dbPath", "dbFile", "sqliteFile", "sqlitePath", "database", "databaseName"]);
}

function truthyNavicatFlag(value: string) {
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on", "checked"].includes(normalized);
}

function hexToBytes(hex: string) {
  const clean = hex.trim();
  if (!clean || clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

function stripPkcs7(bytes: Uint8Array) {
  const pad = bytes[bytes.length - 1];
  if (!pad || pad > 16 || pad > bytes.length) return bytes;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

async function decryptNavicatPassword(value: string) {
  const encrypted = hexToBytes(value);
  if (!encrypted?.length) return "";

  const key = new TextEncoder().encode("libcckeylibcckey");
  const iv = new TextEncoder().encode("libcciv libcciv ");
  try {
    const subtle = globalThis.crypto?.subtle;
    const decrypted = subtle ? await decryptNavicatPasswordWithWebCrypto(subtle, encrypted, key, iv) : await decryptNavicatPasswordWithoutWebCrypto(encrypted, key, iv);
    return new TextDecoder().decode(stripPkcs7(decrypted));
  } catch {
    return "";
  }
}

async function decryptNavicatPasswordWithWebCrypto(subtle: SubtleCrypto, encrypted: Uint8Array<ArrayBuffer>, key: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>) {
  const cryptoKey = await subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, encrypted));
}

async function decryptNavicatPasswordWithoutWebCrypto(encrypted: Uint8Array<ArrayBuffer>, key: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>) {
  const { cbc } = await (navicatCipherModule ??= import("@noble/ciphers/aes.js"));
  return cbc(key, iv).decrypt(encrypted);
}

function parseNavicatPort(value: string, fallback: number) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

async function parseSshTunnel(values: Record<string, string>): Promise<({ type: "ssh" } & SshTunnelConfig) | null> {
  const enabled = getAny(values, ["ssh", "useSsh", "sshEnabled", "enableSsh", "useSshTunnel", "sshTunnelEnabled"]);
  if (!truthyNavicatFlag(enabled)) return null;

  const host = getAny(values, ["sshHost", "sshTunnelHost", "tunnelHost"]);
  const user = getAny(values, ["sshUserName", "sshUsername", "sshUser", "sshTunnelUserName", "sshTunnelUsername", "tunnelUserName"]);
  // A half-populated tunnel makes an otherwise valid imported connection unusable.
  if (!host || !user) return null;

  const authValue = normalizeKey(getAny(values, ["sshAuthenMethod", "sshAuthMethod", "sshAuthenticationMethod", "sshAuthentication", "sshAuthType"]));
  const keyPath = getAny(values, ["sshPrivateKey", "sshKeyFile", "sshKeyPath", "sshIdentityFile", "sshTunnelPrivateKey"]);
  const usesKey = authValue.includes("key") || (!authValue.includes("password") && !!keyPath);
  const password = usesKey ? "" : await decryptNavicatPassword(getAny(values, ["sshPassword", "sshTunnelPassword"]));
  const keyPassphrase = usesKey ? await decryptNavicatPassword(getAny(values, ["sshPassphrase", "sshKeyPassphrase", "sshPrivateKeyPassphrase"])) : "";

  return {
    type: "ssh",
    id: uuid(),
    enabled: true,
    host,
    port: parseNavicatPort(getAny(values, ["sshPort", "sshTunnelPort", "tunnelPort"]), 22),
    user,
    password,
    key_path: usesKey ? keyPath : "",
    key_passphrase: keyPassphrase,
    auth_method: usesKey ? "key" : "password",
  };
}

function inferProfile(rawType: string, tag: string, port?: number) {
  const key = normalizeKey(rawType || tag);
  for (const [needle, profile] of Object.entries(typeMap)) {
    if (key.includes(needle)) return profile;
  }
  if (unsupportedTypes.has(key)) return null;
  // Port-based fallback for common default ports
  if (port) {
    if (port === 6379) return typeMap.redis;
    if (port === 27017) return typeMap.mongodb;
    if (port === 5432) return typeMap.postgresql;
    if (port === 3306) return typeMap.mysql;
    if (port === 1433) return typeMap.sqlserver;
    if (port === 1521) return typeMap.oracle;
  }
  return null;
}

function readNode(element: Element): ParsedNode {
  const values: Record<string, string> = {};
  const members: MongoReplicaMember[] = [];
  for (const attr of Array.from(element.attributes)) {
    values[normalizeKey(attr.name)] = attr.value;
  }

  for (const child of Array.from(element.children)) {
    const childTag = normalizeKey(child.tagName);
    if (childTag === "member") {
      const childValues = valuesFromElement(child);
      const memberHost = getAny(childValues, ["hostname", "host", "address"]);
      if (memberHost) {
        members.push({ host: memberHost, port: parseNavicatPort(getAny(childValues, ["port"]), 27017) });
      }
      // Skip flattening so multiple members don't collapse onto one key.
      continue;
    }

    const key = getAny(valuesFromElement(child), ["name", "key", "property", "field"]);
    const value = getAny(valuesFromElement(child), ["value", "val", "text", "data"]) || child.textContent?.trim() || "";
    if (key && value) values[normalizeKey(key)] = value;

    const tag = normalizeKey(child.tagName);
    const text = child.children.length === 0 ? child.textContent?.trim() || "" : "";
    if (text && !values[tag]) values[tag] = text;
    for (const attr of Array.from(child.attributes)) {
      values[`${tag}${normalizeKey(attr.name)}`] = attr.value;
    }
  }

  return { tag: element.tagName, values, members };
}

function valuesFromElement(element: Element) {
  const values: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    values[normalizeKey(attr.name)] = attr.value;
  }
  return values;
}

function isConnectionCandidate(node: ParsedNode) {
  // <Member>/<Advance> are nested metadata, not standalone connections.
  if (["member", "advance"].includes(normalizeKey(node.tag))) return false;
  const type = getAny(node.values, ["connType", "databaseType", "driver", "connectionType", "type"]);
  const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]);
  const host = getAny(node.values, ["host", "server", "hostname", "serverHost", "address"]);
  const file = getSqlitePath(node.values);
  return !!(name || host || file) && !!(type || host || file);
}

async function parseConnection(node: ParsedNode): Promise<ConnectionConfig | null> {
  const rawType = getAny(node.values, ["connType", "databaseType", "driver", "dbType", "connectionType", "type"]);
  const portValue = Number(getAny(node.values, ["port", "serverPort"]));
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : undefined;
  const profile = inferProfile(rawType, node.tag, port);
  if (!profile) {
    const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]) || "(unnamed)";
    console.warn(`[Navicat Import] Skipped connection with unrecognised type: "${name}" (type="${rawType}", tag="${node.tag}", port=${port ?? "N/A"})`);
    return null;
  }

  // Navicat NCX uses ServiceProvider to distinguish vendor-specific database providers.
  // e.g. GaussDB reports ConnType="POSTGRESQL" ServiceProvider="HuaweiCloudGaussDB".
  const serviceProvider = getAny(node.values, ["serviceprovider"]);
  let effectiveProfile = profile;
  if (serviceProvider) {
    const sp = serviceProvider.toLowerCase();
    if (sp.includes("gaussdb") || sp.includes("huaweicloudgauss")) {
      effectiveProfile = { ...profile, dbType: "opengauss", profile: "opengauss", label: "openGauss", port: 8000 };
    }
  }

  const name = getAny(node.values, ["name", "connectionName", "connName", "caption", "title"]) || getAny(node.values, ["host", "server", "hostname"]) || effectiveProfile.label;
  const host = getAny(node.values, ["host", "server", "hostname", "serverHost", "address"]) || "127.0.0.1";
  const database = getAny(node.values, ["database", "databaseName", "initialDatabase", "serviceName", "sid", "schema"]);
  const username = getAny(node.values, ["user", "username", "userName", "uid"]) || profile.user;
  const password = await decryptNavicatPassword(getAny(node.values, ["password"]));
  const keepaliveValue = Number(getAny(node.values, ["keepAliveInterval", "keepaliveInterval", "keepAliveTime", "keepaliveTime"]));
  const keepaliveFlag = getAny(node.values, ["keepAlive", "keepalive", "useKeepAlive", "enableKeepAlive"]);
  const keepaliveEnabled = !keepaliveFlag || truthyNavicatFlag(keepaliveFlag);
  const keepaliveInterval = Number.isFinite(keepaliveValue) && keepaliveValue > 0 && keepaliveEnabled ? keepaliveValue : 0;
  const sshTunnel = await parseSshTunnel(node.values);

  const config: PartialConnection = {
    name,
    db_type: effectiveProfile.dbType,
    driver_profile: effectiveProfile.profile,
    driver_label: effectiveProfile.label,
    url_params: "",
    host,
    port: port || effectiveProfile.port,
    username,
    password,
    database: database || undefined,
    color: "",
    transport_layers: sshTunnel ? [sshTunnel] : [],
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
    keepalive_interval_secs: keepaliveInterval,
    ssl: false,
    connection_string: undefined,
    jdbc_driver_class: undefined,
    jdbc_driver_paths: [],
  };

  return { ...config, id: uuid() };
}

export async function parseNavicatConnections(content: string): Promise<ConnectionConfig[]> {
  const doc = new DOMParser().parseFromString(content, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("Invalid Navicat connection file");

  const seen = new Set<string>();
  const configs: ConnectionConfig[] = [];
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const node = readNode(element);
    if (!isConnectionCandidate(node)) continue;
    const config = await parseConnection(node);
    if (!config) continue;
    const key = [config.name, config.db_type, config.host, config.port, config.database || "", config.connection_string || ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    configs.push(config);
  }
  return configs;
}
