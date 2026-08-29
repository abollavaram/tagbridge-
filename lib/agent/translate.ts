import { DESTINATIONS, SOURCE_FAMILIES, TRANSPORTS } from '@/lib/compatibility/types';
import type { Destination, SourceFamily, Transport } from '@/lib/compatibility/types';

/**
 * Natural language to structured compatibility input.
 *
 * The compatibility resolver takes an exact enum; buyers write "we've got
 * ControlLogix PLCs and want the data in our historian". Something has to
 * bridge those, and doing it here rather than in the prompt has one decisive
 * advantage: the translation is testable. A model asked to fill the struct
 * gets it right most of the time and is wrong in ways nobody can enumerate;
 * this is wrong in ways that show up as a failing test.
 *
 * When it cannot tell, it says so. A missing field is returned as missing, and
 * the agent asks — which is the correct behaviour for a resolver whose output
 * a buyer is going to spend money on.
 */

export interface TranslatedCompatibility {
  sourceDevice?: SourceFamily;
  destinationSystem?: Destination;
  transport?: Transport;
  tagCount?: number;
  redundancyRequired: boolean;
  intermittentLink: boolean;
  legacyFirmware: boolean;
  /** Fields that could not be determined, named for the follow-up question. */
  missing: string[];
  /** What matched, so a wrong answer is debuggable. */
  signals: string[];
}

/** Phrases that identify a source family. Longest match wins. */
const SOURCE_PHRASES: [string, SourceFamily][] = [
  ['controllogix', 'allen-bradley'],
  ['compactlogix', 'allen-bradley'],
  ['micrologix', 'allen-bradley'],
  ['slc 500', 'allen-bradley'],
  ['plc-5', 'allen-bradley'],
  ['allen-bradley', 'allen-bradley'],
  ['allen bradley', 'allen-bradley'],
  ['rockwell', 'allen-bradley'],
  ['ethernet/ip', 'allen-bradley'],
  ['simatic', 'siemens'],
  ['s7-1500', 'siemens'],
  ['s7-1200', 'siemens'],
  ['s7-300', 'siemens'],
  ['s7-400', 'siemens'],
  ['siemens', 'siemens'],
  ['profinet', 'siemens'],
  ['modicon', 'modicon'],
  ['schneider', 'modicon'],
  ['quantum', 'modicon'],
  ['mitsubishi', 'mitsubishi'],
  ['melsec', 'mitsubishi'],
  ['cc-link', 'mitsubishi'],
  ['bacnet', 'bacnet'],
  ['building automation', 'bacnet'],
  ['dnp3', 'dnp3-rtu'],
  ['rtu', 'dnp3-rtu'],
  ['iec 61850', 'iec61850-ied'],
  ['iec61850', 'iec61850-ied'],
  ['substation', 'iec61850-ied'],
  ['serial ascii', 'serial-ascii'],
  ['weigh scale', 'serial-ascii'],
  ['barcode', 'serial-ascii'],
  ['opc da', 'opc-da-server'],
  ['opc-da', 'opc-da-server'],
  ['classic opc', 'opc-da-server'],
  ['opc ua server', 'opc-ua-server'],
  ['opc-ua server', 'opc-ua-server'],
];

const DESTINATION_PHRASES: [string, Destination][] = [
  ['sql server', 'sql-server'],
  ['sqlserver', 'sql-server'],
  ['mssql', 'sql-server'],
  ['azure sql', 'sql-server'],
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
  ['timescale', 'postgresql'],
  ['influx', 'influxdb'],
  ['snowflake', 'snowflake'],
  ['data warehouse', 'snowflake'],
  ['data lake', 'snowflake'],
  ['sparkplug', 'sparkplug-host'],
  ['mqtt', 'mqtt-broker'],
  ['iot hub', 'mqtt-broker'],
  ['iot core', 'mqtt-broker'],
  ['opc ua client', 'opc-ua-client'],
  ['scada', 'scada-hmi'],
  ['hmi', 'scada-hmi'],
  ['ignition', 'scada-hmi'],
  ['historian', 'influxdb'],
  ['csv', 'file'],
  ['flat file', 'file'],
];

