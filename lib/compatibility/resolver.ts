import {
  compatibilityRequestSchema,
  type BundleItem,
  type CompatibilityRequest,
  type CompatibilityResult,
  type Destination,
  type Gap,
  type SourceFamily,
  type Transport,
} from './types';

/**
 * The compatibility resolver.
 *
 * A deterministic rule engine, by design and not by expedience. The model's
 * only job — from phase 3, when a key exists — is turning a sentence into a
 * `CompatibilityRequest`. It never decides what is compatible with what,
 * because a wrong answer here means a buyer orders the wrong thing, and
 * "the model said so" is not something anyone can debug six weeks later.
 *
 * Every rule that fires is recorded in `rulesApplied`, so a surprising bundle
 * can be traced to the line that produced it.
 */

/** What connects to each controller family, and over what. */
const SOURCE_CONNECTIVITY: Record<
  SourceFamily,
  { sku: string; transports: Transport[]; label: string } | null
> = {
  'allen-bradley': {
    sku: 'TB-OPCUA-4100',
    transports: ['ethernet-ip', 'opc-ua'],
    label: 'ControlLogix, CompactLogix and MicroLogix over EtherNet/IP',
  },
  siemens: {
    sku: 'TB-OPCUA-4200',
    transports: ['s7comm', 'opc-ua'],
    label: 'S7-300 through S7-1500 over ISO-on-TCP',
  },
  modicon: {
    sku: 'TB-OPCUA-4300',
    transports: ['modbus-tcp', 'modbus-rtu', 'opc-ua'],
    label: 'Modbus TCP, RTU and ASCII devices',
  },
  mitsubishi: {
    sku: 'TB-GW-5900',
    transports: ['cc-link-ie', 'opc-ua'],
    label: 'CC-Link IE Field networks',
  },
  bacnet: {
    sku: 'TB-OPCUA-4600',
    transports: ['bacnet-ip', 'bacnet-mstp', 'opc-ua'],
    label: 'BACnet/IP and MS/TP building controllers',
  },
  'dnp3-rtu': {
    sku: 'TB-OPCUA-4700',
    transports: ['dnp3', 'opc-ua'],
    label: 'DNP3 outstations',
  },
  'iec61850-ied': {
    sku: 'TB-GW-5800',
    transports: ['iec-61850', 'opc-ua'],
    label: 'IEC 61850 MMS from substation IEDs',
  },
  'serial-ascii': {
    sku: 'TB-GW-5700',
    transports: ['serial-ascii', 'ethernet-ip'],
    label: 'ASCII serial instruments',
  },
  'opc-da-server': {
    sku: 'TB-OPCDA-4400',
    transports: ['opc-da', 'opc-ua'],
    label: 'an existing OPC DA server, without DCOM crossing a firewall',
  },
  'opc-ua-server': {
    sku: 'TB-OPCUA-4500',
    transports: ['opc-ua'],
    label: 'existing OPC UA servers, aggregated into one namespace',
  },
  other: null,
};

/** What writes to each destination. */
const DESTINATION_CONNECTOR: Record<Destination, { sku: string; label: string } | null> = {
  'sql-server': { sku: 'TB-HIST-6100', label: 'SQL Server' },
  postgresql: { sku: 'TB-HIST-6200', label: 'PostgreSQL or TimescaleDB' },
  influxdb: { sku: 'TB-HIST-6300', label: 'InfluxDB' },
  snowflake: { sku: 'TB-HIST-6400', label: 'Snowflake' },
  'mqtt-broker': { sku: 'TB-MQTT-7200', label: 'an MQTT broker on plain topics' },
  'sparkplug-host': { sku: 'TB-MQTT-7100', label: 'a Sparkplug B namespace' },
  'opc-ua-client': null,
  'scada-hmi': { sku: 'TB-HMI-8100', label: 'HMI and SCADA clients' },
  file: { sku: 'TB-HIST-6600', label: 'local files' },
};

/** Redundancy differs by what is being made redundant. */
const REDUNDANCY_BY_SOURCE: Partial<Record<SourceFamily, string>> = {
  modicon: 'TB-RED-9200',
};

export const TIER_BOUNDARIES = { small: 500, medium: 5000 } as const;

export function licenseTierFor(tagCount: number): 'small' | 'medium' | 'large' {
  if (tagCount <= TIER_BOUNDARIES.small) return 'small';
  if (tagCount <= TIER_BOUNDARIES.medium) return 'medium';
  return 'large';
}

export class CompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompatibilityError';
  }
}

/**
 * Resolves a structured request into a bundle, a tier and the gaps.
 *
 * Pure: same input, same output, no database and no network. That is what
 * makes it testable and what makes the answer defensible.
 */
