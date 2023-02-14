import axios from 'axios';
import EventEmitter from 'events';
import { Logger } from 'homebridge';
import { Site } from './model/plejdSite';

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

  sessionToken?: string;
  site?: Site;

  constructor(
    log: Logger,
    siteName: string,
    username: string,
    password: string,
    includeRoomsAsLights: boolean,
  ) {
    super();
    this.log = log;
    this.includeRoomsAsLights = includeRoomsAsLights;
    this.siteName = siteName;
    this.username = username;
    this.password = password;
  }

  getPlejdRemoteSite = (): Promise<Site> => {
    return new Promise<Site>((resolve, reject) => {
      this.login()
        .then(() => {

          this.getSites()
            .then((site) => {

              this.getSite(site)
                .then(site => {
                  resolve(site);
                })
                .catch(e => {
                  this.log.error(`${e}`);
                  reject(e);
                });

            }).catch(e => {
              this.log.error(`${e}`);
              reject(e);
            });

        }).catch(e => {
          this.log.error(`${e}`);
          reject(e);
        });
    });
  };

  private login = () => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'Content-Type': 'application/json',
      },
    });

    return new Promise<string>((resolve, reject) => {
      instance.post(
        API_LOGIN_URL,
        {
          'username': this.username,
          'password': this.password,
        })
        .then((response) => {
          this.log.debug('plejd-api: got session token response');
          this.sessionToken = response.data.sessionToken;

          if (!this.sessionToken) {
            reject('no session token received.');
            return;
          }


          resolve(response.data.sessionToken);
        })
        .catch((error) => {
          if (error.response.status === 400) {
            reject('error: server returned status 400. probably invalid credentials, please verify.');
          } else {
            reject('error: unable to retrieve session token response: ' + error);
          }
        });
    });
  };

  private getSites = () => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json',
      },
    });

    return new Promise<SiteDto>((resolve, reject) => {
      this.log.debug('Sending POST to ' + API_BASE_URL + API_SITE_LIST_URL);

      instance.post(API_SITE_LIST_URL)
        .then((response) => {
          this.log.debug('plejd-api: got detailed sites response');
          const site = response.data.result.find(x => x.site.title === this.siteName);

          if (!site) {
            reject('failed to find a site named ' + this.siteName);
            return;
          }

          resolve(site as SiteDto);
        })
        .catch((error) => {
          return reject('plejd-api: unable to retrieve list of sites. error: ' + error);
        });
    });
  };

  private getSite = (site: SiteDto) => {
    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json',
      },
    });

    return new Promise<Site>((resolve, reject) => {
      this.log.debug('Sending POST to ' + API_BASE_URL + API_SITE_DETAILS_URL);

      instance.post(API_SITE_DETAILS_URL, { siteId: site.site.siteId })
        .then((response) => {
          this.log.debug('plejd-api: got site details response');
          if (response.data.result.length === 0) {
            reject('No devices fount');
            return;
          }

          this.site = response.data.result[0] as Site;
          if (this.site) {
            resolve(this.site!);
          } else {
            reject('No Crypto has been retrieved yet');
          }
        })
        .catch((error) => {
          return reject('plejd-api: unable to retrieve the crypto key. error: ' + error);
        });
    });
  };
}