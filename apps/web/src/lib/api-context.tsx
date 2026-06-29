import { createContext, useContext, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "./api.ts";

const defaultClient = createApiClient();
const ApiContext = createContext<ApiClient>(defaultClient);

export function ApiProvider({ client, children }: { client?: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client ?? defaultClient}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  return useContext(ApiContext);
}
