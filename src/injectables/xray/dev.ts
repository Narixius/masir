import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:http2";
import path from "node:path";

import { createFileRegistry, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import type { DescMethod, FileRegistry, JsonValue } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

let cachedRegistry: FileRegistry | null = null;

const locateDescriptorSet = (): Buffer => {
  const possiblePaths = [
    path.resolve(process.cwd(), "native/masir-xray-grpc/descriptor_set.bin"),
    path.resolve(process.cwd(), "descriptor_set.bin"),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return readFileSync(p);
    }
  }
  throw new Error("Could not find compiled Xray descriptor set binary");
};

export const getDevRegistry = (): FileRegistry => {
  if (cachedRegistry) {
    return cachedRegistry;
  }
  const bytes = locateDescriptorSet();
  const fds = fromBinary(FileDescriptorSetSchema, bytes);
  cachedRegistry = createFileRegistry(fds);
  return cachedRegistry;
};

export const findDevMethod = (registry: FileRegistry, methodPath: string): DescMethod => {
  const trimmed = methodPath.startsWith("/") ? methodPath.slice(1) : methodPath;
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) {
    throw new Error(`Invalid gRPC method path: '${methodPath}'`);
  }
  const serviceName = trimmed.slice(0, lastSlash);
  const methodName = trimmed.slice(lastSlash + 1);

  const service = registry.getService(serviceName);
  if (!service) {
    throw new Error(`Service '${serviceName}' not found in registry`);
  }
  const method = service.methods.find((m) => m.name === methodName);
  if (!method) {
    throw new Error(`Method '${methodName}' not found in service '${serviceName}'`);
  }
  return method;
};

// Expand Phase-2 TypedMessages if any: {"type": "...", "value": { ... }}
const expandTypedMessages = (registry: FileRegistry, val: JsonValue): void => {
  if (typeof val !== "object" || val === null) {
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      expandTypedMessages(registry, item);
    }
    return;
  }

  const obj = val;
  if (typeof obj.type === "string" && typeof obj.value === "object" && obj.value !== null && !Array.isArray(obj.value)) {
    const desc = registry.getMessage(obj.type);
    if (!desc) {
      throw new Error(`unknown TypedMessage type: '${obj.type}'`);
    }
    expandTypedMessages(registry, obj.value);
    const innerProto = fromJson(desc, obj.value);
    const encoded = toBinary(desc, innerProto);
    obj.value = Buffer.from(encoded).toString("base64");
    return;
  }

  for (const v of Object.values(obj)) {
    expandTypedMessages(registry, v);
  }
};

// Unpack Phase-2 TypedMessages in response JSON: {"type": "...", "value": Uint8Array / number[] / base64 string}
const unpackTypedMessages = (registry: FileRegistry, val: JsonValue): void => {
  if (typeof val !== "object" || val === null) {
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      unpackTypedMessages(registry, item);
    }
    return;
  }

  const obj = val;
  if (typeof obj.type === "string") {
    const desc = registry.getMessage(obj.type);
    if (desc) {
      let bytes: Uint8Array | null = null;
      if (typeof obj.value === "string") {
        bytes = Buffer.from(obj.value, "base64");
      } else if (Array.isArray(obj.value)) {
        bytes = new Uint8Array(obj.value as number[]);
      } else if (obj.value instanceof Uint8Array) {
        bytes = obj.value;
      }

      if (bytes) {
        try {
          const decoded = fromBinary(desc, bytes);
          obj.value = toJson(desc, decoded, { alwaysEmitImplicit: true });
        } catch {
          // Leave raw if decoding fails
        }
      }
    }
  }

  for (const v of Object.values(obj)) {
    unpackTypedMessages(registry, v);
  }
};

const performHttp2GrpcCall = (
  targetUrl: string,
  methodPath: string,
  framedReq: Buffer,
  method: DescMethod,
  registry: FileRegistry
): Promise<string> =>
  new Promise((resolve, reject) => {
    const client = connect(targetUrl);

    client.on("error", (err) => {
      reject(err);
    });

    const path = methodPath.startsWith("/") ? methodPath : `/${methodPath}`;
    const req = client.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc+proto",
      te: "trailers",
    });

    const chunks: Buffer[] = [];
    let grpcStatus = 0;
    let grpcMessage = "";

    req.on("response", (headers) => {
      if (headers["grpc-status"] !== undefined) {
        grpcStatus = Number(headers["grpc-status"]);
      }
      if (typeof headers["grpc-message"] === "string") {
        grpcMessage = headers["grpc-message"];
      }
    });

    req.on("trailers", (headers) => {
      if (headers["grpc-status"] !== undefined) {
        grpcStatus = Number(headers["grpc-status"]);
      }
      if (typeof headers["grpc-message"] === "string") {
        grpcMessage = headers["grpc-message"];
      }
    });

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      client.close();

      if (grpcStatus !== 0) {
        reject(new Error(`gRPC status ${grpcStatus}: ${grpcMessage}`));
        return;
      }

      const totalBuf = Buffer.concat(chunks);
      if (totalBuf.length < 5) {
        resolve("{}");
        return;
      }

      // Read framed response
      const bodyLen = totalBuf.readUInt32BE(1);
      const resBytes = totalBuf.subarray(5, 5 + bodyLen);

      const resProto = fromBinary(method.output, resBytes);
      const resJson = toJson(method.output, resProto, { alwaysEmitImplicit: true });
      unpackTypedMessages(registry, resJson);

      resolve(JSON.stringify(resJson));
    });

    req.on("error", (err) => {
      client.close();
      reject(err);
    });

    req.end(framedReq);
  });

/**
 * Execute a unary gRPC call using node:http2 and @bufbuild/protobuf.
 */
export const executeDevGrpcCall = async (addr: string, methodPath: string, reqJsonStr: string): Promise<string> => {
  const registry = getDevRegistry();
  const method = findDevMethod(registry, methodPath);

  const reqObj: JsonValue = reqJsonStr.trim() ? (JSON.parse(reqJsonStr) as JsonValue) : {};
  expandTypedMessages(registry, reqObj);

  const reqProto = fromJson(method.input, reqObj);
  const reqBytes = toBinary(method.input, reqProto);

  // Frame payload: 1 byte flag (0) + 4 bytes big-endian length + body
  const framedReq = Buffer.alloc(5 + reqBytes.length);
  framedReq[0] = 0;
  framedReq.writeUInt32BE(reqBytes.length, 1);
  framedReq.set(reqBytes, 5);

  const targetUrl = addr.startsWith("http://") || addr.startsWith("https://") ? addr : `http://${addr}`;

  return await performHttp2GrpcCall(targetUrl, methodPath, framedReq, method, registry);
};
