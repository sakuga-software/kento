// Runs a test with other names of the instance, then puts the defaults back, even after a failure.
import { DEFAULT_INSTANCE, setInstance, type Instance } from '../app/instance.ts'

export async function withInstance<T>(change: Partial<Instance>, run: () => T | Promise<T>): Promise<T> {
  setInstance({ ...DEFAULT_INSTANCE, ...change })
  try {
    return await run()
  } finally {
    setInstance(DEFAULT_INSTANCE)
  }
}
