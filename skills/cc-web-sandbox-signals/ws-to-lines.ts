// Usage: bun ws-to-lines.ts <ws-url>. Prints each WebSocket message as one stdout line for Monitor.
const ws = new WebSocket(process.argv[2]!);
ws.addEventListener("message", (e) => console.log(String(e.data)));
ws.addEventListener("close", () => process.exit(0));
ws.addEventListener("error", (e) => {
  console.error(e);
  process.exit(1);
});
