// REV-48. The steps that the versioned forms of the Config screen (REV-12) and of the settings of the
// org (REV-13) share: one field per form, the version that the page showed, a parser per field, and
// a save that refuses a form sent from an older version.
import type { FormResult } from '../../repo-config/model.ts'
import { readVersion } from './kit.tsx'

/** The field and the version of a versioned form, or null for a form that the server cannot read (a 400). */
export function readVersionedForm<Field extends string>(
  form: FormData | undefined,
  fields: readonly Field[],
): { form: FormData; field: Field; version: number } | null {
  let field = form?.get('field')
  let version = readVersion(form)
  if (!form || version === null || !(fields as readonly unknown[]).includes(field)) return null
  return { form, field: field as Field, version }
}

/** The parser of a field: `models.<level>` reads the models of a level with the providers of the org. */
export type FieldParsers<Field extends string> = {
  [key in Exclude<Field, `models.${string}`>]: (form: FormData) => FormResult<unknown>
} & { models: (form: FormData) => Promise<FormResult<unknown>> }

/** Reads the value of `field` from the form with its parser. */
export function parseField<Field extends string>(parsers: FieldParsers<Field>, field: Field, form: FormData): Promise<FormResult<unknown>> | FormResult<unknown> {
  if (field.startsWith('models.')) return parsers.models(form)
  return parsers[field as Exclude<Field, `models.${string}`>](form)
}

/** The notice of a form sent from an older version: who saved in between, and when. */
export function conflictNotice(outcome: { version: number; updatedBy: string | null; updatedAt: Date | null }) {
  return { kind: 'conflict' as const, version: outcome.version, updatedBy: outcome.updatedBy, updatedAt: outcome.updatedAt }
}
