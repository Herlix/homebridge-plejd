import { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { PlejdHbPlatform } from './PlejdHbPlatform.js';

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PlejdHbPlatform);
};
