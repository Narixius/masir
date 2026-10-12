import { createXrayClient } from "../injectables/xray/client.js";
import type { XrayClient } from "../injectables/xray/types.js";
import { xray } from "../services/xray.js";

let clientInstance: XrayClient | null = null;
let clientPort: number | null = null;

export const getXrayGrpcClient = (): XrayClient => {
  const currentPort = xray.getApiPort();
  if (!clientInstance || clientPort !== currentPort) {
    clientPort = currentPort;
    clientInstance = createXrayClient(`127.0.0.1:${currentPort}`);
  }
  return clientInstance;
};
