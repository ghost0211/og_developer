import type { ConnectionConfig, DatabaseType } from "@/types/database";

export interface ParsedConnectionUrl {
  name?: string;
  dbType: DatabaseType;
  driverProfile: string;
  driverLabel: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  urlParams: string;
  ssl: boolean;
  connectionString?: string;
}

export type ConnectionProfile = {
  type: DatabaseType;
  profile: string;
  label: string;
  defaultPort: number;
};

const SCHEME_PROFILES: Record<string, ConnectionProfile> = {
  postgres: { type: "postgres", profile: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  postgresql: { type: "postgres", profile: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  opengauss: { type: "opengauss", profile: "opengauss", label: "openGauss", defaultPort: 5432 },
};

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function databaseFromPath(pathname: string): string | undefined {
  const value = pathname.replace(/^\/+/, "");
  if (!value) return undefined;
  return decodeUrlPart(value.split("/")[0]);
}

function queryParamValue(params: string, key: string): string | undefined {
  for (const part of params.split(/[&;]/)) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split("=");
    if (decodeUrlPart(rawKey).toLowerCase() === key.toLowerCase()) {
      return decodeUrlPart(rest.join("=")).trim();
    }
  }
  return undefined;
}

function connectionNameParam(parsed: URL): string | undefined {
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() === "name") {
      const name = value.trim();
      if (name) return name;
    }
  }
  return undefined;
}

function stripConnectionNameParam(params: string): string {
  if (!params) return params;
  return params
    .split("&")
    .filter((part) => {
      if (!part) return true;
      const [rawKey] = part.split("=");
      return decodeUrlPart(rawKey).trim().toLowerCase() !== "name";
    })
    .join("&");
}

function urlParamsRequireTls(dbType: DatabaseType, params: string): boolean {
  if (dbType === "postgres" || dbType === "opengauss") {
    const sslMode = (queryParamValue(params, "sslmode") || "").toLowerCase();
    return sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
  }

  return false;
}

export function connectionProfileForScheme(scheme: string): ConnectionProfile | undefined {
  return SCHEME_PROFILES[scheme];
}

export function parseConnectionUrl(value: string): ParsedConnectionUrl {
  const input = value.trim();
  if (!input) {
    throw new Error("Connection URL is empty");
  }
  const isJdbcUrl = /^jdbc:/i.test(input);
  const source = isJdbcUrl ? input.replace(/^jdbc:/i, "") : input;

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("Invalid connection URL");
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  const profile = connectionProfileForScheme(scheme);
  if (!profile) {
    throw new Error(`Unsupported connection URL scheme: ${scheme}`);
  }

  const urlParams = parsed.search.replace(/^\?/, "");
  const name = connectionNameParam(parsed);
  const urlParamsWithoutName = stripConnectionNameParam(urlParams);

  return {
    ...(name ? { name } : {}),
    dbType: profile.type,
    driverProfile: profile.profile,
    driverLabel: profile.label,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : profile.defaultPort,
    username: decodeUrlPart(parsed.username),
    password: decodeUrlPart(parsed.password),
    database: databaseFromPath(parsed.pathname),
    urlParams: urlParamsWithoutName,
    ssl: urlParamsRequireTls(profile.type, urlParamsWithoutName),
  };
}

export function applyParsedConnectionUrl(config: Omit<ConnectionConfig, "id">, parsed: ParsedConnectionUrl): Omit<ConnectionConfig, "id"> {
  return {
    ...config,
    db_type: parsed.dbType,
    driver_profile: parsed.driverProfile,
    driver_label: parsed.driverLabel,
    host: parsed.host,
    port: parsed.port,
    name: parsed.name?.trim() || config.name,
    username: parsed.username,
    password: parsed.password,
    database: parsed.database,
    url_params: parsed.urlParams,
    ssl: parsed.ssl,
    connection_string: parsed.connectionString,
    external_config: config.external_config,
  };
}
