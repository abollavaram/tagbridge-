import { z } from 'zod';

/**
 * The compatibility resolver's contract.
 *
 * Industrial buying is not add-to-cart, it is "will this work with what I
 * already have". The answer is a bundle, a licence tier, and — the part that
 * actually earns trust — the gaps: the things that will stop this working
 * which the buyer has not thought about yet.
 *
 * The schema is strict and carries no price field. From phase 3 the model is
 * allowed to fill this in from a sentence, and nothing else.
 */

export const SOURCE_FAMILIES = [
  'allen-bradley',
  'siemens',
  'modicon',
  'mitsubishi',
  'bacnet',
  'dnp3-rtu',
  'iec61850-ied',
  'serial-ascii',
  'opc-da-server',
  'opc-ua-server',
  'other',
] as const;

export const DESTINATIONS = [
  'sql-server',
  'postgresql',
  'influxdb',
  'snowflake',
  'mqtt-broker',
  'sparkplug-host',
  'opc-ua-client',
  'scada-hmi',
  'file',
] as const;

export const TRANSPORTS = [
  'ethernet-ip',
  's7comm',
  'modbus-tcp',
  'modbus-rtu',
  'profinet',
  'bacnet-ip',
  'bacnet-mstp',
  'dnp3',
  'iec-61850',
  'cc-link-ie',
  'opc-ua',
  'opc-da',
  'serial-ascii',
] as const;

export type SourceFamily = (typeof SOURCE_FAMILIES)[number];
export type Destination = (typeof DESTINATIONS)[number];
export type Transport = (typeof TRANSPORTS)[number];

export const MAX_TAG_COUNT = 1_000_000;

export const compatibilityRequestSchema = z
  .object({
    sourceDevice: z.enum(SOURCE_FAMILIES),
    destinationSystem: z.enum(DESTINATIONS),
    transport: z.enum(TRANSPORTS).optional(),
    tagCount: z.number().int().min(1).max(MAX_TAG_COUNT),
    redundancyRequired: z.boolean().default(false),
    /** Site link drops or is intermittent — changes the buffering answer. */
    intermittentLink: z.boolean().default(false),
    /** Controller firmware predates OPC UA, a very common real blocker. */
    legacyFirmware: z.boolean().default(false),
  })
  .strict();

export type CompatibilityRequest = z.infer<typeof compatibilityRequestSchema>;

/** Why a product is in the bundle. Order is the order it is presented. */
export type BundleRole =
  | 'source-connectivity'
  | 'protocol-bridge'
  | 'destination-connector'
  | 'redundancy'
  | 'buffering'
  | 'tooling';

export interface BundleItem {
  sku: string;
  role: BundleRole;
  /** Written for the buyer, not for a log. */
  reason: string;
}

export type GapSeverity = 'blocking' | 'advisory';

export interface Gap {
  code: string;
  severity: GapSeverity;
  message: string;
  /** What to do about it. Never empty — a gap without a remedy is a shrug. */
  remedy: string;
}

export interface CompatibilityResult {
  bundle: BundleItem[];
  /** Which capacity tier the tag count lands in. */
  licenseTier: 'small' | 'medium' | 'large';
  tagCount: number;
  gaps: Gap[];
  /** True when nothing blocking stands in the way. */
  supported: boolean;
  /** The rules that fired, in order, so a surprising answer is traceable. */
  rulesApplied: string[];
}
