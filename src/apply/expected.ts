// The data a configuration file must hold after an edit: the old data with only the managed value changed. The YAML
// and JSON editors parse their result and compare it with this, so an edit can never break a file or change a
// setting depcurfew does not manage, whatever the file looks like.

type Path = readonly (string | number)[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of `data` with `value` at `path`; missing objects on the way, or values that are not objects, become objects. */
export function withValue(data: unknown, path: Path, value: unknown): unknown {
  const [segment, ...rest] = path;
  if (segment === undefined) return value;
  if (Array.isArray(data) && typeof segment === 'number') {
    const copy = [...data];
    copy[segment] = withValue(data[segment], rest, value);
    return copy;
  }
  const copy: Record<string, unknown> = isObject(data) ? { ...data } : {};
  const key = String(segment);
  // defineProperty keeps a key such as __proto__ an ordinary key, as JSON.parse and the yaml library do.
  const current = Object.hasOwn(copy, key) ? copy[key] : undefined;
  Object.defineProperty(copy, key, { value: withValue(current, rest, value), enumerable: true, writable: true, configurable: true });
  return copy;
}

/** A copy of `data` with the array at `path` changed by `change`. */
export function withArray(data: unknown, path: Path, change: (array: unknown[]) => unknown[]): unknown {
  let current: unknown = data;
  for (const segment of path) {
    current = (isObject(current) || Array.isArray(current)) && Object.hasOwn(current, String(segment)) ? (current as Record<string, unknown>)[String(segment)] : undefined;
  }
  return withValue(data, path, change(Array.isArray(current) ? [...(current as unknown[])] : []));
}

/** Whether two parsed documents hold the same data, keys in the same order. */
export function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