export function resolveCompatibility(input: unknown): CompatibilityResult {
  const parsed = compatibilityRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new CompatibilityError(
      `invalid compatibility request: ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    );
  }
  const request: CompatibilityRequest = parsed.data;

  const bundle: BundleItem[] = [];
  const gaps: Gap[] = [];
  const rulesApplied: string[] = [];

  const add = (item: BundleItem): void => {
    if (bundle.some((b) => b.sku === item.sku)) return;
    bundle.push(item);
  };

  /* ------------------------------------------------ source connectivity */

  const source = SOURCE_CONNECTIVITY[request.sourceDevice];
  if (!source) {
    rulesApplied.push('source:unknown-family');
    gaps.push({
      code: 'unknown-source-device',
      severity: 'blocking',
      message:
        'The source device family is not one we have a tested driver for, so no bundle can be confirmed.',
      remedy:
        'Tell us the make and protocol and we will confirm against the driver list, or use the universal gateway (TB-GW-6000) if the device speaks a protocol it already carries.',
    });
  } else {
    rulesApplied.push(`source:${request.sourceDevice}`);
    add({
      sku: source.sku,
      role: 'source-connectivity',
      reason: `Reads ${source.label}.`,
    });
  }

  /* ------------------------------------------------------- transport fit */

  if (request.transport && source && !source.transports.includes(request.transport)) {
    rulesApplied.push(`transport:mismatch:${request.transport}`);
    const bridge = bridgeFor(request.transport);
    if (bridge) {
      add({
        sku: bridge,
        role: 'protocol-bridge',
        reason: `The named transport is not native to that driver, so a bridge carries it.`,
      });
      gaps.push({
        code: 'transport-needs-bridge',
        severity: 'advisory',
        message: `The source driver does not speak ${request.transport} natively.`,
        remedy: `Included ${bridge} to bridge it. Confirm the device's addressing before ordering.`,
      });
    } else {
      gaps.push({
        code: 'transport-unsupported',
        severity: 'blocking',
        message: `Nothing in the catalogue bridges ${request.transport} to that source family.`,
        remedy: 'Tell us the device model and we will confirm whether a driver exists.',
      });
    }
  }

  /* ------------------------------------------------------ legacy firmware */

  if (request.legacyFirmware) {
    rulesApplied.push('firmware:legacy');
    gaps.push({
      code: 'firmware-predates-opc-ua',
      severity: 'advisory',
      message:
        'Controller firmware that predates OPC UA cannot serve it directly, whatever the client supports.',
      remedy:
        'The bundle already routes through a server rather than expecting the controller to speak OPC UA. No firmware upgrade is required.',
    });
    if (request.sourceDevice === 'opc-da-server') {
      add({
        sku: 'TB-OPCDA-4400',
        role: 'protocol-bridge',
        reason: 'Presents the legacy DA server to modern OPC UA clients.',
      });
    }
  }

  /* --------------------------------------------------------- destination */

  const destination = DESTINATION_CONNECTOR[request.destinationSystem];
  if (destination) {
    rulesApplied.push(`destination:${request.destinationSystem}`);
    add({
      sku: destination.sku,
      role: 'destination-connector',
      reason: `Writes to ${destination.label}.`,
    });
  } else {
    // An OPC UA client needs no connector: the server already is the endpoint.
    rulesApplied.push('destination:native-opc-ua');
  }

  if (request.destinationSystem === 'sparkplug-host') {
    add({
      sku: 'TB-MQTT-7300',
      role: 'destination-connector',
      reason:
        'Tracks edge node state and issues rebirths, so a consumer does not have to reimplement the specification.',
    });
  }

  /* ------------------------------------------------------------ capacity */

  const licenseTier = licenseTierFor(request.tagCount);
  rulesApplied.push(`capacity:${licenseTier}`);

  if (request.tagCount > 5000 && request.destinationSystem !== 'file') {
    gaps.push({
      code: 'high-tag-count',
      severity: 'advisory',
      message: `At ${request.tagCount.toLocaleString('en-US')} tags the scan rate, not the licence, is usually the constraint.`,
      remedy:
        'Add TB-DIAG-9900 to measure the traffic a proposed poll rate generates before commissioning rather than during it.',
    });
    add({
      sku: 'TB-DIAG-9900',
      role: 'tooling',
      reason: 'Reports the network load a polling configuration will generate, before deployment.',
    });
  }

  /* ---------------------------------------------------------- redundancy */

  if (request.redundancyRequired) {
    const redundancySku = REDUNDANCY_BY_SOURCE[request.sourceDevice] ?? 'TB-RED-9100';
    rulesApplied.push(`redundancy:${redundancySku}`);
    add({
      sku: redundancySku,
      role: 'redundancy',
      reason: 'Runs a hot standby and fails over on a health rule rather than a bare timeout.',
    });
    add({
      sku: 'TB-RED-9500',
      role: 'redundancy',
      reason:
        'Keeps configuration identical across the pair. Drift between the two is how a failover discovers it was never going to work.',
    });
  }

  /* ----------------------------------------------------- link reliability */

  if (request.intermittentLink) {
    rulesApplied.push('link:intermittent');
    const buffer = request.destinationSystem === 'sparkplug-host'
      || request.destinationSystem === 'mqtt-broker'
      ? 'TB-MQTT-7500'
      : 'TB-RED-9300';
    add({
      sku: buffer,
      role: 'buffering',
      reason:
        'Holds data locally while the link is down and replays it in order once it returns.',
    });
    gaps.push({
      code: 'buffer-sizing-unknown',
      severity: 'advisory',
      message:
        'Buffer depth is sized by how long the link can be down, which we cannot infer from the tag count.',
      remedy: 'Tell us the longest outage to survive and we will size it in hours rather than bytes.',
    });
  }

  const supported = !gaps.some((g) => g.severity === 'blocking');

  return {
    bundle,
    licenseTier,
    tagCount: request.tagCount,
    gaps,
    supported,
    rulesApplied,
  };
}

/** The gateway that carries a transport a source driver does not speak. */
function bridgeFor(transport: Transport): string | null {
  switch (transport) {
    case 'modbus-tcp':
    case 'modbus-rtu':
      return 'TB-GW-5400';
    case 'ethernet-ip':
      return 'TB-GW-5100';
    case 's7comm':
      return 'TB-GW-5300';
    case 'profinet':
      return 'TB-GW-5500';
    case 'bacnet-ip':
    case 'bacnet-mstp':
      return 'TB-GW-5600';
    case 'serial-ascii':
      return 'TB-GW-5700';
    case 'iec-61850':
      return 'TB-GW-5800';
    case 'cc-link-ie':
      return 'TB-GW-5900';
    case 'dnp3':
    case 'opc-ua':
    case 'opc-da':
      return null;
  }
}
