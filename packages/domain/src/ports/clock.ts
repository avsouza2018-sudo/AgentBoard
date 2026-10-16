export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
