import { API } from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { PlejdPlatform } from "./plejdPlatform.js";

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PlejdPlatform);
};
