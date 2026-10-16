export interface Frame {
  /** The outbox row id. It is what a client can resume from, so it is kept, not discarded. */
  readonly id: string | null;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** The minimum a reader has to be. Kept as an interface so the same consumer works in a browser, in Node, and in a test. */
export interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
}

export function parseFrame(raw: string): Frame | null {
  let id: string | null = null;
  let event = '';
  let data: Record<string, unknown> | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4).trim();
    else if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }

  if (!event || data === null) return null;
  return { id, event, data };
}

/**
 * Read frames until the connection closes. Splitting on the blank line is what makes a frame a
 * frame: a partial read is left in the buffer, never guessed at.
 */
export async function consume(reader: Reader, onFrame: (frame: Frame) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });

    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) break;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame = parseFrame(raw);
      if (frame) onFrame(frame);
    }
  }
}

export interface LiveConnection {
  close(): void;
}

export async function connect(
  url: string,
  token: string,
  onFrame: (frame: Frame) => void,
): Promise<LiveConnection> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  const body = response.body;

  if (!body) throw new Error(`the live feed at ${url} returned no body`);

  const reader = body.getReader();
  let closed = false;

  void consume(reader, onFrame).then(() => {
    if (!closed) onFrame({ id: null, event: 'disconnected', data: {} });
  });

  return {
    close() {
      closed = true;
      reader.cancel().catch(() => undefined);
    },
  };
}
