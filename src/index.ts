import { API } from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { PlejdPlatform } from "./plejdPlatform";

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PlejdPlatform);
};
