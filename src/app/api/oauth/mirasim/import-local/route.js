import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { assertProviderEnabled } from "@/lib/providerDisabled";
import { readLocalMirasimCredentials } from "@/lib/mirasim/decryptLocal";
import { deriveIdentity } from "open-sse/shared/mirasimSigner.js";

/**
 * GET /api/oauth/mirasim/import-local
 * Preflight: report whether the local Mirasim install can be read and decrypted,
 * returning only non-sensitive identifying metadata (never tokens or the device key).
 */
export async function GET() {
  try {
    await assertProviderEnabled("mirasim");
    const creds = readLocalMirasimCredentials();
    let deviceId = null;
    try { deviceId = deriveIdentity(creds.devicePrivateKey).deviceId; } catch { /* non-fatal */ }
    return NextResponse.json({
      found: true,
      name: creds.name || null,
      email: creds.email || null,
      expiresAt: creds.expiresAt || null,
      deviceId,
    });
  } catch (error) {
    return NextResponse.json({ found: false, error: error.message });
  }
}

/**
 * POST /api/oauth/mirasim/import-local
 * Import the locally-installed Mirasim desktop account into 9router by decrypting
 * ~/.mirasim (setting.json + secret.key). Enables app-less use of the Mirasim relay.
 *
 * Must run as the same OS user that installed Mirasim (DPAPI/keychain-scoped).
 * Body: { name?: string }
 */
export async function POST(request) {
  try {
    await assertProviderEnabled("mirasim");
    let name = null;
    try { ({ name } = await request.json()); } catch { /* no body */ }

    const creds = readLocalMirasimCredentials();

    const connection = await createProviderConnection({
      provider: "mirasim",
      authType: "oauth",
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt || undefined,
      name: name || creds.name || creds.email || "Mirasim",
      email: creds.email || undefined,
      providerSpecificData: {
        devicePrivateKey: creds.devicePrivateKey,
        userId: creds.userId || undefined,
        authMethod: "device-signed",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        email: connection.email,
        expiresAt: creds.expiresAt || null,
      },
    });
  } catch (error) {
    console.log("Mirasim local import error:", error);
    return NextResponse.json({ error: error.message }, { status: error.status || 500 });
  }
}
