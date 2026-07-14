import type { ModelCallRequestReference } from "./model-reconciliation";

export type ProviderVideoResumeRoute = {
  providerId: string | null;
  model: string | null;
};

export function resolveProviderVideoResumeReference(input: {
  modelCallStatus: string | null | undefined;
  currentRunner: string | null;
  reference: ModelCallRequestReference | null;
  routes: ProviderVideoResumeRoute[];
}) {
  const reference = input.reference;
  if (
    input.modelCallStatus !== "started" ||
    input.currentRunner !== "provider-direct" ||
    reference?.runner !== "provider-direct" ||
    reference.kind !== "video" ||
    !reference.providerTaskId
  ) {
    return null;
  }
  const route = input.routes[reference.routeIndex];
  return route?.providerId === reference.providerId && route.model === reference.model
    ? reference
    : null;
}
