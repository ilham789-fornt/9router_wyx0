import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { createErrorResult } from "../../utils/error.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

function createTransformedBody({
  providerResponse,
  provider,
  model,
  sourceFormat,
  targetFormat,
  userAgent,
  body,
  connectionId,
  apiKey,
  reqLogger,
  toolNameMap,
  streamController,
  onStreamComplete,
}) {
  const transformStream = buildTransformStream({
    provider,
    sourceFormat,
    targetFormat,
    userAgent,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
  });
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  return pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);
}

function isTinyCodeBuddyCompletion(contentObj, usage) {
  const contentLength = (contentObj?.content || "").trim().length;
  const thinkingLength = (contentObj?.thinking || "").trim().length;
  const outputTokens = Number(
    usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens ?? 0
  );
  return contentLength + thinkingLength <= 40 && outputTokens > 0 && outputTokens <= 10;
}

async function drainReadable(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let error = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (caught) {
    error = caught;
  } finally {
    reader.releaseLock();
  }
  return { chunks, error };
}

function replayChunks(chunks, streamController) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      streamController.handleComplete?.();
      controller.close();
    },
  });
}

function createProbeStreamController(streamController, onError) {
  return {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected?.() ?? true,
    handleComplete: () => {},
    handleError: onError,
    handleDisconnect: (reason) => onError(new Error(String(reason || "probe disconnected"))),
    abort: () => streamController.abort?.(),
  };
}

async function buildCodeBuddyRetryingBody(options) {
  let completion = null;
  let probeError = null;
  const makeProbeOptions = () => ({
    ...options,
    streamController: createProbeStreamController(options.streamController, (error) => {
      probeError ||= error;
    }),
  });
  const firstBody = createTransformedBody({
    ...makeProbeOptions(),
    onStreamComplete: (contentObj, usage, ttftAt) => {
      completion = { contentObj, usage, ttftAt };
    },
  });
  const firstDrain = await drainReadable(firstBody);
  const firstChunks = firstDrain.chunks;
  const firstCompletion = completion;
  const replayFirst = () => {
    options.onStreamComplete?.(
      firstCompletion?.contentObj,
      firstCompletion?.usage,
      firstCompletion?.ttftAt
    );
    return replayChunks(firstChunks, options.streamController);
  };

  if (firstDrain.error || probeError) {
    console.warn(`[CodeBuddy] Initial buffered stream ended early; returning captured bytes: ${(firstDrain.error || probeError)?.message || "unknown error"}`);
    return replayFirst();
  }

  if (!isTinyCodeBuddyCompletion(firstCompletion?.contentObj, firstCompletion?.usage)) {
    return replayFirst();
  }

  console.log(
    `[CodeBuddy] Tiny streaming completion detected; retrying once | model=${options.model} | out=${firstCompletion?.usage?.completion_tokens ?? "?"} | chars=${(firstCompletion?.contentObj?.content || "").trim().length}`
  );
  let retryResult;
  try {
    retryResult = await options.retryProviderResponse();
  } catch (error) {
    console.warn(`[CodeBuddy] Tiny completion retry failed; returning the original stream: ${error?.message || error}`);
    return replayFirst();
  }
  const retryResponse = retryResult?.response;
  const retryContentType = (retryResponse?.headers?.get("content-type") || "").toLowerCase();
  if (!retryResponse?.body || !retryResponse.ok || !retryContentType.includes("text/event-stream")) {
    try { await retryResponse?.body?.cancel(); } catch {}
    console.warn("[CodeBuddy] Tiny completion retry returned an invalid stream; returning the original response");
    return replayFirst();
  }

  completion = null;
  probeError = null;
  let secondDrain;
  try {
    const secondBody = createTransformedBody({
      ...makeProbeOptions(),
      providerResponse: retryResponse,
      onStreamComplete: (contentObj, usage, ttftAt) => {
        completion = { contentObj, usage, ttftAt };
      },
    });
    secondDrain = await drainReadable(secondBody);
  } catch (error) {
    console.warn(`[CodeBuddy] Tiny completion retry stream failed; returning the original response: ${error?.message || error}`);
    return replayFirst();
  }
  if (secondDrain.error || probeError || !completion) {
    const retryError = secondDrain.error || probeError;
    console.warn(`[CodeBuddy] Tiny completion retry stream ended early; returning the original response: ${retryError?.message || "missing terminal completion"}`);
    return replayFirst();
  }
  options.onStreamComplete?.(completion?.contentObj, completion?.usage, completion?.ttftAt);
  return replayChunks(secondDrain.chunks, options.streamController);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId, retryProviderResponse }) {
  // Do not feed provider HTML or plain text into the SSE parser. Besides producing
  // an invalid client stream, that can make the Next.js response pipe fail.
  const upstreamContentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  if (!upstreamContentType.includes("text/event-stream") && !upstreamContentType.includes("application/json")) {
    const upstreamStatus = Number(providerResponse.status);
    const status = upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
    try { await providerResponse.body?.cancel(); } catch {}
    console.warn(`[STREAM] ${provider} | ${model} | blocked non-SSE response (${upstreamContentType}) [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return createErrorResult(status, `[${status}]: Upstream returned a non-SSE response`);
  }

  if (onRequestSuccess) onRequestSuccess();

  const streamOptions = {
    providerResponse,
    provider,
    model,
    sourceFormat,
    targetFormat,
    userAgent,
    body,
    connectionId,
    apiKey,
    reqLogger,
    toolNameMap,
    streamController,
    onStreamComplete,
  };
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  const transformedBody = provider === "codebuddy" && retryProviderResponse
    ? await buildCodeBuddyRetryingBody({ ...streamOptions, retryProviderResponse })
    : createTransformedBody(streamOptions);

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE" });
  };

  return { onStreamComplete, streamDetailId };
}
