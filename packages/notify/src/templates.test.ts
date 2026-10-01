import { describe, expect, it } from 'vitest';
import { escapeHtml, formatMoney, render, templates } from './templates';

const site = { name: 'Shop & Co', url: 'https://shop.example' };
const order = {
  orderNumber: '1001',
  orderUrl: 'https://shop.example/en-au/order/tok',
  customerName: 'Sam',
  lines: [{ title: 'Candle', quantity: 2, total: { amount: '4000', currency: 'AUD' } }],
  total: { amount: '4000', currency: 'AUD' },
  pendingPayment: false,
};

describe('templates', () => {
  it('renders subject, html and text from the same structured body', () => {
    const r = render('order-confirmation', order, site);
    expect(r.subject).toBe('Your Shop & Co order #1001');
    expect(r.html).toContain('Candle × 2');
    expect(r.text).toContain('Candle × 2: $40.00');
    expect(r.text).toContain('Total: $40.00');
    expect(r.html).toContain('href="https://shop.example/en-au/order/tok"');
  });

  it('escapes customer-controlled values in HTML (names, product titles, site name)', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const r = render(
      'order-confirmation',
      { ...order, customerName: evil, lines: [{ ...order.lines[0]!, title: evil }] },
      { ...site, name: evil },
    );
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Plain text is not HTML: it carries the raw value, which is safe there.
    expect(r.text).toContain(evil);
  });

  it('never emits a non-http(s) URL as a link', () => {
    expect(() =>
      render('welcome', { name: 'x', accountUrl: 'javascript:alert(1)' }, site),
    ).toThrow();
    // The schema rejects it; and the renderer independently neutralises anything that slips past.
    const r = render('welcome', { name: 'x', accountUrl: 'https://ok.example/a?b=1&c="2"' }, site);
    expect(r.html).toContain('href="https://ok.example/a?b=1&amp;c=&quot;2&quot;"');
  });

  it('keeps header-injection attempts out of the subject', () => {
    const r = render(
      'order-shipped',
      { orderNumber: '1\r\nBcc: evil@x.test', orderUrl: 'https://s.example/o', customerName: '' },
      site,
    );
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it('rejects data that does not satisfy the template', () => {
    expect(() => render('order-confirmation', { orderNumber: 1 }, site)).toThrow();
    expect(() =>
      render('order-refunded', { ...order, amount: { amount: '12.5', currency: 'AUD' } }, site),
    ).toThrow();
  });

  it('formats money by the currency exponent, from strings', () => {
    expect(formatMoney({ amount: '1999', currency: 'AUD' })).toBe('$19.99');
    expect(formatMoney({ amount: '1500', currency: 'JPY' })).toMatch(/1,500/);
    expect(formatMoney({ amount: '-250', currency: 'AUD' })).toBe('-$2.50');
    expect(formatMoney({ amount: '9007199254740993123', currency: 'AUD' })).toBeTruthy(); // beyond 2^53: must not throw
  });

  it('escapeHtml covers the five metacharacters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('every template renders with minimal valid data', () => {
    const samples: Record<string, unknown> = {
      'order-confirmation': order,
      'order-shipped': { orderNumber: '1', orderUrl: 'https://s.example/o', customerName: '' },
      'order-cancelled': { orderNumber: '1', orderUrl: 'https://s.example/o', customerName: '' },
      'order-refunded': {
        orderNumber: '1',
        orderUrl: 'https://s.example/o',
        customerName: '',
        amount: { amount: '100', currency: 'AUD' },
      },
      welcome: { name: '', accountUrl: 'https://s.example/a' },
      'review-request': { orderNumber: '1', items: [{ title: 'X', url: 'https://s.example/p/x' }] },
      'abandoned-cart': { cartUrl: 'https://s.example/cart', items: [{ title: 'X', quantity: 1 }] },
    };
    for (const name of Object.keys(templates)) {
      const r = render(name as never, samples[name], site);
      expect(r.subject.length).toBeGreaterThan(3);
      expect(r.html).toContain('<!doctype html>');
      expect(r.text.length).toBeGreaterThan(10);
    }
  });
});
