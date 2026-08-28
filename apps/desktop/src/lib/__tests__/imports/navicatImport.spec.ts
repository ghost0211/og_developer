import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNavicatConnections } from "@/lib/imports/navicatImport";

class TestElement {
  readonly tagName: string;
  readonly attributes: { name: string; value: string }[];
  readonly children: TestElement[] = [];
  readonly textContent = "";

  constructor(tagName: string, attributes: { name: string; value: string }[]) {
    this.tagName = tagName;
    this.attributes = attributes;
  }
}

class TestDocument {
  private readonly elements: TestElement[];

  constructor(xml: string) {
    this.elements = flattenTestElements(parseTestConnections(xml));
  }

  querySelector(selector: string) {
    return selector === "parsererror" ? null : null;
  }

  querySelectorAll(selector: string) {
    return selector === "*" ? this.elements : [];
  }
}

function flattenTestElements(elements: TestElement[]): TestElement[] {
  return elements.flatMap((element) => [element, ...flattenTestElements(element.children)]);
}

function parseTestConnections(xml: string): TestElement[] {
  const result: TestElement[] = [];
  const connectionRe = /<Connection\b([^>]*?)(\/>|>([\s\S]*?)<\/Connection>)/gi;
  for (const match of xml.matchAll(connectionRe)) {
    const connection = new TestElement("Connection", parseAttributes(match[1] || ""));
    const inner = match[3] || "";
    for (const advanceMatch of inner.matchAll(/<Advance\b([^>]*?)(?:\/>|><\/Advance>)/gi)) {
      connection.children.push(new TestElement("Advance", parseAttributes(advanceMatch[1] || "")));
    }
    result.push(connection);
  }
  return result;
}

class TestDOMParser {
  parseFromString(xml: string) {
    return new TestDocument(xml);
  }
}

function parseAttributes(source: string) {
  return Array.from(source.matchAll(/([^\s=]+)="([^"]*)"/g)).map((match) => ({ name: match[1] || "", value: match[2] || "" }));
}

async function encryptNavicatPassword(value: string) {
  const key = new TextEncoder().encode("libcckeylibcckey");
  const iv = new TextEncoder().encode("libcciv libcciv ");
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, new TextEncoder().encode(value)));
  return Array.from(encrypted, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

if (!globalThis.DOMParser) {
  globalThis.DOMParser = TestDOMParser as typeof DOMParser;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseNavicatConnections", () => {
  it("imports PostgreSQL and openGauss connections", async () => {
    const connections = await parseNavicatConnections(`<Connections>
  <Connection ConnType="POSTGRESQL" ConnectionName="pg-local" Host="localhost" Port="5432" UserName="postgres" Database="app" />
  <Connection ConnType="OPENGAUSS" ConnectionName="og-local" Host="127.0.0.1" Port="5432" UserName="gaussdb" Database="postgres" />
</Connections>`);

    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      name: "pg-local",
      db_type: "postgres",
      host: "localhost",
      port: 5432,
      username: "postgres",
      database: "app",
    });
    expect(connections[1]).toMatchObject({
      name: "og-local",
      db_type: "opengauss",
      host: "127.0.0.1",
      port: 5432,
      username: "gaussdb",
      database: "postgres",
    });
  });

  it("imports password-authenticated SSH tunnels and decrypts both passwords", async () => {
    const databasePassword = await encryptNavicatPassword("database-secret");
    const sshPassword = await encryptNavicatPassword("ssh-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="POSTGRESQL" ConnectionName="pg-over-ssh" Host="db.internal" Port="5432" UserName="dbuser" Password="${databasePassword}" SSH="true" SSH_Host="bastion.example.test" SSH_Port="2202" SSH_UserName="sshuser" SSH_AuthenMethod="PASSWORD" SSH_Password="${sshPassword}" />
</Connections>`);

    expect(connection?.password).toBe("database-secret");
    expect(connection?.transport_layers).toEqual([
      expect.objectContaining({
        type: "ssh",
        enabled: true,
        host: "bastion.example.test",
        port: 2202,
        user: "sshuser",
        password: "ssh-secret",
        auth_method: "password",
      }),
    ]);
  });

  it("imports standard Navicat private-key SSH fields", async () => {
    const keyPassphrase = await encryptNavicatPassword("standard-key-secret");
    const [connection] = await parseNavicatConnections(`<Connections>
  <Connection ConnType="POSTGRESQL" ConnectionName="standard-key-ssh" Host="db.internal" SSH="true" SSH_Host="bastion.example.test" SSH_Port="2222" SSH_UserName="deploy" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="C:\\Users\\deploy\\.ssh\\id_rsa" SSH_Passphrase="${keyPassphrase}" />
</Connections>`);

    expect(connection?.transport_layers).toEqual([
      expect.objectContaining({
        type: "ssh",
        enabled: true,
        host: "bastion.example.test",
        port: 2222,
        user: "deploy",
        password: "",
        key_path: "C:\\Users\\deploy\\.ssh\\id_rsa",
        key_passphrase: "standard-key-secret",
        auth_method: "key",
      }),
    ]);
  });

  it("does not create tunnels when SSH is disabled or required fields are missing", async () => {
    const connections = await parseNavicatConnections(`<Connections>
  <Connection ConnType="POSTGRESQL" ConnectionName="disabled-ssh" Host="db-1.internal" SSH="false" SSH_Host="jump.example.test" SSH_UserName="deploy" />
  <Connection ConnType="POSTGRESQL" ConnectionName="missing-ssh-host" Host="db-2.internal" SSH="true" SSH_UserName="deploy" />
  <Connection ConnType="POSTGRESQL" ConnectionName="missing-ssh-user" Host="db-3.internal" SSH="true" SSH_Host="jump.example.test" />
</Connections>`);

    expect(connections).toHaveLength(3);
    expect(connections.map((connection) => connection.transport_layers)).toEqual([[], [], []]);
  });
});
