export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startTelemetry } = await import('./instrumentation.node');
  startTelemetry();
}
