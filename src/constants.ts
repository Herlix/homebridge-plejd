/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = "Plejd";

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = "homebridge-plejd";

export const PLEJD_WRITE_TIMEOUT = 100;
export const PLEJD_PING_TIMEOUT = 3000;
export const DEFAULT_BRIGHTNESS_TRANSITION_MS = 0;
/**
 * Lights and switches from Plejd
 */
export const PLEJD_LIGHTS = ["DIM-01", "DIM-02", "LED-10", "LED-75"];

// const PLEJD_SWITCHES = [
//   "REL-01",
//   "REL-02",
//   "REL-01-2P",
//   "DAL-01",
//   "SPR-01",
//   "CTR-01",
// ];

export const PLEJD_ADDONS = [
  "RTR-01",
  "WPH-01",
  "WRT-01",
  "MNT-01",
  "MNT-02",
  "GWY-01",
  "BAT-01",
  "EXT-01",
  "WSM-01",
];
