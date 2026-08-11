const activeDesignGlobalExecutions = new Map<string, AbortController>();

function executionKey(projectId: string, jobId: string): string {
  return `${projectId}:${jobId}`;
}

/** Process-local cancellation bridge shared by Main Agent and Export executors. */
export function registerDesignGlobalExecution(
  projectId: string,
  jobId: string,
  controller: AbortController,
): void {
  activeDesignGlobalExecutions.set(executionKey(projectId, jobId), controller);
}

export function unregisterDesignGlobalExecution(projectId: string, jobId: string): void {
  activeDesignGlobalExecutions.delete(executionKey(projectId, jobId));
}

export function abortDesignGlobalExecution(projectId: string, jobId: string, reason: unknown): void {
  activeDesignGlobalExecutions.get(executionKey(projectId, jobId))?.abort(reason);
}
