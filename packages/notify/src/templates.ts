import { z } from 'zod';

export interface Site {
  name: string;
  /** Public origin, no trailing slash. Links in emails are absolute. */
  url: string;
  accent?: string;
}

/** What a template produces before layout: structured, so html and text can never disagree. */
export interface Body {
  preheader?: string;
  heading: string;
  paragraphs: string[];
  /** Label / value rows (order lines, totals). */
  rows?: { label: string; value: string; strong?: boolean }[];
  cta?: { label: string; url: string };
  footnote?: string;
}

export interface Template<T> {
  schema: z.ZodType<T>;
  subject(data: T, site: Site): string;
  body(data: T, site: Site): Body;
}

/** http(s) only: `z.url()` alone accepts `javascript:` and `data:`. */
const httpUrl = z.url({ protocol: /^https?$/ }).max(500);

const money = z.object({ amount: z.string().regex(/^-?\d+$/), currency: z.string().length(3) });

/** "1999" AUD -> "A$19.99" using the currency's own exponent. Text only: the amount stays a string until here. */
export function formatMoney(m: { amount: string; currency: string }, locale = 'en-AU'): string {
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const n = BigInt(m.amount);
  const div = 10n ** BigInt(digits);
  const sign = n < 0n ? -1 : 1;
  const abs = n < 0n ? -n : n;
  return fmt.format(sign * (Number(abs / div) + Number(abs % div) / Number(div)));
}

const orderLines = z
  .array(z.object({ title: z.string().max(300), quantity: z.number().int(), total: money }))
  .max(100);

const orderBase = z.object({
  orderNumber: z.string().max(30),
  orderUrl: httpUrl,
  customerName: z.string().max(200).default(''),
});

export const templates = {
  'order-confirmation': {
    schema: orderBase.extend({
      lines: orderLines,
      total: money,
      pendingPayment: z.boolean().default(false),
    }),
    subject: (d, s) => `Your ${s.name} order #${d.orderNumber}`,
    body: (d, s) => ({
      preheader: `Order #${d.orderNumber} received`,
      heading: d.pendingPayment ? 'We have your order' : 'Thank you for your order',
      paragraphs: [
        `${d.customerName ? `Hi ${d.customerName}, order` : 'Order'} #${d.orderNumber} is ${d.pendingPayment ? 'waiting for payment' : 'confirmed'}.`,
        d.pendingPayment
          ? 'Complete payment from the order page to secure your items.'
          : `We will email you when it ships.`,
      ],
      rows: [
        ...d.lines.map((l) => ({
          label: `${l.title} × ${l.quantity}`,
          value: formatMoney(l.total),
        })),
        { label: 'Total', value: formatMoney(d.total), strong: true },
      ],
      cta: { label: 'View your order', url: d.orderUrl },
      footnote: `Questions? Just reply to this email. — ${s.name}`,
    }),
  } satisfies Template<{
    orderNumber: string;
    orderUrl: string;
    customerName: string;
    lines: { title: string; quantity: number; total: { amount: string; currency: string } }[];
    total: { amount: string; currency: string };
    pendingPayment: boolean;
  }>,

  'order-shipped': {
    schema: orderBase,
    subject: (d, s) => `Your ${s.name} order #${d.orderNumber} has shipped`,
    body: (d) => ({
      preheader: 'On its way',
      heading: 'Your order is on its way',
      paragraphs: [
        `${d.customerName ? `Hi ${d.customerName}, ` : ''}order #${d.orderNumber} has shipped.`,
      ],
      cta: { label: 'View your order', url: d.orderUrl },
    }),
  } satisfies Template<{ orderNumber: string; orderUrl: string; customerName: string }>,

  'order-cancelled': {
    schema: orderBase,
    subject: (d, s) => `Your ${s.name} order #${d.orderNumber} was cancelled`,
    body: (d) => ({
      heading: 'Order cancelled',
      paragraphs: [
        `Order #${d.orderNumber} has been cancelled. If you paid, the money is returned to your original payment method.`,
        'If this was unexpected, reply to this email and we will help.',
      ],
    }),
  } satisfies Template<{ orderNumber: string; orderUrl: string; customerName: string }>,

  'order-refunded': {
    schema: orderBase.extend({ amount: money }),
    subject: (d, s) => `Refund for ${s.name} order #${d.orderNumber}`,
    body: (d) => ({
      heading: 'Your refund is on its way',
      paragraphs: [
        `We refunded ${formatMoney(d.amount)} for order #${d.orderNumber}. It can take a few business days to appear.`,
      ],
    }),
  } satisfies Template<{
    orderNumber: string;
    orderUrl: string;
    customerName: string;
    amount: { amount: string; currency: string };
  }>,

  welcome: {
    schema: z.object({ name: z.string().max(200).default(''), accountUrl: httpUrl }),
    subject: (_d, s) => `Welcome to ${s.name}`,
    body: (d, s) => ({
      heading: `Welcome${d.name ? `, ${d.name}` : ''}`,
      paragraphs: [`Your ${s.name} account is ready. Track orders and check out faster.`],
      cta: { label: 'Your account', url: d.accountUrl },
    }),
  } satisfies Template<{ name: string; accountUrl: string }>,

  'review-request': {
    schema: z.object({
      customerName: z.string().max(200).default(''),
      orderNumber: z.string().max(30),
      items: z
        .array(z.object({ title: z.string().max(300), url: httpUrl }))
        .min(1)
        .max(20),
    }),
    subject: (_d, s) => `How was your ${s.name} order?`,
    body: (d) => ({
      heading: 'Tell us what you think',
      paragraphs: [
        `${d.customerName ? `Hi ${d.customerName}, thanks` : 'Thanks'} for ordering. A short review helps other shoppers (and us).`,
        ...d.items.map((i) => `${i.title}: ${i.url}`),
      ],
      cta: { label: 'Write a review', url: d.items[0]!.url },
    }),
  } satisfies Template<{
    customerName: string;
    orderNumber: string;
    items: { title: string; url: string }[];
  }>,

  'abandoned-cart': {
    schema: z.object({
      customerName: z.string().max(200).default(''),
      cartUrl: httpUrl,
      items: z
        .array(z.object({ title: z.string().max(300), quantity: z.number().int() }))
        .min(1)
        .max(50),
    }),
    subject: (_d, s) => `You left something in your ${s.name} bag`,
    body: (d) => ({
      heading: 'Still thinking it over?',
      paragraphs: [
        `${d.customerName ? `Hi ${d.customerName}, ` : ''}your bag is saved:`,
        ...d.items.map((i) => `• ${i.title} × ${i.quantity}`),
      ],
      cta: { label: 'Return to your bag', url: d.cartUrl },
      footnote: 'Stock is not held for you until you check out.',
    }),
  } satisfies Template<{
    customerName: string;
    cartUrl: string;
    items: { title: string; quantity: number }[];
  }>,
};

