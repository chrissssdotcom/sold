'use client';
import { useId, useState } from 'react';

/** The subset of JSON Schema that Zod emits for block props. Anything outside it falls back to a JSON editor, never to silent loss. */
export interface JSchema {
  type?: string | string[];
  properties?: Record<string, JSchema>;
  required?: string[];
  items?: JSchema;
  enum?: unknown[];
  anyOf?: JSchema[];
  oneOf?: JSchema[];
  const?: unknown;
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  minItems?: number;
  default?: unknown;
  description?: string;
  pattern?: string;
}

const human = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

function choices(s: JSchema): unknown[] | null {
  if (s.enum) return s.enum;
  const alts = s.anyOf ?? s.oneOf;
  if (alts && alts.length > 0 && alts.every((a) => 'const' in a)) return alts.map((a) => a.const);
  return null;
}
const typeOf = (s: JSchema) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

/** A value that satisfies the schema's required shape, so "Add" produces something valid to edit. */
export function seed(s: JSchema): unknown {
  if (s.default !== undefined) return structuredClone(s.default);
  const opts = choices(s);
  if (opts) return opts[0];
  switch (typeOf(s)) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) if (s.properties?.[k]) out[k] = seed(s.properties[k]);
      return out;
    }
    case 'array':
      return Array.from({ length: s.minItems ?? 0 }, () => (s.items ? seed(s.items) : null));
    case 'number':
    case 'integer':
      return s.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      return '';
  }
}

interface Props {
  schema: JSchema;
  value: unknown;
  onChange(next: unknown): void;
  label?: string;
  required?: boolean;
  depth?: number;
}

export function SchemaForm({ schema, value, onChange, label, required = true, depth = 0 }: Props) {
  const id = useId();
  const opts = choices(schema);
  const type = typeOf(schema);
  const lab = label ?? '';

  if (opts) {
    return (
      <div className="field">
        <label htmlFor={id}>{lab}</label>
        <select
          id={id}
          className="select"
          value={String(value ?? '')}
          onChange={(e) => onChange(opts.find((o) => String(o) === e.target.value))}
        >
          {!required ? <option value="">—</option> : null}
          {opts.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (type === 'string') {
    const long = (schema.maxLength ?? 0) > 140;
    const common = {
      id,
      value: typeof value === 'string' ? value : '',
      maxLength: schema.maxLength,
      required: required && (schema.minLength ?? 0) > 0,
    };
    return (
      <div className="field">
        <label htmlFor={id}>{lab}</label>
        {long ? (
          <textarea className="textarea" {...common} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input className="input" {...common} onChange={(e) => onChange(e.target.value)} />
        )}
        {schema.maxLength ? (
          <span className="hint">
            {(typeof value === 'string' ? value : '').length}/{schema.maxLength}
          </span>
        ) : null}
      </div>
    );
  }

  if (type === 'number' || type === 'integer') {
    return (
      <div className="field">
        <label htmlFor={id}>{lab}</label>
        <input
          id={id}
          className="input"
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          step={type === 'integer' ? 1 : 'any'}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </div>
    );
  }

  if (type === 'boolean') {
    return (
      <label className="row" style={{ marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />{' '}
        {lab}
      </label>
    );
  }

  if (type === 'object' && schema.properties) {
    const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const req = new Set(schema.required ?? []);
    const body = Object.entries(schema.properties).map(([k, sub]) => {
      const present = obj[k] !== undefined;
      if (!req.has(k) && typeOf(sub) === 'object') {
        return (
          <div key={k} className="field">
            <span className="lbl">{human(k)}</span>
            {present ? (
              <div className="subform">
                <SchemaForm
                  schema={sub}
                  value={obj[k]}
                  onChange={(n) => onChange({ ...obj, [k]: n })}
                  required={false}
                  depth={depth + 1}
                />
                <button type="button" className="btn sm" onClick={() => onChange(without(obj, k))}>
                  Remove {human(k).toLowerCase()}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn sm"
                onClick={() => onChange({ ...obj, [k]: seed(sub) })}
              >
                Add {human(k).toLowerCase()}
              </button>
            )}
          </div>
        );
      }
      return (
        <SchemaForm
          key={k}
          schema={sub}
          label={human(k)}
          value={obj[k]}
          required={req.has(k)}
          depth={depth + 1}
          onChange={(n) => onChange(n === undefined ? without(obj, k) : { ...obj, [k]: n })}
        />
      );
    });
    return depth === 0 ? <>{body}</> : <div>{body}</div>;
  }

  if (type === 'array' && schema.items) {
    const list = Array.isArray(value) ? value : [];
    const max = schema.maxItems ?? 50;
    const set = (next: unknown[]) => onChange(next);
    return (
      <div className="field">
        <span className="lbl">{lab}</span>
        {list.map((item, i) => (
          <div className="list-item" key={i}>
            <SchemaForm
              schema={schema.items!}
              value={item}
              label={typeOf(schema.items!) === 'object' ? undefined : `${lab} ${i + 1}`}
              depth={depth + 1}
              onChange={(n) => set(list.map((x, j) => (j === i ? n : x)))}
            />
            <div className="row">
              <button
                type="button"
                className="btn sm"
                disabled={i === 0}
                aria-label={`Move ${lab} ${i + 1} up`}
                onClick={() => set(swap(list, i, i - 1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={i === list.length - 1}
                aria-label={`Move ${lab} ${i + 1} down`}
                onClick={() => set(swap(list, i, i + 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn sm danger"
                disabled={list.length <= (schema.minItems ?? 0)}
                onClick={() => set(list.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn sm"
            disabled={list.length >= max}
            onClick={() => set([...list, seed(schema.items!)])}
          >
            Add item
          </button>
        </div>
      </div>
    );
  }

  return <JsonField label={lab} value={value} onChange={onChange} />;
}

function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange(v: unknown): void;
}) {
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label} (JSON)</label>
      <textarea
        id={id}
        className="textarea mono"
        value={text}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? <span className="hint">Not valid JSON yet; the last valid value is kept.</span> : null}
    </div>
  );
}

function without(o: Record<string, unknown>, k: string) {
  const { [k]: _gone, ...rest } = o;
  return rest;
}
function swap<T>(a: T[], i: number, j: number): T[] {
  const out = [...a];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
