import { Logger } from "homebridge/lib/logger";
import {
  PlejdCommand,
  PlejdService,
  parseThermostatState,
} from "../src/plejdService";
import { PLEJD_WRITE_TIMEOUT } from "../src/constants";

describe("PlejdService updateState", () => {
  let service: PlejdService;

  beforeEach(() => {
    service = new PlejdService(
      {
        devices: [],
        scenes: [],
        buttons: [],
        cryptoKey: Buffer.from("FooBar", "utf8"),
      },
      Logger.withPrefix("PlejdServiceTests"),
      () => {},
    );
  });

  describe("Turn on/off scenarios", () => {
    it.each([
      ["isOn=false, brightness=undefined", false, undefined],
      ["isOn=false, brightness=0", false, 0],
      ["isOn=true, brightness=0", true, 0],
      ["isOn=true, brightness=undefined", true, undefined],
      ["isOn=true, brightness=0", true, 0],
      // ["isOn=true, brightness=1 (Not needed due to brightness change)", true, 1],
    ])("%s should queue a turn off command", async (_, isOn, brightness) => {
      const deviceId = 42;
      const refQueue = service.readQueue();
      expect(refQueue.length).toBe(0);

      await service.updateState(deviceId, isOn, {
        targetBrightness: brightness,
      });

      const queue = service.readQueue();
      expect(queue.length).toBe(1);

      const command = queue[0].toString("hex");
      const expected =
        deviceId.toString(16).padStart(2, "0") +
        PlejdCommand.RequestNoResponse +
        PlejdCommand.OnOffState +
        (isOn ? "01" : "00");

      expect(command).toBe(expected);
    });
  });

  describe("Brightness transition scenarios", () => {
    it("should send brightness commands even when current equals target", async () => {
      const deviceId = 42;
      const brightness = 50; // 50% brightness
      const transitionMS = 500;
      await service.updateState(deviceId, true, {
        currentBrightness: brightness,
        targetBrightness: brightness,
        transitionMs: transitionMS,
      });
      const queue = service.readQueue();
      // Commands are always sent to ensure device state stays in sync
      const expectedSteps = Math.round(transitionMS / PLEJD_WRITE_TIMEOUT);
      expect(queue.length).toBe(expectedSteps);
    });

    it("should queue multiple brightness commands for a transition", async () => {
      const deviceId = 42;
      const currentBrightness = 10;
      const targetBrightness = 70;
      const transitionMs = 500;

      await service.updateState(deviceId, true, {
        targetBrightness,
        currentBrightness,
        transitionMs,
      });

      const queue = service.readQueue();

      const expectedSteps = Math.round(transitionMs / PLEJD_WRITE_TIMEOUT);
      expect(queue.length).toBe(expectedSteps);

      queue.forEach((item) => {
        const command = item.toString("hex");
        expect(command.substring(2, 6)).toBe(PlejdCommand.RequestNoResponse);
        expect(command.substring(6, 10)).toBe(PlejdCommand.Brightness);
        expect(command.substring(10, 12)).toBe("01"); // state = on
      });

      for (let step = 1; step <= expectedSteps; step++) {
        const brightnessDifference = targetBrightness - currentBrightness;
        const currentStepBrightness = Math.min(
          100,
          Math.max(
            0,
            currentBrightness + (brightnessDifference * step) / expectedSteps,
          ),
        );
        const eightBitBrightness = Math.round(currentStepBrightness * 2.55);
        const item = queue[expectedSteps - step];
        const command = item.toString("hex");
        // Plejd protocol: same dim byte sent twice (positions 12-14 and 14-16)
        const dimByte1 = command.substring(12, 14);
        const dimByte2 = command.substring(14, 16);
        expect(dimByte1).toBe(dimByte2); // Same byte repeated
        const brightnessValue = parseInt(dimByte1, 16);
        expect(brightnessValue).toBe(eightBitBrightness);
      }
    });

    it("should handle a 1-second transition with default parameters", async () => {
      const deviceId = 42;
      const brightness = 100;

      await service.updateState(deviceId, true, {
        targetBrightness: brightness,
        transitionMs: 1000,
      });
      const queue = service.readQueue();

      expect(queue.length).toBe(1000 / PLEJD_WRITE_TIMEOUT);
    });

    it("should handle a 0-ms transition with default parameters", async () => {
      const deviceId = 42;
      const brightness = 100;

      await service.updateState(deviceId, true, {
        targetBrightness: brightness,
      });

      const queue = service.readQueue();

      // With default 1000ms and assuming PLEJD_WRITE_TIMEOUT = 100
      const expectedSteps = 1;
      expect(queue.length).toBe(expectedSteps);
    });
  });
});

