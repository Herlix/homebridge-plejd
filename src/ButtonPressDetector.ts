export type PressType = "SINGLE_PRESS" | "DOUBLE_PRESS" | "LONG_PRESS";

type ButtonState =
  | "IDLE"
  | "PRESSED"
  | "WAITING_FOR_DOUBLE"
  | "DOUBLE_PRESSED"
  | "LONG_PRESS_ACTIVE";

interface ButtonContext {
  state: ButtonState;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  doublePressTimer: ReturnType<typeof setTimeout> | null;
}

interface LogFn {
  debug(message: string, ...params: unknown[]): void;
}

export class ButtonPressDetector {
  private buttons = new Map<string, ButtonContext>();

  constructor(
    private readonly onPressDetected: (
      deviceAddress: number,
      buttonIndex: number,
      pressType: PressType,
    ) => void,
    private readonly doublePressMsWindow: number,
    private readonly longPressMs: number,
    private readonly log?: LogFn,
  ) {}

  private getKey(deviceAddress: number, buttonIndex: number): string {
    return `${deviceAddress}:${buttonIndex}`;
  }

  private getContext(
    deviceAddress: number,
    buttonIndex: number,
  ): ButtonContext {
    const key = this.getKey(deviceAddress, buttonIndex);
    let ctx = this.buttons.get(key);
    if (!ctx) {
      ctx = { state: "IDLE", longPressTimer: null, doublePressTimer: null };
      this.buttons.set(key, ctx);
    }
    return ctx;
  }

  private clearTimers(ctx: ButtonContext) {
    if (ctx.longPressTimer) {
      clearTimeout(ctx.longPressTimer);
      ctx.longPressTimer = null;
    }
    if (ctx.doublePressTimer) {
      clearTimeout(ctx.doublePressTimer);
      ctx.doublePressTimer = null;
    }
  }

  handleEvent(
    deviceAddress: number,
    buttonIndex: number,
    action: "press" | "release",
  ) {
    const ctx = this.getContext(deviceAddress, buttonIndex);

    if (action === "press") {
      this.handlePress(ctx, deviceAddress, buttonIndex);
    } else {
      this.handleRelease(ctx, deviceAddress, buttonIndex);
    }
  }

  private handlePress(
    ctx: ButtonContext,
    deviceAddress: number,
    buttonIndex: number,
  ) {
    const key = `${deviceAddress}:${buttonIndex}`;
    const prevState = ctx.state;

    switch (ctx.state) {
      case "IDLE": {
        this.clearTimers(ctx);
        ctx.state = "PRESSED";
        this.log?.debug(
          `ButtonDetector [${key}] PRESS: ${prevState} → PRESSED (long-press timer started: ${this.longPressMs}ms)`,
        );
        ctx.longPressTimer = setTimeout(() => {
          ctx.longPressTimer = null;
          ctx.state = "LONG_PRESS_ACTIVE";
          this.log?.debug(
            `ButtonDetector [${key}] LONG_PRESS timer fired → emitting LONG_PRESS`,
          );
          this.onPressDetected(deviceAddress, buttonIndex, "LONG_PRESS");
        }, this.longPressMs);
        break;
      }
      case "WAITING_FOR_DOUBLE": {
        this.clearTimers(ctx);
        ctx.state = "DOUBLE_PRESSED";
        this.log?.debug(
          `ButtonDetector [${key}] PRESS: ${prevState} → DOUBLE_PRESSED (waiting for release)`,
        );
        break;
      }
      case "PRESSED":
      case "DOUBLE_PRESSED":
      case "LONG_PRESS_ACTIVE": {
        // Plejd buttons send identical 0016 events for both press and release
        // (no action byte). Treat a "press" in these states as an implicit release.
        this.log?.debug(
          `ButtonDetector [${key}] PRESS in ${prevState} → treating as implicit RELEASE`,
        );
        this.handleRelease(ctx, deviceAddress, buttonIndex);
        break;
      }
    }
  }

  private handleRelease(
    ctx: ButtonContext,
    deviceAddress: number,
    buttonIndex: number,
  ) {
    const key = `${deviceAddress}:${buttonIndex}`;
    const prevState = ctx.state;

    switch (ctx.state) {
      case "PRESSED": {
        this.clearTimers(ctx);
        ctx.state = "WAITING_FOR_DOUBLE";
        this.log?.debug(
          `ButtonDetector [${key}] RELEASE: ${prevState} → WAITING_FOR_DOUBLE (double-press window: ${this.doublePressMsWindow}ms)`,
        );
        ctx.doublePressTimer = setTimeout(() => {
          ctx.doublePressTimer = null;
          ctx.state = "IDLE";
          this.log?.debug(
            `ButtonDetector [${key}] double-press window expired → emitting SINGLE_PRESS`,
          );
          this.onPressDetected(deviceAddress, buttonIndex, "SINGLE_PRESS");
        }, this.doublePressMsWindow);
        break;
      }
      case "DOUBLE_PRESSED": {
        this.clearTimers(ctx);
        ctx.state = "IDLE";
        this.log?.debug(
          `ButtonDetector [${key}] RELEASE: ${prevState} → IDLE → emitting DOUBLE_PRESS`,
        );
        this.onPressDetected(deviceAddress, buttonIndex, "DOUBLE_PRESS");
        break;
      }
      case "LONG_PRESS_ACTIVE": {
        this.clearTimers(ctx);
        ctx.state = "IDLE";
        this.log?.debug(
          `ButtonDetector [${key}] RELEASE: ${prevState} → IDLE (long press ended)`,
        );
        break;
      }
      default:
        this.log?.debug(
          `ButtonDetector [${key}] RELEASE ignored in state ${prevState}`,
        );
        break;
    }
  }
}
