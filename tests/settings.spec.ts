import { isDimmable, isAddon } from "../src/settings";

describe("Device Type Detection", () => {
  describe("isDimmable", () => {
    const testCases = [
      { model: "DIM-01", expected: true },
      { model: "DIM-02", expected: true },
      { model: "LED-10", expected: true },
      { model: "DIM-01-2P", expected: true },
      { model: "LED-75", expected: true },
      { model: "DIM-02-LC 2024 Q2", expected: true },
      { model: "Dim 2.2.1 Release Candidate", expected: true },
      { model: "RTR-01", expected: false },
      { model: "WPH-01", expected: false },
      { model: "UNKNOWN-MODEL", expected: false },
    ];

    testCases.forEach(({ model, expected }) => {
      it(`should identify ${model} as ${expected ? "dimmable" : "non-dimmable"}`, () => {
        expect(isDimmable(model)).toBe(expected);
      });
    });

    // Test with real-world data
    const realWorldDimmers = [
      "DIM-02-LC 2024 Q2",
      "Dim 2.2.1 Release Candidate",
      "DIM-02",
      "DIM-01",
    ];

    realWorldDimmers.forEach((model) => {
      it(`should identify real-world model ${model} as dimmable`, () => {
        expect(isDimmable(model)).toBe(true);
      });
    });
  });

  describe("isAddon", () => {
    const testCases = [
      { model: "RTR-01", expected: true },
      { model: "WPH-01", expected: true },
      { model: "WRT-01", expected: true },
      { model: "MNT-01", expected: true },
      { model: "MNT-02", expected: true },
      { model: "GWY-01", expected: true },
      { model: "BAT-01", expected: true },
      { model: "EXT-01", expected: true },
      { model: "DIM-01", expected: false },
      { model: "UNKNOWN-MODEL", expected: false },
    ];

    testCases.forEach(({ model, expected }) => {
      it(`should identify ${model} as ${expected ? "addon" : "non-addon"}`, () => {
        expect(isAddon(model)).toBe(expected);
      });
    });
  });
});
