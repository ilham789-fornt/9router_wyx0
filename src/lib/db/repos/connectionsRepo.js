import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function normalizeIdentityValue(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function connectionIdentityKeys(conn = {}) {
  const keys = new Set();
  const email = normalizeIdentityValue(conn.email);
  if (email) keys.add(`email:${email}`);

  const psd = isPlainObject(conn.providerSpecificData) ? conn.providerSpecificData : {};
  for (const field of ["chatgptAccountId", "githubUserId", "profileArn", "machineId"]) {
    const value = normalizeIdentityValue(psd[field]);
    if (value) keys.add(`psd:${field}:${value}`);
  }

  const username = normalizeIdentityValue(psd.username);
  const baseUrl = normalizeIdentityValue(psd.baseUrl);
  if (username && baseUrl) keys.add(`psd:username-baseurl:${username}|${baseUrl}`);

  return keys;
}

function findBackupMergeCandidate(data, existingConnections) {
  const incomingKeys = connectionIdentityKeys(data);
  if (incomingKeys.size === 0) return null;

  const matches = existingConnections.filter((connection) => {
    if (connection.authType !== (data.authType || "oauth")) return false;
    const incomingChatgptId = normalizeIdentityValue(data.providerSpecificData?.chatgptAccountId);
    const existingChatgptId = normalizeIdentityValue(connection.providerSpecificData?.chatgptAccountId);
    if (incomingChatgptId && existingChatgptId && incomingChatgptId !== existingChatgptId) return false;
    const existingKeys = connectionIdentityKeys(connection);
    for (const key of incomingKeys) {
      if (existingKeys.has(key)) return true;
    }
    return false;
  });

  return matches.length === 1 ? matches[0] : null;
}

function mergeDefinedFields(existing, data, now) {
  const merged = { ...existing, updatedAt: now };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (key === "providerSpecificData") continue;
    merged[key] = value;
  }
  if (isPlainObject(existing.providerSpecificData) || isPlainObject(data.providerSpecificData)) {
    merged.providerSpecificData = {
      ...(isPlainObject(existing.providerSpecificData) ? existing.providerSpecificData : {}),
      ...(isPlainObject(data.providerSpecificData) ? data.providerSpecificData : {}),
    };
  }
  return merged;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, c.id]);
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    const all = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingEmail = normalizeIdentityValue(data.email);
      const incomingUsername = normalizeIdentityValue(data.providerSpecificData?.username);
      const incomingWs = normalizeIdentityValue(data.providerSpecificData?.chatgptAccountId);
      existing = all.find(c => {
        if (c.authType !== "oauth" || normalizeIdentityValue(c.email) !== incomingEmail) return false;
        // Workspace providers use account ID only when both identities carry it.
        const existingWs = normalizeIdentityValue(c.providerSpecificData?.chatgptAccountId);
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs || existingWs) return false;

        // Non-workspace providers may expose the same email through distinct IdPs.
        // A username on only one side is evidence of a distinct identity too.
        const existingUsername = normalizeIdentityValue(c.providerSpecificData?.username);
        if (incomingUsername && existingUsername) return incomingUsername === existingUsername;
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name && !data.skipNameDedup) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      const merged = { ...existing, ...data, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = data.email || `Account ${all.length + 1}`;
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    reorderInTx(db, data.provider);
    result = conn;
  });

  return result;
}

export async function mergeProviderConnectionFromBackup(data) {
  if (!data?.provider) return { action: "skipped", connection: null };

  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    const all = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    const existing = data.authType === "apikey" ? null : findBackupMergeCandidate(data, all);

    if (existing) {
      const merged = mergeDefinedFields(existing, data, now);
      upsert(db, merged);
      result = { action: "merged", connection: merged };
      return;
    }
  });

  if (result) return result;

  const created = await createProviderConnection(data);
  return { action: "created", connection: created };
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
