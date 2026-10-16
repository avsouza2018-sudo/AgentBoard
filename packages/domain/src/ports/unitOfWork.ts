/** Opaque transaction handle passed to every repository call. */
export interface Tx {
  readonly label: string;
}

export interface UnitOfWork {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
