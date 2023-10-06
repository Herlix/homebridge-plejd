import PlejdRemoteApi from '../src/client/plejd_api';
import { LogLevel, Logger } from 'homebridge';
import 'dotenv/config';

const PASS = process.env.PASS!;
const USER = process.env.USER!;
const SITE = process.env.SITE!;

class ConsoleLogger implements Logger {
  prefix?: string | undefined;
  info(message: string, ...parameters: any[]): void {
    console.log(`info: ${message} - ${parameters}`);
  }
  warn(message: string, ...parameters: any[]): void {
    console.log(`warn: ${message} - ${parameters}`);
  }
  error(message: string, ...parameters: any[]): void {
    console.log(`error: ${message} - ${parameters}`);
  }
  debug(message: string, ...parameters: any[]): void {
    console.log(`debug: ${message} - ${parameters}`);
  }
  log(level: LogLevel, message: string, ...parameters: any[]): void {
    console.log(`log: ${message} - ${parameters}`);
  }
}

describe('Plejd API (e2e)', () => {
  let api: PlejdRemoteApi;

  beforeAll(async () => {
    api = new PlejdRemoteApi(SITE, USER, PASS, true, new ConsoleLogger());
  });

  it('should login', async () => {
    const result = await api.login();
    expect(result).toBeDefined();
  });

  // it('should get site', async () => {
  //   const result = await api.login();
  //   const site = await api.getSite(result);
  //   expect(site).toBeDefined();
  // });

  // it('should get site details', async () => {
  //   const result = await api.login();
  //   const site = await api.getSite(result);
  //   const siteDetails = await api.getSiteDetails(result, site.site.siteId);
  //   expect(siteDetails).toBeDefined();
  // });
});
