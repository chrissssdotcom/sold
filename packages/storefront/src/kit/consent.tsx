'use client';

import { useEffect, useState } from 'react';
import {
  CONSENT_COOKIE,
  NO_CONSENT,
  consentCookieString,
  parseConsent,
  type Consent,
} from './consent-cookie';

declare global {
  interface Window {
    /** Published by Base so extensions can read the current choice without importing Base code. */
    __sold?: { consent: Consent };
  }
  interface Navigator {
    globalPrivacyControl?: boolean;
  }
}

export const CONSENT_EVENT = 'sold:consent';

function readCookie(): Consent {
  const hit = document.cookie.split(';').find((p) => p.trim().startsWith(`${CONSENT_COOKIE}=`));
  return hit ? parseConsent(hit.trim().slice(CONSENT_COOKIE.length + 1)) : NO_CONSENT;
}

function publish(c: Consent) {
  window.__sold = { ...(window.__sold ?? {}), consent: c };
  window.dispatchEvent(new CustomEvent<Consent>(CONSENT_EVENT, { detail: c }));
}

function save(
  partial: { analytics: boolean; marketing: boolean },
  source: Consent['source'],
): Consent {
  const next: Consent = { ...partial, decidedAt: Math.floor(Date.now() / 1000), source };
  document.cookie = consentCookieString(next, location.protocol === 'https:');
  publish(next);
  return next;
}

/**
 * The cookie banner. Rules it follows:
 *  - Nothing optional runs before a choice: the default is "no".
 *  - Accept and Reject are equally easy (same size, same row); the choice can be changed from the footer link.
 *  - A Global Privacy Control signal is honoured: marketing stays off, and we do not nag for it.
 * It is mounted by the storefront shell, so every theme gets it; style `.consent*` to match.
 */
export function ConsentBanner() {
  const [consent, setConsent] = useState<Consent | null>(null);
  const [customising, setCustomising] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    let c = readCookie();
    if (c.decidedAt === null && navigator.globalPrivacyControl === true) {
      // The browser has already said no to sale/sharing. Record it and keep analytics off until the shopper chooses.
      c = save({ analytics: false, marketing: false }, 'gpc');
    }
    publish(c);
    setConsent(c);
    setAnalytics(c.analytics);
    setMarketing(c.marketing);
    const reopen = () => setReopened(true);
    window.addEventListener('sold:consent-open', reopen);
    return () => window.removeEventListener('sold:consent-open', reopen);
  }, []);

  if (consent === null) return null;
  const visible = consent.decidedAt === null || reopened;
  if (!visible) return null;

  const decide = (a: boolean, m: boolean) => {
    setConsent(save({ analytics: a, marketing: m }, 'user'));
    setReopened(false);
    setCustomising(false);
  };

  return (
    <section className="consent" role="region" aria-label="Cookie preferences">
      <div className="consent__text">
        <strong>Your privacy</strong>
        <p>
          We use essential cookies to run the store. With your permission we also use measurement
          and advertising cookies. You can change your mind at any time.
        </p>
        {customising ? (
          <fieldset className="consent__choices">
            <legend className="sr-only">Optional cookies</legend>
            <label>
              <input type="checkbox" checked disabled /> Essential (always on)
            </label>
            <label>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
              />{' '}
              Measurement
            </label>
            <label>
              <input
                type="checkbox"
                checked={marketing}
                disabled={navigator.globalPrivacyControl === true}
                onChange={(e) => setMarketing(e.target.checked)}
              />{' '}
              Advertising
              {navigator.globalPrivacyControl === true
                ? ' (off: your browser sent a Global Privacy Control signal)'
                : ''}
            </label>
          </fieldset>
        ) : null}
      </div>
      <div className="consent__actions">
        {customising ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => decide(analytics, marketing)}
          >
            Save choices
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => decide(false, false)}>
              Reject optional
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setCustomising(true)}>
              Choose
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => decide(true, navigator.globalPrivacyControl !== true)}
            >
              Accept all
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** A footer link/button to reopen the banner. */
export function ConsentSettingsLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event('sold:consent-open'))}
    >
      Cookie preferences
    </button>
  );
}
