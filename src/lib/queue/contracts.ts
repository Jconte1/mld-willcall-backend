export type QueueVerifyCustomerResponse = {
  ok: boolean;
  matched: boolean;
  comparedZip5?: string;
  candidateZip5?: string[];
};

export type QueueRowsResponse<T> = {
  rows: T[];
};

export type QueueSingleOrderHeaderResponse = {
  found: boolean;
  row?: Record<string, any> | null;
};

export type QueueOrderLastModifiedResponse = {
  lastModified: string | null;
};

export type QueueErpJobSubmitResponse = {
  jobId: string;
};

export type QueueErpJobStatusResponse<T = unknown> = {
  jobId: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  result?: T;
  error?: string | null;
};
