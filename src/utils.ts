import { createCipheriv, createHash } from "crypto";
import { PLEJD_LIGHTS, PLEJD_ADDONS, PLEJD_SWITCHES } from "./constants.js";

/**
 * A simple result wrapper. If no error is provided it's considered a success.
 */
export type Result<T, E> = { value?: T; error?: E };

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Set a timeout for a function
 * @param operation - The function to run
 * @param timeoutMs - The timeout in milliseconds (default 5000)
 */
export const race = async <T>(
  operation: () => Promise<T>,
  timeoutMs = 5000,
): Promise<T> => {
  return Promise.race([
    operation(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("BLE operation timeout")), timeoutMs),
    ),
  ]);
};

export const plejdChallageResp = (key: Buffer, chal: Buffer) => {
  const intermediate = createHash("sha256").update(xor(key, chal)).digest();

  const part1 = Buffer.from(intermediate.subarray(0, 16));
  const part2 = Buffer.from(intermediate.subarray(16));

  return xor(part1, part2);
};

export const plejdEncodeDecode = (
  key: Buffer,
  addressBuffer: Buffer,
  data: Buffer,
): Buffer => {
  const buf = Buffer.concat([
    addressBuffer,
    addressBuffer,
    addressBuffer.subarray(0, 4),
  ]);
  const cipher = createCipheriv("aes-128-ecb", key, "");
  cipher.setAutoPadding(false);

  let ct = cipher.update(buf).toString("hex");
  ct += cipher.final().toString("hex");
  const ctBuff = Buffer.from(ct, "hex");

  let output = "";
  for (let i = 0, length = data.length; i < length; i++) {
    output += String.fromCharCode(data[i] ^ ctBuff[i % 16]);
  }

  return Buffer.from(output, "ascii");
};

export const isDimmable = (type: string) => {
  const normalizedType = type.toLowerCase();
  // Check if the model starts with any of the basic dimmer types
  return PLEJD_LIGHTS.some(
    (light) =>
      normalizedType.includes(light.toLowerCase()) ||
      normalizedType.includes("dim"),
  );
};

export const isAddon = (type: string) =>
  !!PLEJD_ADDONS.find((addon) =>
    type.toLowerCase().includes(addon.toLowerCase()),
  );

export const isSwitch = (type: string) =>
  !!PLEJD_SWITCHES.find((switchType) =>
    type.toLowerCase().includes(switchType.toLowerCase()),
  );

const xor = (first: Buffer, second: Buffer): Buffer => {
  const result = Buffer.alloc(first.length);
  for (let i = 0; i < first.length; i++) {
    result[i] = first[i] ^ second[i];
  }
  return result;
};
