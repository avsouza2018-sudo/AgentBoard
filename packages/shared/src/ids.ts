/**
 * Branded ids. Plain strings are not interchangeable across aggregate boundaries.
 */
export type ActorId = string & { readonly __brand: 'ActorId' };
export type BoardId = string & { readonly __brand: 'BoardId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type StateId = string & { readonly __brand: 'StateId' };

export function id<T extends string>(raw: string): T {
  if (!raw || raw.trim() === '') {
    throw new Error('id must be a non-empty string');
  }
  return raw as T;
}
