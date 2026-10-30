// The values of a row as the shared postgres client gives them. drizzle replaces the parsers and
// serializers of that client: a timestamp comes back as text, and a JSON value can come back as text.

/** A timestamp of a row as a `Date`. Null stays null. */
export function toDate(value: Date | string): Date
export function toDate(value: Date | string | null): Date | null
export function toDate(value: Date | string | null): Date | null {
  if (value === null) return null
  return value instanceof Date ? value : new Date(value)
}

/** A JSON column of a row as its value. The caller gives the type: this function does not check it. */
export function jsonOf<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}
