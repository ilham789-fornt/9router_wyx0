import { NextResponse } from "next/server";
import crypto from "crypto";
import https from "node:https";
import { createProviderConnection } from "@/models";
import { assertProviderEnabled } from "@/lib/providerDisabled";

/**
 * Gemini Web Cookie Authentication
 * POST /api/providers/gemini-web/cookie
 * Body: { cookie: "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=...; ..." }
 *
 * Parses the user-pasted Cookie header, validates the 6 required Google cookies,
 * probes gemini.google.com to confirm the session is alive, then persists the
 * connection. SAPISID is extracted into providerSpecificData for the executor's
 * SAPISIDHASH computation.
 */

const REQUIRED_COOKIES = [
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
];

/**
 * Parse a raw "k=v; k=v" Cookie header into a flat map.
 * Tolerates whitespace and quoted values.
 */
function parseCookieString(raw) {
  const out = {};
  if (typeof raw !== "string") return out;
  const trimmed = raw.replace(/^\s*Cookie\s*:\s*/i, "").trim();
  for (const pair of trimmed.split(/;\s*/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Detect whether the user pasted a cURL command rather than a raw cookie string.
 * Heuristic: starts with "curl " (with optional leading whitespace / newlines),
 * OR contains a recognizable curl flag combo even if pasted with line continuations.
 */
function looksLikeCurl(input) {
  if (typeof input !== "string") return false;
  const head = input.replace(/^[\s\\]+/, "").slice(0, 16).toLowerCase();
  if (head.startsWith("curl ") || head.startsWith("curl.exe ")) return true;
  // Also catch fragments where the user pasted only the flags
  return /(?:^|\s)-(?:H|b|-cookie|-header)\s+['"]/.test(input);
}

/**
 * Extract the Cookie header value from a pasted cURL command.
 * Handles all common shapes that browsers' "Copy as cURL" emits:
 *   - Chrome/Edge:   -H 'Cookie: SID=...; HSID=...; ...'
 *   - Chrome:        -H "Cookie: SID=...; HSID=...; ..." (Windows powershell variant uses ` line continuation)
 *   - Firefox:       --cookie 'SID=...; HSID=...; ...'   OR   -b 'SID=...; ...'
 *   - PowerShell:    --cookie "..." with `^` continuations
 *
 * We collapse line continuations (\, `, ^, and Windows ^\r\n), then run a single
 * regex that finds either Cookie: header or -b/--cookie value.
 */
function extractCookieFromCurl(curlText) {
  if (typeof curlText !== "string") return null;

  // Step 1: collapse line continuations (\, `, ^ at end-of-line) into spaces.
  // Order matters: do "^\n" before stripping standalone carets.
  let collapsed = curlText
    .replace(/\\\r?\n/g, " ")
    .replace(/`\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ");

  // Step 2: Windows cmd-format normalization.
  // Chrome's "Copy as cURL (cmd)" wraps every quoted argument with caret-quotes:
  //   -H ^"cookie: SID=abc; HSID=def^"
  // Inside that ^"...^" wrapper, literal " characters (e.g. inside JSON in
  // --data) appear as \^". Special chars (& | < > ^) inside the wrapper are
  // also caret-escaped: ^&, ^|, ^^ etc. We unwrap by:
  //   a) replacing leading ^" / trailing ^" with plain "
  //   b) un-caret-escaping \^" → \"  and ^^ → ^  and ^& → &  etc.
  collapsed = collapsed
    .replace(/\^"/g, '"') // ^" → "
    .replace(/\^\^/g, "^") // ^^ → ^
    .replace(/\^([&|<>%])/g, "$1"); // ^& ^| ^< ^> ^% → unescaped

  // Step 3: collapse remaining whitespace runs.
  collapsed = collapsed.replace(/\s+/g, " ");

  // Step 4: try every known Cookie-bearing flag shape, ordered by specificity.
  // The /i flag makes "Cookie" case-insensitive (Chrome cmd emits "cookie:").
  const headerPatterns = [
    /(?:-H|--header)\s+'Cookie:\s*([^']+)'/i,           // bash single-quoted
    /(?:-H|--header)\s+"Cookie:\s*((?:[^"\\]|\\.)+)"/i, // bash/cmd double-quoted (after ^" unwrap)
    /(?:-H|--header)\s+\$'Cookie:\s*((?:[^']|\\')+)'/i, // bash $'...' literal
  ];
  for (const re of headerPatterns) {
    const m = collapsed.match(re);
    if (m && m[1]) return m[1].replace(/\\"/g, '"').trim();
  }

  // -b / --cookie 'value' or "value"
  const cookieFlagPatterns = [
    /(?:^|\s)(?:-b|--cookie)\s+'([^']+)'/,
    /(?:^|\s)(?:-b|--cookie)\s+"((?:[^"\\]|\\.)+)"/,
  ];
  for (const re of cookieFlagPatterns) {
    const m = collapsed.match(re);
    if (m && m[1]) return m[1].replace(/\\"/g, '"').trim();
  }

  return null;
}

/**
 * Smart entry point: accepts either a raw Cookie header or a cURL command.
 * Returns { cookieString, source } or null if extraction failed.
 */
function extractCookieAny(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  if (looksLikeCurl(input)) {
    const cookie = extractCookieFromCurl(input);
    if (cookie) return { cookieString: cookie, source: "curl" };
    return null;
  }
  return { cookieString: input, source: "raw" };
}

/**
 * Compute SAPISIDHASH per Google's protocol:
 *   sha1(`${ts} ${sapisid} ${origin}`)
 * Returns "SAPISIDHASH ${ts}_${hash}".
 * Origin must be exactly "https://gemini.google.com".
 */
function makeSapisidHash(sapisid, origin = "https://gemini.google.com") {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash("sha1").update(`${ts} ${sapisid} ${origin}`).digest("hex");
  return `SAPISIDHASH ${ts}_${hash}`;
}

const PROBE_TIMEOUT_MS = 30_000;
// gemini.google.com/app returns ~29 KB of response headers (a ~20 KB
// Content-Security-Policy plus reporting-endpoints). undici/`fetch` enforces a
// 16 KB default and rejects the whole request with "Headers Overflow Error"
// before the status is ever readable, so the probe uses node:https with an
// explicit header budget instead.
const PROBE_MAX_HEADER_BYTES = 256 * 1024;

/**
 * Probe gemini.google.com/app to confirm the session is alive.
 * Returns { ok, status, xsrfToken?, error? } — non-2xx without body means session dead.
 */
function probeSession(cookieString, sapisid) {
  const headers = {
    "Cookie": cookieString,
    "Origin": "https://gemini.google.com",
    "Referer": "https://gemini.google.com/app",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Same-Domain": "1",
  };
  if (sapisid) {
    headers["Authorization"] = makeSapisidHash(sapisid);
  }

  return new Promise((resolve) => {
    const req = https.request(
      "https://gemini.google.com/app",
      { method: "GET", headers, maxHeaderSize: PROBE_MAX_HEADER_BYTES },
      (res) => {
        const status = res.statusCode || 0;
        // Stale cookies bounce to the sign-in flow instead of returning 200.
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ ok: false, status, error: "Session expired or cookies invalid (Google returned redirect/auth error)." });
          return;
        }
        if (status === 401 || status === 403) {
          res.resume();
          resolve({ ok: false, status, error: "Session expired or cookies invalid (Google returned redirect/auth error)." });
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (status === 200) {
            // Heuristic: a logged-in app page contains the SNlM0e token in the
            // HTML. If we see it, we're definitely authenticated. If not, still
            // treat as ok when status is 200, but flag in the response.
            const xsrfMatch = body.match(/"SNlM0e":"([^"]+)"/);
            resolve({ ok: true, status: 200, xsrfToken: xsrfMatch ? xsrfMatch[1] : null });
            return;
          }
          resolve({ ok: false, status, error: `Unexpected upstream status: ${status}` });
        });
        res.on("error", (err) => resolve({ ok: false, status: 0, error: `Network error: ${err.message}` }));
      }
    );
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => resolve({ ok: false, status: 0, error: `Network error: ${err.message}` }));
    req.end();
  });
}

export async function POST(request) {
  try {
    await assertProviderEnabled("gemini-web");
    const { cookie } = await request.json();

    if (!cookie || typeof cookie !== "string") {
      return NextResponse.json({ error: "Cookie string is required" }, { status: 400 });
    }

    // Accept either a raw Cookie header or a pasted cURL command.
    const extracted = extractCookieAny(cookie);
    if (!extracted) {
      return NextResponse.json(
        { error: "Could not find a Cookie header in the pasted text. Paste either the raw Cookie value or a 'Copy as cURL' command from DevTools Network panel." },
        { status: 400 }
      );
    }

    const parsed = parseCookieString(extracted.cookieString);
    const missing = REQUIRED_COOKIES.filter((k) => !parsed[k]);
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing required cookies: ${missing.join(", ")}`, missing },
        { status: 400 }
      );
    }

    // Rebuild a clean, minimal cookie string with only the keys we need to send.
    // Including extra unrelated cookies is fine but we keep it tidy.
    const minimalCookieParts = [];
    for (const key of REQUIRED_COOKIES) {
      minimalCookieParts.push(`${key}=${parsed[key]}`);
    }
    // Some optional Google cookies improve compatibility if present.
    for (const optional of ["__Secure-1PSIDTS", "__Secure-1PSIDCC", "NID", "1P_JAR"]) {
      if (parsed[optional]) minimalCookieParts.push(`${optional}=${parsed[optional]}`);
    }
    const cookieString = minimalCookieParts.join("; ");

    // Probe to confirm session is alive
    const probe = await probeSession(cookieString, parsed.SAPISID);
    if (!probe.ok) {
      return NextResponse.json(
        { error: probe.error || `Session probe failed (HTTP ${probe.status})` },
        { status: 400 }
      );
    }

    const cookies = {};
    for (const key of REQUIRED_COOKIES) cookies[key] = parsed[key];
    for (const optional of ["__Secure-1PSIDTS", "__Secure-1PSIDCC", "NID", "1P_JAR"]) {
      if (parsed[optional]) cookies[optional] = parsed[optional];
    }

    // Persist
    const connection = await createProviderConnection({
      provider: "gemini-web",
      authType: "cookie",
      name: "Gemini Web",
      apiKey: parsed.SAPISID, // Stored for compat with existing single-string apiKey flows; real auth uses SAPISIDHASH
      providerSpecificData: {
        cookies,
        cookieString,
        sapisid: parsed.SAPISID,
        xsrfToken: probe.xsrfToken || null,
        bootstrappedAt: new Date().toISOString(),
      },
      testStatus: "active",
      isActive: true,
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        xsrfBootstrapped: !!probe.xsrfToken,
      },
    });
  } catch (error) {
    console.error("gemini-web cookie auth error:", error);
    return NextResponse.json({ error: error.message }, { status: error.status || 500 });
  }
}
