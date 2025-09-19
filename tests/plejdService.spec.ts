import { Logger } from "homebridge/lib/logger";
import { PlejdCommand, PlejdService } from "../src/plejdService";
import { PLEJD_WRITE_TIMEOUT } from "../src/constants";

describe("PlejdService updateState", () => {
  let service: PlejdService;

  beforeEach(() => {
    service = new PlejdService(
      {
        devices: [],
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
    it("should return if no brightness change is made", async () => {
      const deviceId = 42;
      const brightness = 50; // 50% brightness
      const transitionMS = 500;
      await service.updateState(deviceId, true, {
        currentBrightness: brightness,
        targetBrightness: brightness,
        transitionMs: transitionMS,
      });
      const queue = service.readQueue();
      expect(queue.length).toBe(0);
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
        expect(command.substring(10, 14)).toBe("0100"); // isOn = true
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
        const brightnessHex = command.substring(14, 18);
        const brightnessValue = parseInt(brightnessHex, 16);
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
