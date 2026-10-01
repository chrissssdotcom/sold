import nodemailer, { type Transporter } from 'nodemailer';

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable per logical email. Providers that honour it (Postmark `MessageID`-style dedupe, SMTP `Message-ID`) collapse our retries. */
  idempotencyKey: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  providerId: string;
}

/** A transient failure is retried with backoff; a permanent one (bad address, auth) is not. */
export class EmailTransportError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'EmailTransportError';
  }
}

/** The only seam to a mail provider. Nothing outside an adapter knows a vendor. */
export interface EmailTransport {
  readonly id: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Keeps messages in memory. Tests and previews. */
export class MemoryTransport implements EmailTransport {
  readonly id = 'memory';
  readonly sent: EmailMessage[] = [];
  /** Make the next N sends fail (transient unless `permanent`). */
  failNext = 0;
  permanent = false;
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new EmailTransportError('simulated failure', this.permanent);
    }
    this.sent.push(message);
    return { providerId: `mem-${this.sent.length}` };
  }
}

/** Writes a one-line summary to the log instead of sending. The default in local development. */
export class ConsoleTransport implements EmailTransport {
  readonly id = 'console';
  constructor(
    private readonly log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}
  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.log(
      `[email] to=${message.to} subject=${JSON.stringify(message.subject)} key=${message.idempotencyKey}`,
    );
    return { providerId: `console-${message.idempotencyKey}` };
  }
}

/**
 * SMTP via nodemailer (Mailpit locally, any relay in production).
 * `Message-ID` is derived from the idempotency key so a retry after a lost response is recognisable downstream.
 */
export class SmtpTransport implements EmailTransport {
  readonly id = 'smtp';
  private readonly transporter: Transporter;
  constructor(url: string) {
    this.transporter = nodemailer.createTransport({
      url,
      pool: true,
      maxConnections: 4,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  async send(m: EmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: m.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        messageId: `<${m.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '-')}@sold.invalid>`,
        ...(m.headers ? { headers: m.headers } : {}),
      });
      return { providerId: String(info.messageId) };
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      // 5xx replies are the server refusing this message (bad recipient, policy): retrying cannot help.
      throw new EmailTransportError(
        error instanceof Error ? error.message : 'smtp error',
        typeof code === 'number' && code >= 500 && code < 600,
      );
    }
  }
  close(): void {
    this.transporter.close();
  }
}

/**
 * Postmark's documented HTTP API (`POST /email`, `X-Postmark-Server-Token`) over plain fetch.
 * **Not verified against Postmark** (no account here): tested against a local fake that implements the documented request/response shape.
 */
export class PostmarkTransport implements EmailTransport {
  readonly id = 'postmark';
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.postmarkapp.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(m: EmailMessage): Promise<EmailSendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/email`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': this.token,
        },
        body: JSON.stringify({
          From: m.from,
          To: m.to,
          Subject: m.subject,
          HtmlBody: m.html,
          TextBody: m.text,
          MessageStream: 'outbound',
          Headers: [{ Name: 'X-Idempotency-Key', Value: m.idempotencyKey }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new EmailTransportError(
        error instanceof Error ? error.message : 'network error',
        false,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      MessageID?: string;
      ErrorCode?: number;
      Message?: string;
    };
    if (res.ok && body.ErrorCode === 0 && body.MessageID) return { providerId: body.MessageID };
    // 4xx (except 429) is a rejection of this message; 429/5xx are the provider struggling.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new EmailTransportError(`postmark ${res.status}: ${body.Message ?? 'error'}`, permanent);
  }
}
