import { unstable_cache } from 'next/cache';

// ISR page, fresh for an hour. Every regeneration produces a new render id, so tests can see re-renders.
export const revalidate = 3600;

const readData = unstable_cache(
  async () => ({ value: Math.random().toString(36).slice(2) }),
  ['isr-data'],
  { tags: ['ptag'] },
);

export default async function Page() {
  const data = await readData();
  return (
    <main>
      <p id="render">{Math.random().toString(36).slice(2)}</p>
      <p id="data">{data.value}</p>
    </main>
  );
}
