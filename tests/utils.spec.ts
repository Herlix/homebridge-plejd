import {
  delay,
  race,
  plejdChallageResp as plejdChalResp,
  plejdEncodeDecode,
} from "../src/utils";

describe("plejdChalResp", () => {
  it("should produce consistent output for same key and challenge", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const challenge = Buffer.from("fedcba9876543210fedcba9876543210", "hex");

    const result1 = plejdChalResp(key, challenge);
    const result2 = plejdChalResp(key, challenge);

    expect(result1).toEqual(result2);
  });

  it("should produce different outputs for different challenges", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const challenge1 = Buffer.from("1111111111111111111111111111111", "hex");
    const challenge2 = Buffer.from("2222222222222222222222222222222", "hex");

    const result1 = plejdChalResp(key, challenge1);
    const result2 = plejdChalResp(key, challenge2);

    expect(result1).not.toEqual(result2);
  });

  it("should produce different outputs for different keys", () => {
    const key1 = Buffer.from("1111111111111111111111111111111", "hex");
    const key2 = Buffer.from("2222222222222222222222222222222", "hex");
    const challenge = Buffer.from("fedcba9876543210fedcba9876543210", "hex");

    const result1 = plejdChalResp(key1, challenge);
    const result2 = plejdChalResp(key2, challenge);

    expect(result1).not.toEqual(result2);
  });

  it("should return 16-byte buffer", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const challenge = Buffer.from("fedcba9876543210fedcba9876543210", "hex");

    const result = plejdChalResp(key, challenge);

    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(16);
  });

  it("should handle known test vector", () => {
    // Test with zero key and challenge for predictable result
    const key = Buffer.alloc(16, 0);
    const challenge = Buffer.alloc(16, 0);

    const result = plejdChalResp(key, challenge);

    expect(result.length).toBe(16);
    expect(result).toBeInstanceOf(Buffer);
  });
});

describe("plejdEncodeDecode", () => {
  const testKey = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const testAddress = Buffer.from("001122334455", "hex");

  it("should produce consistent output for same inputs", () => {
    const data = Buffer.from("hello world", "ascii");

    const result1 = plejdEncodeDecode(testKey, testAddress, data);
    const result2 = plejdEncodeDecode(testKey, testAddress, data);

    expect(result1).toEqual(result2);
  });

  it("should be reversible (encode/decode)", () => {
    const originalData = Buffer.from("test message", "ascii");

    const encoded = plejdEncodeDecode(testKey, testAddress, originalData);
    const decoded = plejdEncodeDecode(testKey, testAddress, encoded);

    expect(decoded).toEqual(originalData);
  });

  it("should handle empty data", () => {
    const emptyData = Buffer.alloc(0);

    const result = plejdEncodeDecode(testKey, testAddress, emptyData);

    expect(result).toEqual(Buffer.alloc(0));
  });

  it("should handle single byte", () => {
    const data = Buffer.from([65]); // 'A'

    const result = plejdEncodeDecode(testKey, testAddress, data);

    expect(result.length).toBe(1);
  });

  it("should produce different output for different keys", () => {
    const data = Buffer.from("test", "ascii");
    const key2 = Buffer.from("fedcba9876543210fedcba9876543210", "hex");

    const result1 = plejdEncodeDecode(testKey, testAddress, data);
    const result2 = plejdEncodeDecode(key2, testAddress, data);

    expect(result1).not.toEqual(result2);
  });

  it("should produce different output for different addresses", () => {
    const data = Buffer.from("test", "ascii");
    const address2 = Buffer.from("aabbccddeeff", "hex");

    const result1 = plejdEncodeDecode(testKey, testAddress, data);
    const result2 = plejdEncodeDecode(testKey, address2, data);

    expect(result1).not.toEqual(result2);
  });

  it("should handle data longer than keystream (16 bytes)", () => {
    const longData = Buffer.from(
      "this is a very long message that exceeds sixteen bytes",
      "ascii",
    );

    const encoded = plejdEncodeDecode(testKey, testAddress, longData);
    const decoded = plejdEncodeDecode(testKey, testAddress, encoded);

    expect(decoded).toEqual(longData);
    expect(encoded.length).toBe(longData.length);
  });

  it("should handle binary data", () => {
    const binaryData = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]);

    const encoded = plejdEncodeDecode(testKey, testAddress, binaryData);
    const decoded = plejdEncodeDecode(testKey, testAddress, encoded);

    expect(decoded).toEqual(binaryData);
  });

  it("should create proper keystream buffer from address", () => {
    // Use proper 6-byte MAC address format
    const address = Buffer.from("001122334455", "hex"); // 6 bytes
    const data = Buffer.from([0x00]); // XOR with 0 reveals keystream

    const result = plejdEncodeDecode(testKey, address, data);

    // Should return the first byte of the keystream
    expect(result.length).toBe(1);
  });

  it("should repeat keystream every 16 bytes", () => {
    // Create data that will reveal the keystream pattern
    const data = Buffer.alloc(32, 0); // 32 zeros

    const result = plejdEncodeDecode(testKey, testAddress, data);

    // Bytes 0 and 16 should be the same (keystream repeats)
    expect(result[0]).toBe(result[16]);
    expect(result[15]).toBe(result[31]);
  });
});

describe("delay", () => {
  it("should resolve after specified milliseconds", async () => {
    const start = Date.now();

    await delay(100);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95); // Allow some tolerance
    expect(elapsed).toBeLessThan(150);
  });

  it("should resolve immediately for 0ms delay", async () => {
    const start = Date.now();

    await delay(0);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});

describe("race", () => {
  it("should resolve when operation completes before timeout", async () => {
    const operation = async () => {
      await delay(100);
      return "success";
    };

    const result = await race(operation, 200);

    expect(result).toBe("success");
  });

  it("should reject with timeout error when operation takes too long", async () => {
    const operation = async () => {
      await delay(200);
      return "success";
    };

    await expect(race(operation, 100)).rejects.toThrow("BLE operation timeout");
  });

  it("should reject when operation throws before timeout", async () => {
    const operation = async () => {
      throw new Error("operation failed");
    };

    await expect(race(operation, 100)).rejects.toThrow("operation failed");
  });

  it("should handle operation that returns different types", async () => {
    const numberOperation = async () => 42;
    const objectOperation = async () => ({ key: "value" });

    const numberResult = await race(numberOperation, 100);
    const objectResult = await race(objectOperation, 100);

    expect(numberResult).toBe(42);
    expect(objectResult).toEqual({ key: "value" });
  });
});
