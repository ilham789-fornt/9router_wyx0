const DATA_URI_MIME_RE = /data:([^;,\s]+)/gi;
const DATA_URI_VALUE_RE = /data:([^;,\s]+)(?:;[^,\s]*)?,[^\s)]+/gi;

export function capabilityForMime(mime) {
  if (typeof mime !== "string") return null;
  const normalized = mime.toLowerCase();
  if (normalized.startsWith("image/")) return "vision";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.startsWith("audio/")) return "audioInput";
  if (normalized.startsWith("video/")) return "videoInput";
  return null;
}

function mimeFromDataUri(value) {
  if (typeof value !== "string") return null;
  return value.match(/^data:([^;,\s]+)/i)?.[1] || null;
}

export function capabilityForAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  const mime = attachment.contentType
    || attachment.mediaType
    || mimeFromDataUri(attachment.url)
    || mimeFromDataUri(attachment.data);
  return capabilityForMime(mime) || (attachment.url || attachment.data ? "vision" : null);
}

export function capabilitiesFromDataUris(value) {
  const capabilities = new Set();
  if (typeof value !== "string") return capabilities;
  for (const match of value.matchAll(DATA_URI_MIME_RE)) {
    const capability = capabilityForMime(match[1]);
    if (capability) capabilities.add(capability);
  }
  return capabilities;
}

export function stripUnsupportedDataUris(value, capabilities) {
  if (typeof value !== "string") return value;
  DATA_URI_VALUE_RE.lastIndex = 0;
  return value.replace(DATA_URI_VALUE_RE, (uri, mime) => (
    capabilities[capabilityForMime(mime)] === false ? "" : uri
  ));
}
