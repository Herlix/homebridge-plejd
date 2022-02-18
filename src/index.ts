import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { PlejdPlatform } from './plejdPlatform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, PLATFORM_NAME, PlejdPlatform);
};
