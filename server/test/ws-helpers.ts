/** Small helpers for driving a Socket Mode WebSocket connection from tests,
 *  standing in for what a real Bolt app's socket client does. */

/** `res.json()` types as `unknown` under strict mode; tests just want `any`. */
export function json(res: Response): Promise<any> {
  return res.json();
}

export function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

export interface Collector {
  next(): Promise<any>;
}

/** Queues incoming JSON frames; call collector.next() to consume them in order.
 *  Must be created (and its listener attached) before awaiting the socket's open
 *  event, so no frame sent immediately on connect (e.g. `hello`) is lost. */
export function makeCollector(ws: WebSocket): Collector {
  const queue: any[] = [];
  const waiters: ((v: any) => void)[] = [];
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = JSON.parse(ev.data as string);
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        if (queue.length) resolve(queue.shift());
        else waiters.push(resolve);
      }),
  };
}

/**
 * Opens a real Socket Mode connection the way a bot actually would: calls
 * apps.connections.open to mint a connId, connects to the URL it returns, and
 * consumes the initial `hello` frame. A raw `new WebSocket(base + "/socket/x")`
 * with a made-up id is rejected — connIds only exist once apps.connections.open
 * has registered them against a specific app.
 */
export async function openSocket(
  base: string,
  token?: string,
): Promise<{ ws: WebSocket; collector: Collector }> {
  const res = await fetch(`${base}/api/apps.connections.open`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const { url } = await (res.json() as Promise<any>);
  const ws = new WebSocket(url);
  const collector = makeCollector(ws);
  await waitOpen(ws);
  await collector.next(); // hello
  return { ws, collector };
}

/**
 * Fires a POST to the control API and, concurrently, waits for the resulting
 * Socket Mode envelope so it can be acknowledged — required because the control
 * endpoints await the bot's delivery/ack before responding. Returns both the
 * envelope the "bot" received and the control API's HTTP response.
 */
export async function postControlAndAck(
  base: string,
  ws: WebSocket,
  collector: Collector,
  path: string,
  body: unknown,
  ackPayload?: unknown,
): Promise<{ envelope: any; response: Response }> {
  const fetchPromise = fetch(`${base}/_control${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const envelope = await collector.next();
  ws.send(JSON.stringify({ envelope_id: envelope.envelope_id, payload: ackPayload }));
  const response = await fetchPromise;
  return { envelope, response };
}
