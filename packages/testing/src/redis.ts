import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface TestRedis {
  url: string;
  /** Stops the server (when we started it). */
  stop(): Promise<void>;
  /** Kills the server without cleanup: simulates Redis loss. Only available for servers we started. */
  kill(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() =>
        address && typeof address === 'object'
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
    srv.on('error', reject);
  });
}

/**
 * A Redis for tests. Uses `SOLD_TEST_REDIS_URL` if set (CI service container), otherwise spawns a
 * throwaway `redis-server` on a free port. Returns `null` when neither is possible, so callers can skip.
 */
export async function createTestRedis(): Promise<TestRedis | null> {
  const external = process.env.SOLD_TEST_REDIS_URL;
  if (external) return { url: external, stop: async () => undefined, kill: async () => undefined };

  const port = await freePort();
  let child: ChildProcess;
  try {
    child = spawn(
      'redis-server',
      ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    return null;
  }
  const failed = new Promise<null>((resolve) => child.once('error', () => resolve(null)));
  const ready = waitForPort(port);
  const ok = await Promise.race([ready, failed]);
  if (ok === null) return null;
  const kill = async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
  };
  return { url: `redis://127.0.0.1:${port}`, stop: kill, kill };
}

async function waitForPort(port: number): Promise<true> {
  const { connect } = await import('node:net');
  for (let i = 0; i < 50; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1', () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('redis-server did not start');
}