export type TemplateName = keyof typeof templates;
export const isTemplate = (name: string): name is TemplateName => name in templates;

// ---- rendering -------------------------------------------------------------------------------------------------

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Every value interpolated into HTML goes through this. Template data is customer-controlled (names, product titles). */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** A URL is only emitted as a link if it is http(s): a `javascript:` URL in data must never become an href. */
const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? escapeHtml(u) : '#');

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function render<N extends TemplateName>(name: N, rawData: unknown, site: Site): Rendered {
  const t = templates[name] as unknown as Template<unknown>;
  const data = t.schema.parse(rawData);
  const subject = t
    .subject(data, site)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  const b = t.body(data, site);
  const accent = /^#[0-9a-fA-F]{6}$/.test(site.accent ?? '') ? site.accent! : '#a94a22';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f6f1e9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f1a16">
${b.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(b.preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e4d9c8;font-size:18px;font-weight:700"><a href="${safeUrl(site.url)}" style="color:#1f1a16;text-decoration:none">${escapeHtml(site.name)}</a></td></tr>
<tr><td style="padding:28px 32px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(b.heading)}</h1>
${b.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${escapeHtml(p)}</p>`).join('\n')}
${
  b.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;border-top:1px solid #e4d9c8">${b.rows
        .map(
          (r) =>
            `<tr><td style="padding:9px 0;border-bottom:1px solid #e4d9c8;font-size:14px;${r.strong ? 'font-weight:700' : ''}">${escapeHtml(r.label)}</td><td align="right" style="padding:9px 0;border-bottom:1px solid #e4d9c8;font-size:14px;${r.strong ? 'font-weight:700' : ''}">${escapeHtml(r.value)}</td></tr>`,
        )
        .join('')}</table>`
    : ''
}
${b.cta ? `<p style="margin:20px 0"><a href="${safeUrl(b.cta.url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${escapeHtml(b.cta.label)}</a></p>` : ''}
${b.footnote ? `<p style="margin:18px 0 0;font-size:13px;color:#6a6056">${escapeHtml(b.footnote)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;

  const text = [
    b.heading,
    '',
    ...b.paragraphs,
    ...(b.rows?.length ? ['', ...b.rows.map((r) => `${r.label}: ${r.value}`)] : []),
    ...(b.cta ? ['', `${b.cta.label}: ${b.cta.url}`] : []),
    ...(b.footnote ? ['', b.footnote] : []),
    '',
    `— ${site.name}`,
  ].join('\n');

  return { subject, html, text };
}
