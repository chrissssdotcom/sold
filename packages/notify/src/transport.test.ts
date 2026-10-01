import { createServer, type Server } from 'node:http';
import { createServer as createTcp, type Server as TcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailTransportError, PostmarkTransport, SmtpTransport } from './transport';

const msg = {
  from: 'Shop <shop@example.test>',
  to: 'buyer@example.test',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  idempotencyKey: 'evt-1:welcome',
};

let http: Server | undefined;
let tcp: TcpServer | undefined;
afterEach(() => {
  http?.close();
  tcp?.close();
  http = tcp = undefined;
});

function fakePostmark(
  handler: (body: Record<string, unknown>, token: string) => { status: number; json: unknown },
) {
  return new Promise<{ url: string; calls: Record<string, unknown>[] }>((resolve) => {
    const calls: Record<string, unknown>[] = [];
    http = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        calls.push(body);
        const r = handler(body, String(req.headers['x-postmark-server-token']));
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
      });
    }).listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(http!.address() as { port: number }).port}`, calls }),
    );
  });
}

describe('PostmarkTransport (against a local fake of the documented API)', () => {
  it('sends the documented shape and returns the provider id', async () => {
    const f = await fakePostmark(() => ({
      status: 200,
      json: { ErrorCode: 0, MessageID: 'pm-123' },
    }));
    const r = await new PostmarkTransport('tok', f.url).send(msg);
    expect(r.providerId).toBe('pm-123');
    expect(f.calls[0]).toMatchObject({
      From: msg.from,
      To: msg.to,
      Subject: 'Hello',
      HtmlBody: '<p>Hi</p>',
      TextBody: 'Hi',
    });
  });

  it('classifies rejections as permanent and provider trouble as transient', async () => {
    const bad = await fakePostmark(() => ({
      status: 422,
      json: { ErrorCode: 300, Message: 'Invalid email request' },
    }));
    await expect(new PostmarkTransport('t', bad.url).send(msg)).rejects.toMatchObject({
      permanent: true,
    });
    http?.close();
    const busy = await fakePostmark(() => ({ status: 429, json: { Message: 'slow down' } }));
    await expect(new PostmarkTransport('t', busy.url).send(msg)).rejects.toMatchObject({
      permanent: false,
    });
    http?.close();
    const down = await fakePostmark(() => ({ status: 503, json: {} }));
    await expect(new PostmarkTransport('t', down.url).send(msg)).rejects.toMatchObject({
      permanent: false,
    });
  });

  it('treats a network failure as transient', async () => {
    const err = await new PostmarkTransport('t', 'http://127.0.0.1:1')
      .send(msg)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailTransportError);
    expect((err as EmailTransportError).permanent).toBe(false);
  });
});

/** A just-enough SMTP server: accepts one message and records the DATA. */
function fakeSmtp(rcptReply = '250 OK') {
  return new Promise<{ url: string; data: () => string }>((resolve) => {
    let captured = '';
    tcp = createTcp((socket) => {
      let inData = false;
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', (chunk) => {
        const text = chunk.toString();
        if (inData) {
          captured += text;
          if (/\r\n\.\r\n$/.test(captured)) {
            inData = false;
            socket.write('250 queued as FAKE1\r\n');
          }
          return;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-fake\r\n250 8BITMIME\r\n');
          else if (cmd === 'MAIL') socket.write('250 OK\r\n');
          else if (cmd === 'RCPT') socket.write(`${rcptReply}\r\n`);
          else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    }).listen(0, '127.0.0.1', () =>
      resolve({
        url: `smtp://127.0.0.1:${(tcp!.address() as { port: number }).port}`,
        data: () => captured,
      }),
    );
  });
}

describe('SmtpTransport (against a minimal local SMTP server)', () => {
  it('delivers a multipart message with a Message-ID derived from the idempotency key', async () => {
    const s = await fakeSmtp();
    const t = new SmtpTransport(s.url);
    const r = await t.send(msg);
    t.close();
    expect(r.providerId).toContain('evt-1-welcome@sold.invalid');
    expect(s.data()).toContain('Subject: Hello');
    expect(s.data()).toContain('Message-ID: <evt-1-welcome@sold.invalid>');
    expect(s.data()).toContain('text/html');
    expect(s.data()).toContain('text/plain');
  });

  it('a 5xx recipient rejection is permanent', async () => {
    const s = await fakeSmtp('550 no such user');
    const t = new SmtpTransport(s.url);
    const err = await t.send(msg).catch((e: unknown) => e);
    t.close();
    expect((err as EmailTransportError).permanent).toBe(true);
  });

  it('an unreachable server is transient', async () => {
    const t = new SmtpTransport('smtp://127.0.0.1:1');
    const err = await t.send(msg).catch((e: unknown) => e);
    t.close();
    expect((err as EmailTransportError).permanent).toBe(false);
  });
});
