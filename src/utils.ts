import { createCipheriv, createHash } from "crypto";

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an operation with configurable retries and delay
 * @param operation - The async operation to retry
 * @param options - Configuration for retries
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; delayMs?: number } = {},
): Promise<T> => {
  const { maxRetries = 3, delayMs = 100 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await delay(delayMs);
      }
    }
  }

  throw lastError;
};

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

const xor = (first: Buffer, second: Buffer): Buffer => {
  const result = Buffer.alloc(first.length);
  for (let i = 0; i < first.length; i++) {
    result[i] = first[i] ^ second[i];
  }
  return result;
};
