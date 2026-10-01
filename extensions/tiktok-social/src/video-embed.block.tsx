import VideoEmbed from './video-embed.client';

export default function VideoEmbedBlock({ url }: { url: string }) {
  return <VideoEmbed url={url} />;
}
