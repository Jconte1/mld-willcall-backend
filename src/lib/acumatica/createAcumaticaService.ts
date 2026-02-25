import AcumaticaService from "./auth/acumaticaService";
import { shouldUseQueueErp } from "../queue/erpClient";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

export function createAcumaticaService() {
  if (shouldUseQueueErp()) {
    return {
      baseUrl: "",
      getToken: async () => "",
    } as unknown as AcumaticaService;
  }

  return new AcumaticaService(
    requireEnv("ACUMATICA_BASE_URL"),
    requireEnv("ACUMATICA_CLIENT_ID"),
    requireEnv("ACUMATICA_CLIENT_SECRET"),
    requireEnv("ACUMATICA_USERNAME"),
    requireEnv("ACUMATICA_PASSWORD")
  );
}