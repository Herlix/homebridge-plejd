import EventEmitter from 'events';
import { Logger } from 'homebridge';
import { Site } from '../dto/plejdSite';
import { PlejdException } from '../exception';
import fetch from 'node-fetch';

const API_APP_ID = 'zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak';
const API_BASE_URL = 'https://cloud.plejd.com/parse/';
const API_LOGIN_URL = 'login';
const API_SITE_LIST_URL = 'functions/getSiteList';
const API_SITE_DETAILS_URL = 'functions/getSiteById';

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

export default class PlejdRemoteApi extends EventEmitter {
  log: Logger;
  siteName: string;
  username: string;
  password: string;
  includeRoomsAsLights: boolean;

  constructor(
    siteName: string,
    username: string,
    password: string,
    includeRoomsAsLights: boolean,
    log: Logger,
  ) {
    super();
    this.includeRoomsAsLights = includeRoomsAsLights;
    this.siteName = siteName;
    this.username = username;
    this.password = password;
    this.log = log;
  }

  async getPlejdRemoteSite(): Promise<Site> {
    try {
      const token = await this.login();
      const site = await this.getSite(token);
      return this.getSiteDetails(token, site.site.siteId);
    } catch (e) {
      if (e instanceof Error) {
        throw new PlejdException(e.message, e.stack);
      }
      throw new PlejdException(JSON.stringify(e));
    }
  }

  async login(): Promise<string> {
    const response = await fetch(API_BASE_URL + API_LOGIN_URL, {
      method: 'POST',
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new PlejdException('Unable to login to Plejd API');
    }

    const raw = await response.json();
    this.log.debug(JSON.stringify(raw, null, 2));
    const json = raw as { sessionToken?: string };

    return json.sessionToken!;
  }

  async getSite(token: string) {
    const response = await fetch(API_BASE_URL + API_SITE_LIST_URL, {
      method: 'POST',
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': token,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new PlejdException('Unable to get sites from Plejd API');
    }

    const raw = await response.json();
    this.log.debug(JSON.stringify(raw, null, 2));
    const json = raw as { result: SiteDto[] };

    return json.result.find((x) => x.site.title === this.siteName)!;
  }

  async getSiteDetails(token: string, siteId: string) {
    const response = await fetch(API_BASE_URL + API_SITE_DETAILS_URL, {
      method: 'POST',
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ siteId }),
    });

    if (!response.ok) {
      throw new PlejdException('Unable to get site details from Plejd API');
    }

    const raw = await response.json();
    this.log.debug(JSON.stringify(raw, null, 2));

    const json = raw as { result: Site[] };
    if (json.result.length === 0) {
      throw new PlejdException('No devices found');
    }

    return json.result[0];
  }
}
