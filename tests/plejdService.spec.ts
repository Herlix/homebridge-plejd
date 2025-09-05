import { Logger } from "homebridge/lib/logger";
import { PlejdCommand, PlejdService } from "../src/plejdService";
import { PLEJD_WRITE_TIMEOUT } from "../src/settings";

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

  describe("Turn off scenarios", () => {
    it.each([
      ["isOn=false, brightness=undefined", false, undefined],
      ["isOn=false, brightness=0", false, 0],
      ["isOn=true, brightness=0", true, 0],
      ["isOn=true, brightness=undefined", true, undefined],
    ])("%s should queue a turn off command", async (_, isOn, brightness) => {
      const deviceId = 42;
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
        "00";

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
        transitionMS: transitionMS,
      });
      const queue = service.readQueue();
      expect(queue.length).toBe(0);
    });

    it("should queue multiple brightness commands for a transition", async () => {
      const deviceId = 42;
      const brightness = 50; // 50% brightness
      const transitionMS = 500;

      await service.updateState(deviceId, true, {
        targetBrightness: brightness,
        transitionMS: transitionMS,
      });

      const queue = service.readQueue();

      // Calculate expected number of steps
      const expectedSteps = Math.round(transitionMS / PLEJD_WRITE_TIMEOUT);
      expect(queue.length).toBe(expectedSteps);

      // Check that all commands are brightness commands
      queue.forEach((item) => {
        const command = item.toString("hex");
        expect(command.substring(2, 6)).toBe(PlejdCommand.RequestNoResponse);
        expect(command.substring(6, 10)).toBe(PlejdCommand.Brightness);
        expect(command.substring(10, 14)).toBe("0100"); // isOn = true
      });

      // Check that the brightness is distributed correctly
      const newBrightness = Math.round(2.55 * brightness);
      const brightnessStep = Math.round(newBrightness / expectedSteps);

      queue.forEach((item) => {
        const command = item.toString("hex");
        const brightnessHex = command.substring(14, 18);
        const brightnessValue = parseInt(brightnessHex, 16);
        expect(brightnessValue).toBe(brightnessStep);
      });
    });

    it("should handle a 1-second transition with default parameters", async () => {
      const deviceId = 42;
      const brightness = 100;

      await service.updateState(deviceId, true, {
        targetBrightness: brightness,
      }); // Default transition of 1000ms

      const queue = service.readQueue();

      // With default 1000ms and assuming PLEJD_WRITE_TIMEOUT = 100
      const expectedSteps = 10;
      expect(queue.length).toBe(expectedSteps);
    });
  });
});