const TRANSPORT_PHRASES: [string, Transport][] = [
  ['ethernet/ip', 'ethernet-ip'],
  ['ethernet ip', 'ethernet-ip'],
  ['s7comm', 's7comm'],
  ['modbus tcp', 'modbus-tcp'],
  ['modbus/tcp', 'modbus-tcp'],
  ['modbus rtu', 'modbus-rtu'],
  ['modbus', 'modbus-tcp'],
  ['profinet', 'profinet'],
  ['bacnet/ip', 'bacnet-ip'],
  ['bacnet ip', 'bacnet-ip'],
  ['mstp', 'bacnet-mstp'],
  ['dnp3', 'dnp3'],
  ['iec 61850', 'iec-61850'],
  ['cc-link', 'cc-link-ie'],
  ['opc ua', 'opc-ua'],
  ['opc-ua', 'opc-ua'],
  ['opc da', 'opc-da'],
];

const REDUNDANCY = ['redundan', 'failover', 'hot standby', 'high availability', 'ha pair'];
const INTERMITTENT = ['intermittent', 'flaky', 'drops out', 'unreliable link', 'satellite', 'cellular'];
const LEGACY = ['legacy firmware', 'old firmware', 'pre-opc', 'no opc ua', 'firmware is old', 'plc-5', 'slc 500'];

function firstPhrase<T>(text: string, table: [string, T][]): { value: T; phrase: string } | null {
  // Longest phrase first, so "opc ua server" is not swallowed by "opc ua".
  const sorted = [...table].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, value] of sorted) {
    if (text.includes(phrase)) return { value, phrase };
  }
  return null;
}

/**
 * Reads a tag count.
 *
 * Handles "5k tags" and "12,000 points" as well as a bare number, and requires
 * the number to be near a tag-ish word — otherwise "Modbus TCP port 502"
 * quietly becomes a 502-tag licence.
 */
export function extractTagCount(text: string): number | null {
  const pattern =
    /(\d[\d,]*)\s*(k\b|thousand\b)?\s*(?:\+\s*)?(tags?|points?|signals?|registers?|items?)/i;
  const match = pattern.exec(text);
  if (!match) return null;
  const digits = Number((match[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(digits) || digits <= 0) return null;
  const multiplier = match[2] ? 1000 : 1;
  const total = digits * multiplier;
  return total > 0 && total <= 1_000_000 ? total : null;
}

export function translateCompatibility(request: string): TranslatedCompatibility {
  const text = request.toLowerCase();
  const signals: string[] = [];

  let source = firstPhrase(text, SOURCE_PHRASES);
  const destination = firstPhrase(text, DESTINATION_PHRASES);
  const transport = firstPhrase(text, TRANSPORT_PHRASES);
  const tagCount = extractTagCount(text);

  // A buyer who says "something that speaks Modbus TCP" has named a protocol
  // but not a vendor, which is a perfectly ordinary way to ask and is what the
  // `other` family is for. Inferring it is honest — the transport still
  // carries the information the resolver actually needs — and the signal says
  // it was inferred so a surprising bundle is traceable to this line.
  if (!source && transport) {
    source = { value: 'other', phrase: `${transport.phrase} (no vendor named)` };
  }

  if (source) signals.push(`source "${source.phrase}" -> ${source.value}`);
  if (destination) signals.push(`destination "${destination.phrase}" -> ${destination.value}`);
  if (transport) signals.push(`transport "${transport.phrase}" -> ${transport.value}`);
  if (tagCount) signals.push(`tag count ${tagCount}`);

  const missing: string[] = [];
  if (!source) missing.push('sourceDevice');
  if (!destination) missing.push('destinationSystem');
  if (!tagCount) missing.push('tagCount');

  return {
    sourceDevice: source?.value,
    destinationSystem: destination?.value,
    transport: transport?.value,
    tagCount: tagCount ?? undefined,
    redundancyRequired: REDUNDANCY.some((p) => text.includes(p)),
    intermittentLink: INTERMITTENT.some((p) => text.includes(p)),
    legacyFirmware: LEGACY.some((p) => text.includes(p)),
    missing,
    signals,
  };
}

/** Whether the translation is complete enough to call the resolver. */
export function isResolvable(
  t: TranslatedCompatibility,
): t is TranslatedCompatibility & {
  sourceDevice: SourceFamily;
  destinationSystem: Destination;
  tagCount: number;
} {
  return t.missing.length === 0;
}

export const KNOWN_SOURCES = SOURCE_FAMILIES;
export const KNOWN_DESTINATIONS = DESTINATIONS;
export const KNOWN_TRANSPORTS = TRANSPORTS;
