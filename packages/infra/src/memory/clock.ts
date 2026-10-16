import type { Clock, IdGenerator } from '@agentboard/domain';

export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;

  next(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}
