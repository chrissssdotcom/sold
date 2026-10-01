/** A plain link block: no tracking, no scripts, so it needs no consent. */
export default function FollowBanner({ handle, heading }: { handle: string; heading: string }) {
  return (
    <section className="section">
      <div className="container" style={{ textAlign: 'center' }}>
        <h2 className="h-section">{heading}</h2>
        <a
          className="btn btn--primary btn--lg"
          href={`https://www.tiktok.com/@${handle}`}
          rel="noopener noreferrer"
          target="_blank"
        >
          Follow @{handle} on TikTok
        </a>
      </div>
    </section>
  );
}
