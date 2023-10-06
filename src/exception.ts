export class PlejdException implements Error {

  constructor(
    message: string,
    stack?: string | undefined) {
    this.name = 'PlejdError';
    this.message = message;
    this.stack = stack;
  }

  name: string;
  message: string;
  stack?: string | undefined;

}