import net from "node:net";

export function listen(server: net.Server, port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}
