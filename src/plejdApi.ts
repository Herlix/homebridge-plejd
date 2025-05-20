import { Logger } from "homebridge";
import { Site } from "./model/plejdSite.js";

const API_APP_ID = "zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak";
const API_BASE_URL = "https://cloud.plejd.com/parse/";
const API_LOGIN_URL = "login";
const API_SITE_LIST_URL = "functions/getSiteList";
const API_SITE_DETAILS_URL = "functions/getSiteById";

interface SitePermissionDto {
  siteId: string;
  isOwner: boolean;
  isInstaller: boolean;
  isUser: boolean;
  locked: boolean;
  hidden: boolean;
}

interface SiteInfo {
  siteId: string;
  title: string;
}

interface SiteDto {
  site: SiteInfo;
  plejdDevice: string[];
  gateway: string[];
  hasRemoteControlAccess: boolean;
  sitePermission: SitePermissionDto;
}

export default class PlejdRemoteApi {
  log: Logger;
  siteName: string;
  username: string;
  password: string;
  includeRoomsAsLights: boolean;

  constructor(
    log: Logger,
    siteName: string,
    username: string,
    password: string,
    includeRoomsAsLights: boolean,
  ) {
    this.log = log;
    this.includeRoomsAsLights = includeRoomsAsLights;
    this.siteName = siteName;
    this.username = username;
    this.password = password;
  }

  async getPlejdRemoteSite(): Promise<Site> {
    const token = await this.login();
    const site = await this.getSites(token);
    return await this.getSite(site, token);
  }

  private async login(): Promise<string> {
    const response = await fetch(API_BASE_URL + API_LOGIN_URL, {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": API_APP_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    if (!response.ok) {
      if (response.status === 400) {
        throw new Error(
          "error: server returned status 400. probably invalid credentials, please verify.",
        );
      } else {
        throw new Error(
          "error: unable to retrieve session token response: " +
            response.statusText,
        );
      }
    }

    const data = await response.json();
    if (!data.sessionToken) {
      throw new Error("no session token received.");
    }

    return data.sessionToken;
  }

  private async getSites(token: string): Promise<SiteDto> {
    const response = await fetch(API_BASE_URL + API_SITE_LIST_URL, {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": API_APP_ID,
        "X-Parse-Session-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        "plejd-api: unable to retrieve list of sites. error: " +
          response.statusText,
      );
    }

    const data = await response.json();
    const site = data.result.find(
      (x: SiteDto) => x.site.title === this.siteName,
    );

    if (!site) {
      throw new Error("failed to find a site named " + this.siteName);
    }

    return site as SiteDto;
  }

  private async getSite(site: SiteDto, token: string): Promise<Site> {
    const response = await fetch(API_BASE_URL + API_SITE_DETAILS_URL, {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": API_APP_ID,
        "X-Parse-Session-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ siteId: site.site.siteId }),
    });

    if (!response.ok) {
      throw new Error(
        "plejd-api: unable to retrieve the crypto key. error: " +
          response.statusText,
      );
    }

    const data = await response.json();
    if (data.result.length === 0) {
      throw new Error("No devices found");
    }

    const res = data.result[0] as Site;
    if (res) {
      return res;
    } else {
      throw new Error("No Crypto has been retrieved yet");
    }
  }
}
