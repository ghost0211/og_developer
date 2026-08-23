export interface Base64Detection {
  isBase64: boolean;
  text?: string;
  isImage?: boolean;
  imageUrl?: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_SIGNATURES = [
  { prefix: "iVBORw0KGgo", mime: "image/png" },
  { prefix: "/9j/", mime: "image/jpeg" },
  { prefix: "R0lGOD", mime: "image/gif" },
  { prefix: "UklGR", mime: "image/webp" },
] as const;

/** Detect Base64 only when it decodes to valid, mostly printable UTF-8 or a known image. */
export function detectBase64Info(value: string): Base64Detection {
  const normalized = value.trim();
  if (normalized.startsWith("data:image/")) {
    return { isBase64: true, isImage: true, imageUrl: normalized };
  }
  if (normalized.length < 8 || normalized.length % 4 !== 0 || !BASE64_RE.test(normalized)) {
    return { isBase64: false };
  }

  try {
    const raw = atob(normalized);
    const image = IMAGE_SIGNATURES.find(({ prefix }) => normalized.startsWith(prefix));
    if (image) {
      return {
        isBase64: true,
        isImage: true,
        imageUrl: `data:${image.mime};base64,${normalized}`,
      };
    }

    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text || !isMostlyPrintable(text)) return { isBase64: false };
    return { isBase64: true, text, isImage: false };
  } catch {
    return { isBase64: false };
  }
}

function isMostlyPrintable(value: string): boolean {
  const characters = Array.from(value);
  if (characters.length === 0) return false;
  const printable = characters.filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === "\r" || character === "\n" || character === "\t" || (code >= 0x20 && code !== 0x7f);
  }).length;
  return printable / characters.length >= 0.85;
}

export function isWellFormedXml(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || !normalized.startsWith("<") || !normalized.endsWith(">")) return false;

  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(normalized, "application/xml");
    return document.documentElement?.nodeName !== "parsererror" && !document.querySelector("parsererror");
  }

  // Non-browser fallback for unit tests and environments without DOMParser.
  return /^<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?(?:\/>|>[\s\S]*<\/\1\s*>)$/.test(normalized);
}

export function formatXml(xml: string): string {
  let formatted = "";
  let indent = 0;
  const tab = "  ";
  const nodes = xml.replace(/(>)(<)(\/*)/g, "$1\r\n$2$3").split("\r\n");

  for (const node of nodes) {
    const trimmed = node.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("</")) indent = Math.max(0, indent - 1);
    formatted += tab.repeat(indent) + trimmed + "\n";
    if (trimmed.startsWith("<") && !trimmed.startsWith("</") && !trimmed.endsWith("/>") && !trimmed.startsWith("<?") && !trimmed.startsWith("<!--")) {
      indent += 1;
    }
  }
  return formatted.trim();
}

export function isWktGeometryText(value: string): boolean {
  return /^(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*(?:(?:Z|M|ZM)\s*)?(?:\(|EMPTY\b)/i.test(value.trim());
}
