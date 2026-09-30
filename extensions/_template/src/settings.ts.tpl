import { z } from '@sold/extension-sdk';

/** Settings become an admin form automatically. Add `secrets: ['field']` to store a field encrypted. */
export const settings = z.object({
  greeting: z.string().min(1).max(80).default('Hello from __NAME__').meta({ title: 'Greeting' }),
});

export type Settings = z.output<typeof settings>;
