import {
  LONG_PRESS_THRESHOLD_MS,
  DOUBLE_PRESS_WINDOW_MS,
} from "./constants.js";

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

export class ButtonPressDetector {
  private buttons = new Map<string, ButtonContext>();

  constructor(
    private readonly onPressDetected: (
      deviceAddress: number,
      buttonIndex: number,
      pressType: PressType,
    ) => void,
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
    switch (ctx.state) {
      case "IDLE": {
        this.clearTimers(ctx);
        ctx.state = "PRESSED";
        ctx.longPressTimer = setTimeout(() => {
          ctx.longPressTimer = null;
          ctx.state = "LONG_PRESS_ACTIVE";
          this.onPressDetected(deviceAddress, buttonIndex, "LONG_PRESS");
        }, LONG_PRESS_THRESHOLD_MS);
        break;
      }
      case "WAITING_FOR_DOUBLE": {
        this.clearTimers(ctx);
        ctx.state = "DOUBLE_PRESSED";
        break;
      }
      default:
        // Ignore presses in other states
        break;
    }
  }

  private handleRelease(
    ctx: ButtonContext,
    deviceAddress: number,
    buttonIndex: number,
  ) {
    switch (ctx.state) {
      case "PRESSED": {
        this.clearTimers(ctx);
        ctx.state = "WAITING_FOR_DOUBLE";
        ctx.doublePressTimer = setTimeout(() => {
          ctx.doublePressTimer = null;
          ctx.state = "IDLE";
          this.onPressDetected(deviceAddress, buttonIndex, "SINGLE_PRESS");
        }, DOUBLE_PRESS_WINDOW_MS);
        break;
      }
      case "DOUBLE_PRESSED": {
        this.clearTimers(ctx);
        ctx.state = "IDLE";
        this.onPressDetected(deviceAddress, buttonIndex, "DOUBLE_PRESS");
        break;
      }
      case "LONG_PRESS_ACTIVE": {
        this.clearTimers(ctx);
        ctx.state = "IDLE";
        break;
      }
      default:
        // Ignore releases in other states
        break;
    }
  }
}
