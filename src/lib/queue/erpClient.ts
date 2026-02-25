export type QueueRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
};

type QueueErpJobSubmitResponse = {
  jobId: string;
};

type QueueErpJobStatusResponse<T> = {
  status: "queued" | "processing" | "succeeded" | "failed";
  result?: T;
  error?: string | null;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

export function shouldUseQueueErp() {
  const raw = (process.env.USE_QUEUE_ERP ?? "").trim().toLowerCase();
  if (!raw) return Boolean(process.env.MLD_QUEUE_BASE_URL);
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

export async function queueErpRequest<T>(path: string, opts: QueueRequestOptions = {}): Promise<T> {
  const base = requireEnv("MLD_QUEUE_BASE_URL").replace(/\/$/, "");
  const token = requireEnv("MLD_QUEUE_TOKEN");
  const method = opts.method ?? "GET";
  const timeoutMs = Number(process.env.MLD_QUEUE_TIMEOUT_MS || opts.timeoutMs || 25000);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const startedAt = Date.now();

  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await resp.text();
    const durationMs = Date.now() - startedAt;

    if (!resp.ok) {
      throw new Error(
        `Queue ERP request failed (${resp.status}) path=${path} ms=${durationMs} body=${text.slice(0, 500)}`
      );
    }

    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function queueErpJobRequest<T>(
  submitPath: string,
  body: unknown,
  opts?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<T> {
  const timeoutMs = Number(process.env.MLD_QUEUE_JOB_POLL_TIMEOUT_MS || opts?.timeoutMs || 8000);
  const pollIntervalMs = Number(process.env.MLD_QUEUE_JOB_POLL_INTERVAL_MS || opts?.pollIntervalMs || 150);
  const startedAt = Date.now();

  const submit = await queueErpRequest<QueueErpJobSubmitResponse>(submitPath, {
    method: "POST",
    body,
    timeoutMs,
  });

  if (!submit?.jobId) {
    throw new Error(`Queue ERP job submit missing jobId path=${submitPath}`);
  }

  while (Date.now() - startedAt < timeoutMs) {
    const status = await queueErpRequest<QueueErpJobStatusResponse<T>>(`/api/erp/jobs/${submit.jobId}`, {
      method: "GET",
      timeoutMs,
    });

    if (status?.status === "succeeded") {
      return (status.result ?? ({} as T)) as T;
    }
    if (status?.status === "failed") {
      throw new Error(
        `Queue ERP job failed path=${submitPath} jobId=${submit.jobId} error=${status.error || "unknown"}`
      );
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Queue ERP job timeout path=${submitPath} timeoutMs=${timeoutMs}`);
}
