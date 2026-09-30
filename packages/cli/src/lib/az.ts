/** Name of the job execution printed by `az containerapp job start -o json`, or '' when unreadable. */
export function readExecutionName(stdout: string | undefined): string {
  try {
    return (JSON.parse(stdout ?? '{}') as { name?: string }).name ?? '';
  } catch {
    return '';
  }
}
