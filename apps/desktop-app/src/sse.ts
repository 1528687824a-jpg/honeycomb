export type ServerSentEvent = {
  event: string;
  data: string;
  id: string | null;
  retryMs: number | null;
};

export async function consumeServerSentEvents(
  response: Response,
  onEvent: (event: ServerSentEvent) => void | Promise<void>
) {
  if (!response.body) throw new Error("event_stream_body_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let retryMs: number | null = null;
  let lastEventId: string | null = null;
  let completed = false;

  const dispatch = async () => {
    if (dataLines.length === 0) {
      eventName = "";
      retryMs = null;
      return;
    }
    await onEvent({
      event: eventName || "message",
      data: dataLines.join("\n"),
      id: lastEventId,
      retryMs
    });
    eventName = "";
    dataLines = [];
    retryMs = null;
  };

  const processLine = async (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      await dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
    if (field === "id" && !value.includes("\0")) lastEventId = value;
    if (field === "retry" && /^\d+$/.test(value)) retryMs = Number(value);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await processLine(line);
        newline = buffer.indexOf("\n");
      }
      if (done) {
        completed = true;
        break;
      }
    }
    if (buffer) await processLine(buffer);
    await dispatch();
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return { lastEventId };
}
