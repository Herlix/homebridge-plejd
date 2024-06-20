import { createCipheriv, createHash } from "crypto";

export const plejdChalResp = (key: Buffer, chal: Buffer) => {
  const intermediate = createHash("sha256").update(xor(key, chal)).digest();

  const part1 = intermediate.slice(0, 16);
  const part2 = intermediate.slice(16);

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

export const reverseBuffer = (src: Buffer): Buffer => {
  const buffer = Buffer.allocUnsafe(src.length);

  for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
    buffer[i] = src[j];
    buffer[j] = src[i];
  }

  return buffer;
};

const xor = (first: Buffer, second: Buffer): Buffer => {
  const result = Buffer.alloc(first.length);
  for (let i = 0; i < first.length; i++) {
    result[i] = first[i] ^ second[i];
  }
  return result;
};
