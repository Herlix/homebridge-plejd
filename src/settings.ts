/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'Plejd';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-plejd';

/**
 * Lights and switches from Plejd
 */
export const PLEJD_LIGHTS = ['DIM-01', 'DIM-02', 'LED-10'];
export const PLEJD_SWITCHES = ['REL-02', 'REL-01-2P', 'DAL-01', 'SPR-01', 'CTR-01'];

/**
 * Plejd BLE UUIDs
 */
export const PLEJD_SERVICE_UUID = '31ba000160854726be45040c957391b5';
export const PLEJD_CHARACTERISTIC_DATA_UUID = '31ba000460854726be45040c957391b5';
export const PLEJD_CHARACTERISTIC_LAST_DATA_UUID = '31ba000560854726be45040c957391b5';
export const PLEJD_CHARACTERISTIC_AUTH_UUID = '31ba000960854726be45040c957391b5';
export const PLEJD_CHARACTERISTIC_PING_UUID = '31ba000a60854726be45040c957391b5';