describe("parseThermostatState", () => {
  it("should parse normal operating state", () => {
    // Mode=7 (Normal), no error, target=30°C (raw 40), current=22°C (raw 32)
    // Bit layout: 0000 000M MMET TTTT TTCC CCCC
    // Mode=7 (111), Error=0, Target=40 (0101000), Current=32 (100000)
    // = 0000 0001 1101 0100 0100 0000
    // = 0x01D440
    const stateByte = 0x01; // high byte
    const payload = Buffer.from([0xd4, 0x40]); // middle and low bytes

    const result = parseThermostatState(stateByte, payload);

    expect(result.mode).toBe(7);
    expect(result.error).toBe(false);
    expect(result.target).toBe(30);
    expect(result.current).toBe(22);
    expect(result.heating).toBeNull();
  });

  it("should parse state with heating active", () => {
    // Same as above but with 3rd payload byte indicating heating
    const stateByte = 0x01;
    const payload = Buffer.from([0xd4, 0x40, 0x80]);

    const result = parseThermostatState(stateByte, payload);

    expect(result.mode).toBe(7);
    expect(result.target).toBe(30);
    expect(result.current).toBe(22);
    expect(result.heating).toBe(true);
  });

  it("should parse state with heating inactive", () => {
    const stateByte = 0x01;
    const payload = Buffer.from([0xd4, 0x40, 0x00]);

    const result = parseThermostatState(stateByte, payload);

    expect(result.heating).toBe(false);
  });

  it("should parse OFF mode (mode=0)", () => {
    // Mode=0, no error, target=25°C (raw 35), current=20°C (raw 30)
    // Mode=0 (000), Error=0, Target=35 (0100011), Current=30 (011110)
    // = 0000 0000 0010 0011 0011 1110
    // = 0x00233E
    const stateByte = 0x00;
    const payload = Buffer.from([0x23, 0x3e]);

    const result = parseThermostatState(stateByte, payload);

    expect(result.mode).toBe(0);
    expect(result.error).toBe(false);
    expect(result.target).toBe(25);
    expect(result.current).toBe(20);
  });

  it("should parse error state", () => {
    // Error bit set (bit 13)
    // Mode=0, Error=1, Target=0, Current=0
    // = 0000 0000 0010 0000 0000 0000
    // = 0x002000
    const stateByte = 0x00;
    const payload = Buffer.from([0x20, 0x00]);

    const result = parseThermostatState(stateByte, payload);

    expect(result.mode).toBeNull();
    expect(result.error).toBe(true);
    expect(result.target).toBe(-10);
    expect(result.current).toBe(-10);
  });

  it("should parse negative temperatures (below 10 raw offset)", () => {
    // Mode=7, target=5°C (raw 15), current=-5°C (raw 5)
    // Mode=7 (111), Error=0, Target=15 (0001111), Current=5 (000101)
    // = 0000 0001 1100 0011 1100 0101
    // = 0x01C3C5
    const stateByte = 0x01;
    const payload = Buffer.from([0xc3, 0xc5]);

    const result = parseThermostatState(stateByte, payload);

    expect(result.mode).toBe(7);
    expect(result.target).toBe(5);
    expect(result.current).toBe(-5);
  });

  it("should parse vacation mode (mode=2)", () => {
    // Mode=2 (010), target=15°C (raw 25), current=18°C (raw 28)
    // = 0000 0000 1000 0110 0101 1100
    // = 0x00865C
    const stateByte = 0x00;
    const payload = Buffer.from([0x86, 0x5c]);

    const result = parseThermostatState(stateByte, payload);

    expect(result.mode).toBe(2);
    expect(result.target).toBe(15);
    expect(result.current).toBe(18);
  });
});

describe("PlejdService updateThermostat", () => {
  let service: PlejdService;

  beforeEach(() => {
    service = new PlejdService(
      {
        devices: [
          {
            name: "Thermostat",
            model: "TRM-01",
            identifier: 10,
            outputType: "CLIMATE",
            uuid: "test-uuid",
            hidden: false,
            plejdDeviceId: "AABBCCDDEEFF",
          },
        ],
        scenes: [],
        buttons: [],
        cryptoKey: Buffer.from("FooBar", "utf8"),
      },
      Logger.withPrefix("PlejdServiceTests"),
      () => {},
    );
  });

  it("should queue a mode command", () => {
    service.updateThermostat(10, { mode: 7 });

    const queue = service.readQueue();
    expect(queue.length).toBe(1);

    const command = queue[0].toString("hex");
    // device 10 = 0x0a
    expect(command).toBe(
      "0a" + PlejdCommand.RequestNoResponse + PlejdCommand.TrmMode + "07",
    );
  });

  it("should queue a mode OFF command", () => {
    service.updateThermostat(10, { mode: 0 });

    const queue = service.readQueue();
    expect(queue.length).toBe(1);

    const command = queue[0].toString("hex");
    expect(command).toBe(
      "0a" + PlejdCommand.RequestNoResponse + PlejdCommand.TrmMode + "00",
    );
  });

  it("should queue a target temperature command", () => {
    // 22.5°C → 225 → 0xE1 0x00 (little-endian)
    service.updateThermostat(10, { targetTemp: 22.5 });

    const queue = service.readQueue();
    expect(queue.length).toBe(1);

    const command = queue[0].toString("hex");
    expect(command).toBe(
      "0a" +
        PlejdCommand.RequestNoResponse +
        PlejdCommand.TrmSetpoint +
        "e100",
    );
  });

  it("should queue a target temperature command for 30°C", () => {
    // 30°C → 300 → 0x2C 0x01 (little-endian)
    service.updateThermostat(10, { targetTemp: 30 });

    const queue = service.readQueue();
    expect(queue.length).toBe(1);

    const command = queue[0].toString("hex");
    expect(command).toBe(
      "0a" +
        PlejdCommand.RequestNoResponse +
        PlejdCommand.TrmSetpoint +
        "2c01",
    );
  });

  it("should queue a PWM duty command", () => {
    service.updateThermostat(10, { pwmDuty: 75 });

    const queue = service.readQueue();
    expect(queue.length).toBe(1);

    const command = queue[0].toString("hex");
    expect(command).toBe(
      "0a" + PlejdCommand.RequestNoResponse + PlejdCommand.TrmPwmDuty + "4b",
    );
  });

  it("should queue both mode and temperature commands", () => {
    service.updateThermostat(10, { mode: 7, targetTemp: 22 });

    const queue = service.readQueue();
    expect(queue.length).toBe(2);

    // Temperature is added second (unshift puts it first in queue)
    const tempCmd = queue[0].toString("hex");
    expect(tempCmd).toContain(PlejdCommand.TrmSetpoint);

    const modeCmd = queue[1].toString("hex");
    expect(modeCmd).toContain(PlejdCommand.TrmMode);
  });
});
