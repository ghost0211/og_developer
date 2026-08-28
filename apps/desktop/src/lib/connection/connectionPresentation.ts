import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { OPENGAUSS_JDBC_DRIVER_PROFILE } from "@/lib/database/jdbcDialect";
import { parseGaussdbHosts, serializeGaussdbHosts } from "@/lib/connection/gaussdbHosts";

type ConnectionPresentationConfig = Pick<ConnectionConfig, "db_type" | "driver_profile" | "driver_label" | "host" | "port" | "database">;
type ConnectionNamePresentationConfig = ConnectionPresentationConfig & Pick<ConnectionConfig, "name">;

const REDACTED_HOST_SEGMENT = "***";
const REDACTED_PORT = "****";

export function connectionIconType(connection?: Pick<ConnectionConfig, "db_type" | "driver_profile">): string {
  return connection?.driver_profile || connection?.db_type || "postgres";
}

export function connectionDriverLabel(connection?: Pick<ConnectionConfig, "db_type" | "driver_label">): string {
  return connection?.driver_label || connection?.db_type.toUpperCase() || "";
}

export function connectionEndpointLabel(connection?: ConnectionPresentationConfig): string {
  if (!connection) return "";
  const endpoint = normalizedPresentationEndpoint(connection);
  if (endpoint.host && endpoint.port) {
    // Multi-host format: host1:port1,host2:port2 — already includes ports
    if (endpoint.host.includes(",")) return endpoint.host;
    const endpointHost = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
    return `${endpointHost}:${endpoint.port}`;
  }
  return endpoint.host || connection.database || "";
}

function normalizedPresentationEndpoint(connection: ConnectionPresentationConfig): { host: string; port: number } {
  if (connection.db_type !== "opengauss") return { host: connection.host, port: connection.port };
  return serializeGaussdbHosts(parseGaussdbHosts(connection.host, connection.port));
}

function redactConnectionHost(host: string): string {
  const normalizedHost = host.trim();
  if (!normalizedHost) return "";

  // Multi-host format: host1:port1,host2:port2 — redact each host separately
  // and replace each embedded port with the redacted marker.
  if (normalizedHost.includes(",")) {
    return normalizedHost
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx > 0) {
          return `${redactSingleHost(trimmed.slice(0, colonIdx))}:${REDACTED_PORT}`;
        }
        return redactSingleHost(trimmed);
      })
      .join(",");
  }

  return redactSingleHost(normalizedHost);
}

function redactSingleHost(host: string): string {
  const unwrappedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const separator = unwrappedHost.includes(":") ? ":" : ".";
  const segments = unwrappedHost.split(separator).filter(Boolean);

  if (segments.length >= 3) {
    return [segments[0], ...segments.slice(1, -1).map(() => REDACTED_HOST_SEGMENT), segments[segments.length - 1]].join(separator);
  }

  if (segments.length === 2) {
    return [segments[0], REDACTED_HOST_SEGMENT].join(separator);
  }

  return REDACTED_HOST_SEGMENT;
}

export function connectionRedactedEndpointLabel(connection?: ConnectionPresentationConfig): string {
  if (!connection) return "";

  const endpoint = normalizedPresentationEndpoint(connection);
  const redactedHost = endpoint.host ? redactConnectionHost(endpoint.host) : "";
  if (redactedHost && endpoint.port) {
    // Multi-host format already includes ports
    if (redactedHost.includes(",")) return redactedHost;
    const endpointHost = redactedHost.includes(":") ? `[${redactedHost}]` : redactedHost;
    return `${endpointHost}:${REDACTED_PORT}`;
  }

  return redactedHost || connection.database || "";
}

export function connectionRedactedNameLabel(connection?: ConnectionNamePresentationConfig): string {
  const name = connection?.name.trim() || "";
  if (!connection || !name) return name;

  const host = connection.host.trim();
  if (!host) return name;

  const unwrappedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const hostNames = new Set([host, unwrappedHost]);
  if (connection.port) {
    hostNames.add(`${host}:${connection.port}`);
    if (unwrappedHost.includes(":")) {
      hostNames.add(`[${unwrappedHost}]:${connection.port}`);
    }
  }

  return hostNames.has(name) ? connectionRedactedEndpointLabel(connection) : name;
}

export function connectionDisplayUrlScheme(connection: Pick<ConnectionConfig, "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "ssl">>): string {
  switch (connection.db_type) {
    case "postgres":
      return "postgresql";
    case "opengauss":
      // The JDBC mode keeps upstream pgJDBC branding (jdbc:postgresql://).
      return connection.driver_profile?.toLowerCase() === OPENGAUSS_JDBC_DRIVER_PROFILE ? "jdbc:postgresql" : "postgresql";
    default:
      return connection.db_type;
  }
}

export function connectionUrlPlaceholder(dbType: DatabaseType): string {
  switch (dbType) {
    case "postgres":
      return "postgresql://user:password@host:port/database";

    case "opengauss":
      return "opengauss://user:password@host:port/database";

    case "jdbc":
      return "jdbc:postgresql://host:5432/database";

    default:
      return "postgresql://user:password@host:port/database";
  }
}

export function connectionOptionSubtitle(connection?: ConnectionPresentationConfig): string {
  return [connectionDriverLabel(connection), connectionEndpointLabel(connection)].filter(Boolean).join(" · ");
}

export function connectionRedactedOptionSubtitle(connection?: ConnectionPresentationConfig): string {
  return [connectionDriverLabel(connection), connectionRedactedEndpointLabel(connection)].filter(Boolean).join(" · ");
}
