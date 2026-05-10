declare module "pino-roll" {
  import type { SonicBoom } from "sonic-boom";

  /** Subset of pino-roll options we use. */
  export interface PinoRollOptions {
    file: string;
    size?: string | number;
    frequency?: "daily" | "hourly" | number;
    dateFormat?: string;
    limit?: { count?: number; size?: string | number };
    mkdir?: boolean;
    extension?: string;
  }

  export default function roll(opts: PinoRollOptions): Promise<SonicBoom>;
}
