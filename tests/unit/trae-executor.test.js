import { describe, expect, it } from "vitest";

import TraeExecutor from "../../open-sse/executors/trae.js";

describe("TraeExecutor", () => {
  it("uses the SOLO remote-agent endpoint and Cloud-IDE-JWT authentication", () => {
    const executor = new TraeExecutor();
    const headers = executor.buildHeaders({
      accessToken: "trae-token",
      providerSpecificData: { appLanguage: "id", userRegion: "SG" },
    });

    expect(executor.base()).toBe("https://core-normal.trae.ai/api/remote/v1");
    expect(headers.Authorization).toBe("Cloud-IDE-JWT trae-token");
    expect(headers["X-Preferenced-Language"]).toBe("id");
    expect(headers["x-user-region"]).toBe("SG");
  });

  it("keeps work mode distinct from explicit model selection", () => {
    const executor = new TraeExecutor();

    expect(executor.resolveMode("work")).toEqual({ mode: "work", strategy: "auto", modelName: "" });
    expect(executor.resolveMode("gpt-5.4")).toEqual({ mode: "code", strategy: "manual", modelName: "gpt-5.4" });
  });

  it("serializes provider identity fields into SOLO common_params", () => {
    const executor = new TraeExecutor();
    const params = JSON.parse(executor.commonParams({
      scope: "marscode-sg",
      tenant: "tenant-1",
      aiRegion: "SG",
    }, "code", "session-1"));

    expect(params.scope).toBe("marscode-sg");
    expect(params.tenant).toBe("tenant-1");
    expect(params.aiRegion).toBe("SG");
    expect(params.biz_session_id).toBe("session-1");
  });
});
