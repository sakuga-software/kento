// Small checks of untrusted JSON: each one returns the value with its type, or the list of the
// problems with their path. No dependency, so that the runner image stays small.

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** A check of a value at a path. It pushes a problem into `errors` and returns undefined when the value is wrong. */
export type Check<T> = (value: unknown, path: string, errors: string[]) => T | undefined;

export function run<T>(check: Check<T>, value: unknown): Checked<T> {
  const errors: string[] = [];
  const out = check(value, '$', errors);
  if (errors.length > 0 || out === undefined) return { ok: false, errors: errors.length > 0 ? errors : ['$: invalid'] };
  return { ok: true, value: out };
}

export function str(options: { min?: number; max: number; pattern?: RegExp }): Check<string> {
  return (value, path, errors) => {
    if (typeof value !== 'string') return void errors.push(`${path}: must be a string`);
    if (value.length < (options.min ?? 0)) return void errors.push(`${path}: must have at least ${options.min} characters`);
    if (value.length > options.max) return void errors.push(`${path}: must have at most ${options.max} characters`);
    if (options.pattern && !options.pattern.test(value)) return void errors.push(`${path}: has a wrong format`);
    return value;
  };
}

export function int(options: { min: number; max: number }): Check<number> {
  return (value, path, errors) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return void errors.push(`${path}: must be an integer`);
    if (value < options.min || value > options.max) return void errors.push(`${path}: must be from ${options.min} to ${options.max}`);
    return value;
  };
}

export function num(options: { min: number; max: number }): Check<number> {
  return (value, path, errors) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return void errors.push(`${path}: must be a number`);
    if (value < options.min || value > options.max) return void errors.push(`${path}: must be from ${options.min} to ${options.max}`);
    return value;
  };
}

export const bool: Check<boolean> = (value, path, errors) => {
  if (typeof value !== 'boolean') return void errors.push(`${path}: must be true or false`);
  return value;
};

export function oneOf<const T extends readonly string[]>(values: T): Check<T[number]> {
  return (value, path, errors) => {
    if (typeof value !== 'string' || !values.includes(value)) return void errors.push(`${path}: must be one of ${values.join(', ')}`);
    return value as T[number];
  };
}

export function nullable<T>(check: Check<T>): Check<T | null> {
  return (value, path, errors) => (value === null ? null : check(value, path, errors));
}

export function arr<T>(item: Check<T>, options: { max: number }): Check<T[]> {
  return (value, path, errors) => {
    if (!Array.isArray(value)) return void errors.push(`${path}: must be an array`);
    if (value.length > options.max) return void errors.push(`${path}: must have at most ${options.max} items`);
    const before = errors.length;
    const out = value.map((v, i) => item(v, `${path}[${i}]`, errors));
    return errors.length === before ? (out as T[]) : undefined;
  };
}

export function tuple2<A, B>(a: Check<A>, b: Check<B>): Check<[A, B]> {
  return (value, path, errors) => {
    if (!Array.isArray(value) || value.length !== 2) return void errors.push(`${path}: must be an array of 2 items`);
    const before = errors.length;
    const out: [A, B] = [a(value[0], `${path}[0]`, errors) as A, b(value[1], `${path}[1]`, errors) as B];
    return errors.length === before ? out : undefined;
  };
}

const OPTIONAL = new WeakSet<Check<unknown>>();

/** A key of `obj` that can be missing. A runner of an earlier release does not send it. */
export function optional<T>(check: Check<T>): Check<T | undefined> {
  const out: Check<T | undefined> = (value, path, errors) => check(value, path, errors);
  OPTIONAL.add(out);
  return out;
}

type Shape = Record<string, Check<unknown>>;
type FromShape<S extends Shape> = { [K in keyof S]: S[K] extends Check<infer T> ? T : never };

/**
 * An object with exactly these keys. A missing key is a problem, and so is a key that the shape does
 * not have: a runner cannot store a field that the service did not plan.
 */
export function obj<S extends Shape>(shape: S): Check<FromShape<S>> {
  return (value, path, errors) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return void errors.push(`${path}: must be an object`);
    const before = errors.length;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) errors.push(`${path}.${key}: is not allowed`);
    }
    for (const [key, check] of Object.entries(shape)) {
      if (!Object.hasOwn(value, key)) {
        if (OPTIONAL.has(check)) continue;
        errors.push(`${path}.${key}: is required`);
        continue;
      }
      out[key] = check((value as Record<string, unknown>)[key], `${path}.${key}`, errors);
    }
    return errors.length === before ? (out as FromShape<S>) : undefined;
  };
}

/** One of several object shapes, chosen by the value of `key`. */
export function tagged<K extends string, M extends Record<string, Check<unknown>>>(
  key: K,
  variants: M,
): Check<{ [V in keyof M]: M[V] extends Check<infer T> ? T : never }[keyof M]> {
  return (value, path, errors) => {
    const tag = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof tag !== 'string' || !Object.hasOwn(variants, tag)) {
      return void errors.push(`${path}.${key}: must be one of ${Object.keys(variants).join(', ')}`);
    }
    return variants[tag]!(value, path, errors) as never;
  };
}
