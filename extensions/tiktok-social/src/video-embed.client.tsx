'use client';
import { useEffect, useState } from 'react';

const VIDEO = /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._-]+\/video\/(\d{6,25})$/;

/**
 * A TikTok video. The embed loads from tiktok.com and sets advertising cookies, so until the shopper has accepted
 * them they get a placeholder and a way to change their mind: nothing is requested from TikTok before that.
 */
export default function VideoEmbed({ url }: { url: string }) {
  const [marketing, setMarketing] = useState(false);
  useEffect(() => {
    const read = () =>
      setMarketing(
        (window as unknown as { __sold?: { consent?: { marketing?: boolean } } }).__sold?.consent
          ?.marketing === true,
      );
    read();
    window.addEventListener('sold:consent', read);
    return () => window.removeEventListener('sold:consent', read);
  }, []);
  const id = VIDEO.exec(url)?.[1];
  if (!id) return null;
  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 360 }}>
        {marketing ? (
          <iframe
            title="TikTok video"
            src={`https://www.tiktok.com/embed/v2/${id}`}
            loading="lazy"
            allowFullScreen
            style={{ width: '100%', height: 640, border: 0 }}
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
          />
        ) : (
          <div className="panel" style={{ textAlign: 'center' }}>
            <p>This video is hosted by TikTok, which uses advertising cookies.</p>
            <button
              type="button"
              className="btn"
              onClick={() => window.dispatchEvent(new Event('sold:consent-open'))}
            >
              Change cookie preferences
            </button>{' '}
            <a href={url} rel="noopener noreferrer" target="_blank">
              or watch on TikTok
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
