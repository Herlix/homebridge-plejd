/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'Plejd';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-plejd';

export const PLEJD_WRITE_TIMEOUT = 100;
/**
 * Lights and switches from Plejd
 */
export const PLEJD_LIGHTS = ['DIM-01', 'DIM-02', 'LED-10', 'DIM-01-2P'];
export const PLEJD_SWITCHES = [
  'REL-01',
  'REL-02',
  'REL-01-2P',
  'DAL-01',
  'SPR-01',
  'CTR-01',
  'WPH-01',
];
export const PLEJD_SENSOR = ['GWY-01'];
