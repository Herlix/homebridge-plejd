/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = "Plejd";

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = "homebridge-plejd";

// BLE Communication Timeouts
export const PLEJD_WRITE_TIMEOUT = 50;
export const PLEJD_PING_TIMEOUT = 3000;
export const DEFAULT_BRIGHTNESS_TRANSITION_MS = 0;

// Connection Management
export const CONNECT_TIMEOUT = 10000;
export const RECONNECT_DELAY = 2000;
export const MAX_PING_FAILURES = 3;
export const DEVICE_COOLDOWN = 60000;

// Device Requirements
export const MIN_PAYLOAD_LENGTH = 5;

// Authentication
export const AUTH_STEP_DELAY = 100;

// Probing
export const PROBE_TIMEOUT = 30000;
