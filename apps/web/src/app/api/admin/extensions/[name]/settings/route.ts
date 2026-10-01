import { z } from 'zod';
import { NotFoundError, ValidationError } from '@sold/commerce';
import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { getKernel } from '../../../../../../server/kernel';
import { body } from '../../../../../../server/admin/http';

export const dynamic = 'force-dynamic';

const nameOf = (req: Request): string => {
  const parts = new URL(req.url).pathname.split('/');
  return decodeURIComponent(parts[parts.length - 2] ?? '');
};

async function settingsFor(name: string) {
  const kernel = await getKernel();
  if (!/^[a-z][a-z0-9-]{0,60}$/.test(name) || !kernel.settings.has(name))
    throw new NotFoundError('Extension settings', name);
  return kernel.settings;
}

/** The settings form: secret values are never returned, only whether one is stored. */
export const GET = adminRoute('extensions:read', async (req) => {
  const name = nameOf(req);
  const settings = await settingsFor(name);
  return json({ extension: name, fields: await settings.describeForm(name) });
});

const patch = z.record(
  z.string().max(64),
  z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]),
);

/** Patch semantics: absent keys are unchanged; `null` clears a secret (or an optional value). The merged result is validated before anything is written. */
export const PUT = adminRoute('extensions:write', async (req, { audit, user }) => {
  const name = nameOf(req);
  const settings = await settingsFor(name);
  const v = await body(req, patch);
  try {
    const { changedKeys } = await settings.set(name, v, user.email);
    await audit('extension.settings', { type: 'extension', id: name }, { changedKeys });
    return json({ changedKeys });
  } catch (error) {
    // Duck-typed: the class can be loaded twice by the bundler (see CommerceError.is).
    const e = error as { name?: string; issues?: { path: string; message: string }[] };
    if (e.name === 'SettingsValidationError')
      throw new ValidationError('Invalid settings', { issues: e.issues ?? [] });
    throw error;
  }
});
