export function mapZedLiveModels(result) {
  if (!result?.models?.length) return null;
  return {
    models: result.models
      .filter((model) => !model.isDisabled)
      .map((model) => ({
        id: model.id,
        name: model.name,
        capabilities: model.supportsTools ? { tools: true } : undefined,
      })),
  };
}
