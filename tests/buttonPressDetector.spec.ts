import { ButtonPressDetector, PressType } from "../src/ButtonPressDetector";
import {
  LONG_PRESS_THRESHOLD_MS,
  DOUBLE_PRESS_WINDOW_MS,
} from "../src/constants";

describe("ButtonPressDetector", () => {
  let detector: ButtonPressDetector;
  let detectedEvents: { device: number; button: number; type: PressType }[];

  beforeEach(() => {
    jest.useFakeTimers();
    detectedEvents = [];
    detector = new ButtonPressDetector((device, button, type) => {
      detectedEvents.push({ device, button, type });
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("Single press", () => {
    it("should emit SINGLE_PRESS after press → release → wait", () => {
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      expect(detectedEvents).toHaveLength(0);

      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS);

      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0]).toEqual({
        device: 1,
        button: 0,
        type: "SINGLE_PRESS",
      });
    });

    it("should not emit before the double press window expires", () => {
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS - 1);

      expect(detectedEvents).toHaveLength(0);
    });
  });

  describe("Double press", () => {
    it("should emit DOUBLE_PRESS on press → release → press → release within window", () => {
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      jest.advanceTimersByTime(100); // within double press window

      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0]).toEqual({
        device: 1,
        button: 0,
        type: "DOUBLE_PRESS",
      });
    });

    it("should not emit SINGLE_PRESS when second press arrives in time", () => {
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS - 1);

      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      // Only double press, no single press
      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0].type).toBe("DOUBLE_PRESS");
    });
  });

  describe("Long press", () => {
    it("should emit LONG_PRESS when held past threshold", () => {
      detector.handleEvent(1, 0, "press");

      expect(detectedEvents).toHaveLength(0);

      jest.advanceTimersByTime(LONG_PRESS_THRESHOLD_MS);

      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0]).toEqual({
        device: 1,
        button: 0,
        type: "LONG_PRESS",
      });
    });

    it("should not emit additional events on release after long press", () => {
      detector.handleEvent(1, 0, "press");
      jest.advanceTimersByTime(LONG_PRESS_THRESHOLD_MS);

      expect(detectedEvents).toHaveLength(1);

      detector.handleEvent(1, 0, "release");

      // No additional events after release
      expect(detectedEvents).toHaveLength(1);

      // Advance past any potential timers
      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS + LONG_PRESS_THRESHOLD_MS);
      expect(detectedEvents).toHaveLength(1);
    });

    it("should not emit LONG_PRESS if released before threshold", () => {
      detector.handleEvent(1, 0, "press");
      jest.advanceTimersByTime(LONG_PRESS_THRESHOLD_MS - 1);
      detector.handleEvent(1, 0, "release");

      // Should not have long press yet
      const longPresses = detectedEvents.filter((e) => e.type === "LONG_PRESS");
      expect(longPresses).toHaveLength(0);
    });
  });

  describe("Multiple independent buttons", () => {
    it("should track buttons independently", () => {
      // Button A: single press
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      // Button B: long press (on different device)
      detector.handleEvent(2, 0, "press");

      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS);

      // Button A should have emitted single press
      expect(detectedEvents).toContainEqual({
        device: 1,
        button: 0,
        type: "SINGLE_PRESS",
      });

      jest.advanceTimersByTime(
        LONG_PRESS_THRESHOLD_MS - DOUBLE_PRESS_WINDOW_MS,
      );

      // Button B should have emitted long press
      expect(detectedEvents).toContainEqual({
        device: 2,
        button: 0,
        type: "LONG_PRESS",
      });

      expect(detectedEvents).toHaveLength(2);
    });

    it("should track different button indices independently on same device", () => {
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");

      detector.handleEvent(1, 1, "press");
      detector.handleEvent(1, 1, "release");

      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS);

      expect(detectedEvents).toHaveLength(2);
      expect(detectedEvents).toContainEqual({
        device: 1,
        button: 0,
        type: "SINGLE_PRESS",
      });
      expect(detectedEvents).toContainEqual({
        device: 1,
        button: 1,
        type: "SINGLE_PRESS",
      });
    });
  });

  describe("Sequential presses", () => {
    it("should handle repeated single presses correctly", () => {
      // First single press
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");
      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS);

      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0].type).toBe("SINGLE_PRESS");

      // Second single press
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");
      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS);

      expect(detectedEvents).toHaveLength(2);
      expect(detectedEvents[1].type).toBe("SINGLE_PRESS");
    });

    it("should return to IDLE after long press release", () => {
      // Long press
      detector.handleEvent(1, 0, "press");
      jest.advanceTimersByTime(LONG_PRESS_THRESHOLD_MS);
      detector.handleEvent(1, 0, "release");

      expect(detectedEvents).toHaveLength(1);
      expect(detectedEvents[0].type).toBe("LONG_PRESS");

      // Should be back to IDLE, so a new single press should work
      detector.handleEvent(1, 0, "press");
      detector.handleEvent(1, 0, "release");
      jest.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS);

      expect(detectedEvents).toHaveLength(2);
      expect(detectedEvents[1].type).toBe("SINGLE_PRESS");
    });
  });
});
