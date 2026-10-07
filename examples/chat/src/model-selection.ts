interface CatalogChoice {
  models: Array<{ id: string }>;
  defaultModel: string | null;
}

/** Apply changing account defaults while preserving a deliberate model choice. */
export function resolveModelSelection(
  catalog: CatalogChoice,
  currentModel: string,
  explicitlyChosen: boolean,
): { modelId: string; explicitlyChosen: boolean } {
  if (
    explicitlyChosen &&
    catalog.models.some((model) => model.id === currentModel)
  ) {
    return { modelId: currentModel, explicitlyChosen: true };
  }
  const defaultModel = catalog.models.find(
    (model) => model.id === catalog.defaultModel,
  )?.id;
  return {
    modelId: defaultModel ?? catalog.models[0]?.id ?? "",
    explicitlyChosen: false,
  };
}
