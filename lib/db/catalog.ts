/**
 * TagBridge catalog seed data.
 *
 * Every product, description and part number here is written for this project.
 * The protocol and device vocabulary (OPC UA, Modbus TCP, EtherNet/IP,
 * ControlLogix, Sparkplug B, BACnet/IP, DNP3, S7) is public technical fact and
 * is used deliberately — it is what makes the search evaluation meaningful.
 */

export type LicenseType = 'perpetual' | 'subscription';
export type BillingInterval = 'none' | 'monthly' | 'annual';

export interface SeedTier {
  minQty: number;
  unitPriceCents: number;
}

export interface SeedVariant {
  sku: string;
  tier: string;
  tagCapacity: number | null;
  listPriceCents: number;
  billingInterval: BillingInterval;
  tiers: SeedTier[];
}

export interface SeedProduct {
  sku: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  protocols: string[];
  vendorCompat: string[];
  licenseType: LicenseType;
  specs: Record<string, string | number | boolean>;
  variants: SeedVariant[];
}

export const CATEGORIES = [
  'OPC Servers',
  'Protocol Gateways',
  'Historian Connectors',
  'MQTT & Sparkplug',
  'HMI & SCADA Middleware',
  'Redundancy & Availability',
  'Diagnostics & Tooling',
] as const;

/** Standard three-step volume break applied to a variant's list price. */
function volumeTiers(listPriceCents: number): SeedTier[] {
  return [
    { minQty: 1, unitPriceCents: listPriceCents },
    { minQty: 5, unitPriceCents: Math.round(listPriceCents * 0.9) },
    { minQty: 10, unitPriceCents: Math.round(listPriceCents * 0.82) },
    { minQty: 25, unitPriceCents: Math.round(listPriceCents * 0.75) },
  ];
}

interface VariantSpec {
  suffix: string;
  tier: string;
  tagCapacity: number | null;
  listPriceCents: number;
  billingInterval?: BillingInterval;
}

function variants(baseSku: string, specs: VariantSpec[]): SeedVariant[] {
  return specs.map((s) => ({
    sku: `${baseSku}-${s.suffix}`,
    tier: s.tier,
    tagCapacity: s.tagCapacity,
    listPriceCents: s.listPriceCents,
    billingInterval: s.billingInterval ?? 'none',
    tiers: volumeTiers(s.listPriceCents),
  }));
}

/** Capacity ladder used by most tag-metered products. */
function capacityLadder(
  baseSku: string,
  small: number,
  medium: number,
  large: number,
  interval: BillingInterval = 'none',
): SeedVariant[] {
  return variants(baseSku, [
    { suffix: 'S', tier: '500 tags', tagCapacity: 500, listPriceCents: small, billingInterval: interval },
    { suffix: 'M', tier: '5,000 tags', tagCapacity: 5000, listPriceCents: medium, billingInterval: interval },
    { suffix: 'L', tier: 'Unlimited tags', tagCapacity: null, listPriceCents: large, billingInterval: interval },
  ]);
}

/** Two-step ladder for products licensed per connection rather than per tag. */
function seatLadder(
  baseSku: string,
  standard: number,
  enterprise: number,
  interval: BillingInterval = 'none',
): SeedVariant[] {
  return variants(baseSku, [
    { suffix: 'STD', tier: 'Standard', tagCapacity: null, listPriceCents: standard, billingInterval: interval },
    { suffix: 'ENT', tier: 'Enterprise', tagCapacity: null, listPriceCents: enterprise, billingInterval: interval },
  ]);
}

export const SEED_PRODUCTS: SeedProduct[] = [
  /* ------------------------------------------------------- OPC Servers */
  {
    sku: 'TB-OPCUA-4100',
    name: 'Meridian OPC UA Server for Allen-Bradley',
    slug: 'meridian-opc-ua-server-allen-bradley',
    category: 'OPC Servers',
    description:
      'An OPC UA server that reads and writes tags in ControlLogix, CompactLogix and MicroLogix controllers over EtherNet/IP, without an intermediate DDE or DA layer. Tags can be browsed straight from the controller program, imported from an L5X export, or defined by hand when the program is not available. Subscriptions are grouped per controller so a slow rack cannot stall the rest of the address space.',
    protocols: ['OPC UA', 'EtherNet/IP', 'CIP'],
    vendorCompat: ['Allen-Bradley', 'Rockwell Automation', 'ControlLogix', 'CompactLogix', 'MicroLogix'],
    licenseType: 'perpetual',
    specs: { transport: 'TCP/IP', security: 'Basic256Sha256', maxSessions: 64, redundancyReady: true },
    variants: capacityLadder('TB-OPCUA-4100', 189000, 429000, 899000),
  },
  {
    sku: 'TB-OPCUA-4200',
    name: 'Meridian OPC UA Server for Siemens S7',
    slug: 'meridian-opc-ua-server-siemens-s7',
    category: 'OPC Servers',
    description:
      'Connects SIMATIC S7-300, S7-400, S7-1200 and S7-1500 controllers to any OPC UA client over ISO-on-TCP. Optimised block reads pack scattered DB addresses into as few PDUs as the controller will accept, which is usually the difference between a one-second and a five-second scan on a loaded CPU. Absolute and symbolic addressing are both supported.',
    protocols: ['OPC UA', 'S7comm', 'ISO-on-TCP'],
    vendorCompat: ['Siemens', 'SIMATIC', 'S7-300', 'S7-400', 'S7-1200', 'S7-1500'],
    licenseType: 'perpetual',
    specs: { transport: 'TCP/IP', optimisedBlockReads: true, maxSessions: 64, symbolicAddressing: true },
    variants: capacityLadder('TB-OPCUA-4200', 189000, 429000, 899000),
  },
  {
    sku: 'TB-OPCUA-4300',
    name: 'Meridian OPC UA Server for Modbus',
    slug: 'meridian-opc-ua-server-modbus',
    category: 'OPC Servers',
    description:
      'Presents Modbus TCP, RTU and ASCII devices as a single OPC UA address space. Register maps are described once in a device profile and reused across every unit of that model, so adding the fortieth flow meter is a row in a table rather than a new configuration. Handles the byte and word order disagreements that make 32-bit floats read as nonsense on mixed fleets.',
    protocols: ['OPC UA', 'Modbus TCP', 'Modbus RTU', 'Modbus ASCII'],
    vendorCompat: ['Schneider Electric', 'Modicon', 'generic Modbus'],
    licenseType: 'perpetual',
    specs: { serialSupport: true, wordOrderOverride: true, maxDevices: 512, deviceProfiles: true },
    variants: capacityLadder('TB-OPCUA-4300', 149000, 349000, 749000),
  },
  {
    sku: 'TB-OPCDA-4400',
    name: 'Meridian OPC Classic Bridge',
    slug: 'meridian-opc-classic-bridge',
    category: 'OPC Servers',
    description:
      'Puts an OPC UA face on an OPC DA server that cannot be replaced yet, and the reverse for clients that were never updated. DCOM stays confined to one machine instead of crossing a firewall, which removes the usual reason these projects stall. Item quality and timestamps are carried through both directions rather than regenerated at the bridge.',
    protocols: ['OPC UA', 'OPC DA', 'OPC Classic', 'DCOM'],
    vendorCompat: ['generic OPC DA', 'legacy SCADA'],
    licenseType: 'perpetual',
    specs: { direction: 'bidirectional', qualityPassthrough: true, dcomIsolation: true },
    variants: capacityLadder('TB-OPCDA-4400', 129000, 289000, 619000),
  },
  {
    sku: 'TB-OPCUA-4500',
    name: 'Meridian OPC UA Aggregation Server',
    slug: 'meridian-opc-ua-aggregation-server',
    category: 'OPC Servers',
    description:
      'Collapses many upstream OPC UA and DA servers into one namespace so a client connects once instead of thirty times. Namespace collisions are resolved by a configurable prefix rule, and a server that goes offline is reported as bad quality on its own branch rather than taking down the session. Useful when a site has grown one server per line over a decade.',
    protocols: ['OPC UA', 'OPC DA'],
    vendorCompat: ['generic OPC UA', 'generic OPC DA'],
    licenseType: 'perpetual',
    specs: { maxUpstreamServers: 64, namespacePrefixing: true, partialFailureIsolation: true },
    variants: capacityLadder('TB-OPCUA-4500', 219000, 489000, 989000),
  },
  {
    sku: 'TB-OPCUA-4600',
    name: 'Meridian OPC UA Server for BACnet',
    slug: 'meridian-opc-ua-server-bacnet',
    category: 'OPC Servers',
    description:
      'Exposes BACnet/IP and MS/TP building controllers to plant-floor OPC UA clients, so chiller and air handler data lands in the same historian as process data. Device and object discovery runs on a schedule and reports what changed, which matters on building networks where controllers are added without notice. Present values, priority arrays and reliability flags are all mapped.',
    protocols: ['OPC UA', 'BACnet/IP', 'BACnet MS/TP'],
    vendorCompat: ['generic BACnet', 'building automation'],
    licenseType: 'perpetual',
    specs: { discovery: 'scheduled', priorityArraySupport: true, maxDevices: 256 },
    variants: capacityLadder('TB-OPCUA-4600', 159000, 359000, 769000),
  },
  {
    sku: 'TB-OPCUA-4700',
    name: 'Meridian OPC UA Server for DNP3',
    slug: 'meridian-opc-ua-server-dnp3',
    category: 'OPC Servers',
    description:
      'A DNP3 master that publishes outstation points as OPC UA nodes, built for water, wastewater and electrical distribution sites where the link is slow and occasionally absent. Unsolicited responses, class polling and time synchronisation follow the DNP3 rules rather than being approximated, and event buffers survive a link outage so nothing is silently lost.',
    protocols: ['OPC UA', 'DNP3'],
    vendorCompat: ['generic DNP3', 'RTU', 'utility SCADA'],
    licenseType: 'perpetual',
    specs: { role: 'master', unsolicitedResponses: true, eventBuffering: true, serialAndTcp: true },
    variants: capacityLadder('TB-OPCUA-4700', 179000, 399000, 829000),
  },
  {
    sku: 'TB-OPCUA-4800',
    name: 'Meridian OPC UA Server SDK',
    slug: 'meridian-opc-ua-server-sdk',
    category: 'OPC Servers',
    description:
      'A .NET and C library for teams that need to expose their own device or database as an OPC UA server. Handles the parts that are tedious and easy to get wrong — session management, certificate handling, subscription lifecycle, chunked reads — and leaves the address space to you. Ships with a working reference server and its source.',
    protocols: ['OPC UA'],
    vendorCompat: ['custom hardware', 'in-house applications'],
    licenseType: 'perpetual',
    specs: { languages: '.NET, C', royaltyFree: false, referenceServerIncluded: true },
    variants: variants('TB-OPCUA-4800', [
      { suffix: 'DEV', tier: 'Single developer', tagCapacity: null, listPriceCents: 549000 },
      { suffix: 'TEAM', tier: 'Five developers', tagCapacity: null, listPriceCents: 1899000 },
      { suffix: 'DIST', tier: 'Redistribution', tagCapacity: null, listPriceCents: 4900000 },
    ]),
  },

  /* -------------------------------------------------- Protocol Gateways */
  {
    sku: 'TB-GW-5100',
    name: 'Crosslink Gateway — EtherNet/IP to Modbus TCP',
    slug: 'crosslink-gateway-ethernet-ip-to-modbus-tcp',
    category: 'Protocol Gateways',
    description:
      'Moves data between a Rockwell controller and Modbus TCP equipment without either side knowing the other exists. Mapping is defined as explicit tag-to-register pairs with a stated update rate, so the traffic a mapping generates is visible before it is deployed. Write mappings can be made one-way to keep a third-party device from touching controller state.',
    protocols: ['EtherNet/IP', 'CIP', 'Modbus TCP'],
    vendorCompat: ['Allen-Bradley', 'Rockwell Automation', 'ControlLogix', 'Modicon'],
    licenseType: 'perpetual',
    specs: { direction: 'bidirectional', maxMappings: 10000, writeGuard: true },
    variants: capacityLadder('TB-GW-5100', 119000, 279000, 599000),
  },
  {
    sku: 'TB-GW-5200',
    name: 'Crosslink Gateway — Modbus RTU Serial Bridge',
    slug: 'crosslink-gateway-modbus-rtu-serial-bridge',
    category: 'Protocol Gateways',
    description:
      'Brings RS-485 Modbus RTU and ASCII devices onto an Ethernet network as Modbus TCP, including the multidrop chains that end up on one port. Per-slave timeout, inter-frame delay and retry counts are set individually, which is what it takes when a single slow device on a chain otherwise sets the pace for everything behind it. Serial line diagnostics are logged per unit ID.',
    protocols: ['Modbus RTU', 'Modbus ASCII', 'Modbus TCP', 'RS-485'],
    vendorCompat: ['generic Modbus', 'serial instrumentation'],
    licenseType: 'perpetual',
    specs: { serialPorts: 8, perSlaveTiming: true, maxSlaves: 247 },
    variants: capacityLadder('TB-GW-5200', 89000, 209000, 449000),
  },
  {
    sku: 'TB-GW-5300',
    name: 'Crosslink Gateway — S7 to EtherNet/IP',
    slug: 'crosslink-gateway-s7-to-ethernet-ip',
    category: 'Protocol Gateways',
    description:
      'Connects Siemens S7 controllers to Allen-Bradley controllers directly, for the plants that ran a Siemens line and a Rockwell line and now need them to hand off product. Data blocks map to controller tags with explicit type conversion, and a heartbeat pair on both sides makes a stalled link obvious to each program rather than leaving stale values in place.',
    protocols: ['S7comm', 'EtherNet/IP', 'CIP', 'ISO-on-TCP'],
    vendorCompat: ['Siemens', 'SIMATIC', 'Allen-Bradley', 'Rockwell Automation', 'ControlLogix'],
    licenseType: 'perpetual',
    specs: { heartbeat: true, typeConversion: 'explicit', maxMappings: 8000 },
    variants: capacityLadder('TB-GW-5300', 139000, 319000, 679000),
  },
  {
    sku: 'TB-GW-5400',
    name: 'Crosslink Gateway — OPC UA to Modbus',
    slug: 'crosslink-gateway-opc-ua-to-modbus',
    category: 'Protocol Gateways',
    description:
      'Lets an OPC UA client drive Modbus devices, and lets a Modbus master read an OPC UA address space as registers. The second direction is the one that gets asked for late in a project, when a packaged skid arrives with a Modbus master and no way to change it. Register windows are assigned explicitly rather than allocated automatically.',
    protocols: ['OPC UA', 'Modbus TCP', 'Modbus RTU'],
    vendorCompat: ['generic OPC UA', 'generic Modbus', 'packaged equipment'],
    licenseType: 'perpetual',
    specs: { direction: 'bidirectional', registerWindows: 'manual', maxMappings: 6000 },
    variants: capacityLadder('TB-GW-5400', 109000, 249000, 529000),
  },
  {
    sku: 'TB-GW-5500',
    name: 'Crosslink Gateway — PROFINET to OPC UA',
    slug: 'crosslink-gateway-profinet-to-opc-ua',
    category: 'Protocol Gateways',
    description:
      'Reads cyclic PROFINET IO data and publishes it as an OPC UA address space, with the GSDML module structure preserved so a slot and subslot still means something to the person reading the tag. Diagnostic alarms are surfaced as OPC UA events rather than being flattened into a status word.',
    protocols: ['PROFINET', 'OPC UA'],
    vendorCompat: ['Siemens', 'SIMATIC', 'generic PROFINET IO'],
    licenseType: 'perpetual',
    specs: { gsdmlImport: true, alarmsAsEvents: true, maxDevices: 128 },
    variants: capacityLadder('TB-GW-5500', 159000, 369000, 789000),
  },
  {
    sku: 'TB-GW-5600',
    name: 'Crosslink Gateway — BACnet to Modbus',
    slug: 'crosslink-gateway-bacnet-to-modbus',
    category: 'Protocol Gateways',
    description:
      'Sits between a building management system and process equipment that only speaks Modbus, so a chiller plant can be sequenced from the BMS without a separate operator station. BACnet objects are created from a Modbus register map with engineering units carried through, and writes honour the BACnet priority array instead of overwriting it.',
    protocols: ['BACnet/IP', 'BACnet MS/TP', 'Modbus TCP', 'Modbus RTU'],
    vendorCompat: ['building automation', 'generic Modbus'],
    licenseType: 'perpetual',
    specs: { priorityArrayAware: true, engineeringUnits: true, maxObjects: 4000 },
    variants: capacityLadder('TB-GW-5600', 129000, 289000, 619000),
  },
  {
    sku: 'TB-GW-5700',
    name: 'Crosslink Gateway — Serial to EtherNet/IP',
    slug: 'crosslink-gateway-serial-to-ethernet-ip',
    category: 'Protocol Gateways',
    description:
      'Gets ASCII serial devices — scales, barcode scanners, printers, older analysers — into a ControlLogix program as structured tags. Message framing is defined by delimiter, fixed length or timeout, and parsed fields land in a UDT rather than as a string the program has to pick apart. Unparseable frames are counted and kept for inspection instead of being dropped.',
    protocols: ['EtherNet/IP', 'CIP', 'RS-232', 'RS-485', 'ASCII'],
    vendorCompat: ['Allen-Bradley', 'Rockwell Automation', 'ControlLogix', 'serial instrumentation'],
    licenseType: 'perpetual',
    specs: { framing: 'delimiter, fixed, timeout', udtOutput: true, serialPorts: 8 },
    variants: capacityLadder('TB-GW-5700', 99000, 229000, 489000),
  },
  {
    sku: 'TB-GW-5800',
    name: 'Crosslink Gateway — IEC 61850 to OPC UA',
    slug: 'crosslink-gateway-iec-61850-to-opc-ua',
    category: 'Protocol Gateways',
    description:
      'Publishes IEC 61850 MMS data from substation IEDs into an OPC UA address space, keeping the logical node structure so a protection engineer and a process engineer are looking at the same names. SCL files are imported directly. Reports are subscribed rather than polled, which is the only approach that holds up on a busy station bus.',
    protocols: ['IEC 61850', 'MMS', 'OPC UA'],
    vendorCompat: ['substation IEDs', 'utility SCADA'],
    licenseType: 'perpetual',
    specs: { sclImport: true, reportSubscriptions: true, maxIeds: 64 },
    variants: seatLadder('TB-GW-5800', 449000, 1149000),
  },
  {
    sku: 'TB-GW-5900',
    name: 'Crosslink Gateway — CC-Link IE to OPC UA',
    slug: 'crosslink-gateway-cc-link-ie-to-opc-ua',
    category: 'Protocol Gateways',
    description:
      'Brings Mitsubishi CC-Link IE Field networks into OPC UA for sites where a Japanese-built line sits alongside everything else. Cyclic and transient data are both mapped, and the station number to tag naming is defined by the user so the resulting address space matches the plant drawings rather than the network topology.',
    protocols: ['CC-Link IE', 'OPC UA'],
    vendorCompat: ['Mitsubishi Electric', 'MELSEC'],
    licenseType: 'perpetual',
    specs: { cyclicAndTransient: true, userNaming: true, maxStations: 120 },
    variants: capacityLadder('TB-GW-5900', 169000, 389000, 819000),
  },
  {
    sku: 'TB-GW-6000',
    name: 'Crosslink Gateway — Universal Multi-Protocol',
    slug: 'crosslink-gateway-universal-multi-protocol',
    category: 'Protocol Gateways',
    description:
      'One gateway instance running every Crosslink driver at once, for integrators who would rather license a platform than eleven point products. Each protocol pair still has its own mapping set and its own diagnostics, so a fault in one link stays inside that link. Sized by total mapped points across all protocols.',
    protocols: [
      'OPC UA',
      'Modbus TCP',
      'Modbus RTU',
      'EtherNet/IP',
      'CIP',
      'S7comm',
      'PROFINET',
      'BACnet/IP',
      'DNP3',
      'MQTT',
    ],
    vendorCompat: ['Allen-Bradley', 'Siemens', 'Schneider Electric', 'Mitsubishi Electric', 'generic Modbus'],
    licenseType: 'subscription',
    specs: { driversIncluded: 'all', faultIsolation: 'per link', supportTier: 'priority' },
    variants: variants('TB-GW-6000', [
      { suffix: 'M-S', tier: '5,000 points / monthly', tagCapacity: 5000, listPriceCents: 39000, billingInterval: 'monthly' },
      { suffix: 'M-L', tier: 'Unlimited points / monthly', tagCapacity: null, listPriceCents: 89000, billingInterval: 'monthly' },
      { suffix: 'A-S', tier: '5,000 points / annual', tagCapacity: 5000, listPriceCents: 390000, billingInterval: 'annual' },
      { suffix: 'A-L', tier: 'Unlimited points / annual', tagCapacity: null, listPriceCents: 890000, billingInterval: 'annual' },
    ]),
  },

  /* ----------------------------------------------- Historian Connectors */
  {
    sku: 'TB-HIST-6100',
    name: 'Streamline Connector for SQL Server',
    slug: 'streamline-connector-sql-server',
    category: 'Historian Connectors',
    description:
      'Writes tag data from OPC UA, OPC DA or Modbus sources straight into SQL Server on change or on a schedule, into a table shape you define rather than one imposed on you. Store-and-forward holds data locally when the database is unreachable and replays it in order once it returns, which is the failure this product exists for. Batched inserts keep a busy line from generating one round trip per tag.',
    protocols: ['OPC UA', 'OPC DA', 'Modbus TCP', 'ODBC'],
    vendorCompat: ['Microsoft SQL Server', 'Azure SQL', 'Allen-Bradley', 'Siemens'],
    licenseType: 'perpetual',
    specs: { storeAndForward: true, batchInserts: true, schemaControl: 'user-defined', maxWriteRate: '50k rows/min' },
    variants: capacityLadder('TB-HIST-6100', 179000, 399000, 849000),
  },
  {
    sku: 'TB-HIST-6200',
    name: 'Streamline Connector for PostgreSQL and TimescaleDB',
    slug: 'streamline-connector-postgresql-timescaledb',
    category: 'Historian Connectors',
    description:
      'The same store-and-forward pipeline aimed at PostgreSQL, with hypertable creation and chunk sizing handled for TimescaleDB installations. Writes use COPY rather than row-at-a-time inserts, which is what makes a five thousand tag scan class viable on modest hardware. Retention and compression policies can be created from the connector so the database does not need a second owner.',
    protocols: ['OPC UA', 'OPC DA', 'Modbus TCP'],
    vendorCompat: ['PostgreSQL', 'TimescaleDB', 'Allen-Bradley', 'Siemens'],
    licenseType: 'perpetual',
    specs: { storeAndForward: true, copyProtocol: true, hypertableSupport: true },
    variants: capacityLadder('TB-HIST-6200', 159000, 359000, 769000),
  },
  {
    sku: 'TB-HIST-6300',
    name: 'Streamline Connector for InfluxDB',
    slug: 'streamline-connector-influxdb',
    category: 'Historian Connectors',
    description:
      'Maps tags to InfluxDB measurements, fields and tags with an explicit naming rule, so the cardinality of what you are about to write is visible before it is written. Line protocol batches are size- and time-bounded. Includes a dry-run mode that reports the series count a configuration would create.',
    protocols: ['OPC UA', 'MQTT', 'Sparkplug B'],
    vendorCompat: ['InfluxDB', 'Telegraf'],
    licenseType: 'subscription',
    specs: { storeAndForward: true, cardinalityDryRun: true, lineProtocol: true },
    variants: variants('TB-HIST-6300', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: 10000, listPriceCents: 29000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: 10000, listPriceCents: 290000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-HIST-6400',
    name: 'Streamline Connector for Snowflake',
    slug: 'streamline-connector-snowflake',
    category: 'Historian Connectors',
    description:
      'Lands plant data in Snowflake through staged files and Snowpipe rather than a chatty JDBC connection, because a warehouse charges for the shape of the write as much as the volume. Micro-batch interval is configurable against the latency the analytics team actually needs, and a local buffer covers WAN outages.',
    protocols: ['OPC UA', 'MQTT', 'Sparkplug B'],
    vendorCompat: ['Snowflake', 'AWS S3', 'Azure Blob Storage'],
    licenseType: 'subscription',
    specs: { microBatch: true, stagedLoad: true, wanBuffer: '72h' },
    variants: variants('TB-HIST-6400', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 49000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 490000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-HIST-6500',
    name: 'Streamline Historian Replay',
    slug: 'streamline-historian-replay',
    category: 'Historian Connectors',
    description:
      'Backfills a historian from a gap — a failed connector, a rebuilt server, a site that was offline for a week — by replaying buffered or exported data with original timestamps rather than the time of the replay. Duplicate detection is by tag and timestamp so a partially successful first attempt can simply be run again.',
    protocols: ['OPC UA', 'ODBC'],
    vendorCompat: ['Microsoft SQL Server', 'PostgreSQL', 'InfluxDB', 'Snowflake'],
    licenseType: 'perpetual',
    specs: { originalTimestamps: true, duplicateDetection: 'tag+timestamp', idempotentReplay: true },
    variants: seatLadder('TB-HIST-6500', 219000, 549000),
  },
  {
    sku: 'TB-HIST-6600',
    name: 'Streamline Data Logger',
    slug: 'streamline-data-logger',
    category: 'Historian Connectors',
    description:
      'A standalone logger for sites that need a record but do not have a historian, writing to local files with rotation and optional upload. Deadband and rate limits are set per tag so a noisy analogue does not fill a disk. Files are plain CSV or Parquet, readable without this product installed — the point is that the data outlives the tool.',
    protocols: ['OPC UA', 'OPC DA', 'Modbus TCP', 'Modbus RTU'],
    vendorCompat: ['generic OPC UA', 'generic Modbus'],
    licenseType: 'perpetual',
    specs: { formats: 'CSV, Parquet', perTagDeadband: true, rotation: true },
    variants: capacityLadder('TB-HIST-6600', 79000, 189000, 419000),
  },
  {
    sku: 'TB-HIST-6700',
    name: 'Streamline Batch Context Enricher',
    slug: 'streamline-batch-context-enricher',
    category: 'Historian Connectors',
    description:
      'Attaches batch, lot and campaign identifiers to time-series rows as they are written, so a quality question can be answered by a query instead of by lining up two exports by hand. Context comes from controller tags, an ISA-88 style state model, or an ERP lookup, and late-arriving context can be applied retroactively to a bounded window.',
    protocols: ['OPC UA', 'ODBC'],
    vendorCompat: ['Microsoft SQL Server', 'PostgreSQL', 'Allen-Bradley', 'Siemens'],
    licenseType: 'perpetual',
    specs: { contextSources: 'tag, state model, ERP', retroactiveWindow: '24h' },
    variants: capacityLadder('TB-HIST-6700', 199000, 449000, 929000),
  },

  /* ------------------------------------------------- MQTT and Sparkplug */
  {
    sku: 'TB-MQTT-7100',
    name: 'Uplink MQTT Sparkplug B Edge Node',
    slug: 'uplink-mqtt-sparkplug-b-edge-node',
    category: 'MQTT & Sparkplug',
    description:
      'Publishes controller data as a Sparkplug B edge node, with the birth and death certificates, sequence numbers and rebirth handling the specification requires — the parts that are easy to skip and that break a consumer six months later. Devices are grouped so one line can be taken out of service without disturbing the rest of the namespace.',
    protocols: ['MQTT', 'Sparkplug B', 'OPC UA', 'EtherNet/IP', 'Modbus TCP'],
    vendorCompat: ['Allen-Bradley', 'Siemens', 'generic Modbus', 'Ignition', 'HiveMQ'],
    licenseType: 'subscription',
    specs: { sparkplugVersion: 'B', storeAndForward: true, tls: true, maxDevices: 250 },
    variants: variants('TB-MQTT-7100', [
      { suffix: 'M-S', tier: '1,000 tags / monthly', tagCapacity: 1000, listPriceCents: 19000, billingInterval: 'monthly' },
      { suffix: 'M-L', tier: 'Unlimited tags / monthly', tagCapacity: null, listPriceCents: 59000, billingInterval: 'monthly' },
      { suffix: 'A-S', tier: '1,000 tags / annual', tagCapacity: 1000, listPriceCents: 190000, billingInterval: 'annual' },
      { suffix: 'A-L', tier: 'Unlimited tags / annual', tagCapacity: null, listPriceCents: 590000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-MQTT-7200',
    name: 'Uplink MQTT Client for Plain Topics',
    slug: 'uplink-mqtt-client-plain-topics',
    category: 'MQTT & Sparkplug',
    description:
      'For brokers and consumers that are not Sparkplug: publish and subscribe on topics you name, with a JSON or raw payload template per tag group. Topic strings are built from a pattern with substitutions, which keeps a thousand tags from becoming a thousand configuration rows. Last will and retained message behaviour are explicit settings, not assumptions.',
    protocols: ['MQTT', 'OPC UA', 'Modbus TCP'],
    vendorCompat: ['AWS IoT Core', 'Azure IoT Hub', 'Mosquitto', 'HiveMQ'],
    licenseType: 'subscription',
    specs: { payloadTemplates: true, topicPatterns: true, qos: '0,1,2' },
    variants: variants('TB-MQTT-7200', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 15000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 150000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-MQTT-7300',
    name: 'Uplink Sparkplug Primary Host',
    slug: 'uplink-sparkplug-primary-host',
    category: 'MQTT & Sparkplug',
    description:
      'The consuming side of a Sparkplug deployment: tracks edge node state, issues rebirth requests when sequence continuity is lost, and exposes the resulting tag state to OPC UA or a database. Holds the state-of-the-world so a downstream application does not have to reimplement the specification to know whether a value is current.',
    protocols: ['MQTT', 'Sparkplug B', 'OPC UA'],
    vendorCompat: ['Ignition', 'HiveMQ', 'generic Sparkplug edge nodes'],
    licenseType: 'subscription',
    specs: { rebirthHandling: true, stateOfWorld: true, maxEdgeNodes: 500 },
    variants: variants('TB-MQTT-7300', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 35000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 350000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-MQTT-7400',
    name: 'Uplink Broker Bridge',
    slug: 'uplink-broker-bridge',
    category: 'MQTT & Sparkplug',
    description:
      'Forwards selected topics between two MQTT brokers — typically a plant broker and a corporate or cloud one — with a topic allowlist and one-way enforcement at the bridge rather than in broker ACLs alone. Loop detection stops a misconfigured pair from amplifying traffic between them.',
    protocols: ['MQTT', 'Sparkplug B'],
    vendorCompat: ['AWS IoT Core', 'Azure IoT Hub', 'HiveMQ', 'Mosquitto'],
    licenseType: 'subscription',
    specs: { allowlist: true, unidirectionalEnforcement: true, loopDetection: true },
    variants: variants('TB-MQTT-7400', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 25000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 250000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-MQTT-7500',
    name: 'Uplink Edge Buffer Module',
    slug: 'uplink-edge-buffer-module',
    category: 'MQTT & Sparkplug',
    description:
      'A disk-backed buffer for edge nodes on links that drop — cellular, satellite, a plant WAN that reboots nightly. Sizing is by duration rather than bytes, so the question "how long can we be offline" has an answer. On reconnect, backlog is drained at a rate that does not starve live data.',
    protocols: ['MQTT', 'Sparkplug B'],
    vendorCompat: ['cellular gateways', 'remote sites'],
    licenseType: 'perpetual',
    specs: { sizingUnit: 'hours', maxBuffer: '30d', drainRateControl: true },
    variants: seatLadder('TB-MQTT-7500', 89000, 219000),
  },
  {
    sku: 'TB-MQTT-7600',
    name: 'Uplink Payload Transformer',
    slug: 'uplink-payload-transformer',
    category: 'MQTT & Sparkplug',
    description:
      'Reshapes MQTT payloads in flight — rename fields, change units, split one message into several, drop what a consumer must not see. Transforms are declarative and unit tested against sample payloads you supply, so a change is checked before it reaches a broker rather than after.',
    protocols: ['MQTT', 'Sparkplug B'],
    vendorCompat: ['generic MQTT'],
    licenseType: 'subscription',
    specs: { declarativeTransforms: true, sampleTesting: true, redaction: true },
    variants: variants('TB-MQTT-7600', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 19000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 190000, billingInterval: 'annual' },
    ]),
  },

  /* --------------------------------------- HMI and SCADA Middleware */
  {
    sku: 'TB-HMI-8100',
    name: 'Facet Tag Server for HMI Clients',
    slug: 'facet-tag-server-hmi-clients',
    category: 'HMI & SCADA Middleware',
    description:
      'A shared tag cache in front of controllers, so twelve HMI clients opening the same screen produce one read rather than twelve. Update rates are negotiated per client and coalesced at the server. Removes the failure where adding an operator station slowly degrades scan time for everybody.',
    protocols: ['OPC UA', 'OPC DA', 'EtherNet/IP', 'Modbus TCP', 'S7comm'],
    vendorCompat: ['Allen-Bradley', 'Siemens', 'Schneider Electric', 'generic HMI'],
    licenseType: 'perpetual',
    specs: { readCoalescing: true, maxClients: 128, cacheAging: 'per tag' },
    variants: capacityLadder('TB-HMI-8100', 149000, 339000, 719000),
  },
  {
    sku: 'TB-HMI-8200',
    name: 'Facet Alarm Concentrator',
    slug: 'facet-alarm-concentrator',
    category: 'HMI & SCADA Middleware',
    description:
      'Collects alarms from OPC UA A&E and A&C sources, controller alarm blocks and Modbus status words into one stream with consistent priority and area attributes. Chattering alarms are suppressed on a configurable rule with the suppression itself logged, so an alarm rationalisation review can see what was hidden and why.',
    protocols: ['OPC UA A&C', 'OPC A&E', 'EtherNet/IP', 'Modbus TCP'],
    vendorCompat: ['Allen-Bradley', 'Siemens', 'generic SCADA'],
    licenseType: 'perpetual',
    specs: { chatterSuppression: true, suppressionAudit: true, isa182Attributes: true },
    variants: capacityLadder('TB-HMI-8200', 169000, 389000, 819000),
  },
  {
    sku: 'TB-HMI-8300',
    name: 'Facet Recipe Manager',
    slug: 'facet-recipe-manager',
    category: 'HMI & SCADA Middleware',
    description:
      'Stores recipes outside the controller and downloads them as a verified transaction — write, read back, compare, then release — rather than as an optimistic block write. Every download is recorded with the operator, the recipe version and the values actually confirmed in the controller.',
    protocols: ['OPC UA', 'EtherNet/IP', 'S7comm', 'Modbus TCP'],
    vendorCompat: ['Allen-Bradley', 'ControlLogix', 'Siemens', 'SIMATIC'],
    licenseType: 'perpetual',
    specs: { verifiedDownload: true, versioning: true, auditTrail: true },
    variants: seatLadder('TB-HMI-8300', 249000, 619000),
  },
  {
    sku: 'TB-HMI-8400',
    name: 'Facet Web Dashboard Runtime',
    slug: 'facet-web-dashboard-runtime',
    category: 'HMI & SCADA Middleware',
    description:
      'Serves read-only process dashboards to a browser from an OPC UA source, for the people who need to see a line without a SCADA seat. Writes are disabled at the runtime rather than hidden in the UI, which is the difference that matters when the page is reachable from the office network.',
    protocols: ['OPC UA', 'HTTPS', 'WebSocket'],
    vendorCompat: ['generic OPC UA'],
    licenseType: 'subscription',
    specs: { readOnlyEnforced: true, ssoSupport: 'SAML, OIDC', maxViewers: 500 },
    variants: variants('TB-HMI-8400', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 29000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 290000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-HMI-8500',
    name: 'Facet Report Scheduler',
    slug: 'facet-report-scheduler',
    category: 'HMI & SCADA Middleware',
    description:
      'Generates shift, batch and downtime reports on a schedule or a trigger tag and delivers them as PDF or spreadsheet. Report definitions are files that can be kept in version control, which makes "why did this number change" answerable. Missing source data is reported in the output rather than rendered as a blank cell.',
    protocols: ['OPC UA', 'ODBC'],
    vendorCompat: ['Microsoft SQL Server', 'PostgreSQL', 'generic OPC UA'],
    licenseType: 'perpetual',
    specs: { outputs: 'PDF, XLSX, CSV', triggerTags: true, versionControlFriendly: true },
    variants: seatLadder('TB-HMI-8500', 129000, 329000),
  },
  {
    sku: 'TB-HMI-8600',
    name: 'Facet Mobile Notifier',
    slug: 'facet-mobile-notifier',
    category: 'HMI & SCADA Middleware',
    description:
      'Sends alarm and event notifications to phones and email with an on-call rota and acknowledgement tracking, so an unacknowledged critical alarm escalates rather than sitting in someone silenced inbox. Notification rules are evaluated server-side; nothing depends on a phone being awake.',
    protocols: ['OPC UA A&C', 'SMTP', 'HTTPS'],
    vendorCompat: ['generic OPC UA', 'generic SCADA'],
    licenseType: 'subscription',
    specs: { escalation: true, onCallRota: true, ackTracking: true },
    variants: variants('TB-HMI-8600', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 12000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 120000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-HMI-8700',
    name: 'Facet Tag Import Toolkit',
    slug: 'facet-tag-import-toolkit',
    category: 'HMI & SCADA Middleware',
    description:
      'Builds an address space from what the plant already has — an L5X export, a TIA Portal export, a Modbus register spreadsheet, an existing OPC server browse — instead of retyping it. Import runs produce a diff against the current configuration, so a controller program change shows up as a reviewable list rather than a surprise.',
    protocols: ['OPC UA', 'EtherNet/IP', 'S7comm', 'Modbus TCP'],
    vendorCompat: ['Allen-Bradley', 'Rockwell Automation', 'Siemens', 'TIA Portal', 'Studio 5000'],
    licenseType: 'perpetual',
    specs: { importFormats: 'L5X, TIA export, CSV, browse', diffOnImport: true },
    variants: seatLadder('TB-HMI-8700', 89000, 239000),
  },

  /* ------------------------------------- Redundancy and Availability */
  {
    sku: 'TB-RED-9100',
    name: 'Keystone Redundancy Module for OPC UA',
    slug: 'keystone-redundancy-module-opc-ua',
    category: 'Redundancy & Availability',
    description:
      'Runs a second OPC UA server as a hot standby with configuration mirrored from the primary, and fails over on a health rule you define rather than on a bare TCP timeout. Clients follow the failover through the OPC UA redundancy model where they support it, and through a virtual endpoint where they do not.',
    protocols: ['OPC UA'],
    vendorCompat: ['generic OPC UA', 'Allen-Bradley', 'Siemens'],
    licenseType: 'perpetual',
    specs: { mode: 'hot standby', failoverTime: '<2s', configMirroring: true, virtualEndpoint: true },
    variants: seatLadder('TB-RED-9100', 349000, 849000),
  },
  {
    sku: 'TB-RED-9200',
    name: 'Keystone Redundancy Module for Modbus',
    slug: 'keystone-redundancy-module-modbus',
    category: 'Redundancy & Availability',
    description:
      'Handles dual-path Modbus TCP where a device is reachable on two networks, and dual-device where two units mirror each other. Path health is judged on response quality as well as reachability, because a device that answers with stale data is the case that costs you. Switchover is logged with the evidence that triggered it.',
    protocols: ['Modbus TCP', 'Modbus RTU'],
    vendorCompat: ['generic Modbus', 'Schneider Electric', 'Modicon'],
    licenseType: 'perpetual',
    specs: { dualPath: true, dualDevice: true, healthCriteria: 'reachability + quality' },
    variants: seatLadder('TB-RED-9200', 279000, 679000),
  },
  {
    sku: 'TB-RED-9300',
    name: 'Keystone Store and Forward Service',
    slug: 'keystone-store-and-forward-service',
    category: 'Redundancy & Availability',
    description:
      'A shared buffering service that any TagBridge connector can write through, so store-and-forward behaviour is configured and monitored in one place instead of six. Buffer depth, oldest unsent record and drain rate are exposed as metrics, which turns "are we losing data" into a number on a dashboard.',
    protocols: ['OPC UA', 'ODBC', 'MQTT'],
    vendorCompat: ['TagBridge connectors'],
    licenseType: 'perpetual',
    specs: { sharedBuffer: true, metricsExposed: true, maxRetention: '30d' },
    variants: seatLadder('TB-RED-9300', 199000, 489000),
  },
  {
    sku: 'TB-RED-9400',
    name: 'Keystone Watchdog and Failover Controller',
    slug: 'keystone-watchdog-failover-controller',
    category: 'Redundancy & Availability',
    description:
      'Watches connector processes, controller heartbeats and data staleness together, and acts on the combination — a process that is running but has not produced a new value in four minutes is treated as failed. Actions are restart, fail over, or notify only, chosen per rule so a site can start conservatively.',
    protocols: ['OPC UA', 'HTTPS'],
    vendorCompat: ['TagBridge connectors', 'generic OPC UA'],
    licenseType: 'perpetual',
    specs: { stalenessDetection: true, actions: 'restart, failover, notify', ruleScoped: true },
    variants: seatLadder('TB-RED-9400', 159000, 399000),
  },
  {
    sku: 'TB-RED-9500',
    name: 'Keystone Configuration Sync',
    slug: 'keystone-configuration-sync',
    category: 'Redundancy & Availability',
    description:
      'Keeps configuration identical across a redundant pair or a fleet of edge nodes, with a signed manifest and an explicit apply step rather than silent live replication. Drift between intended and running configuration is reported per node, which is usually how a failover discovers it was never going to work.',
    protocols: ['HTTPS'],
    vendorCompat: ['TagBridge connectors'],
    licenseType: 'subscription',
    specs: { signedManifest: true, driftReporting: true, stagedApply: true },
    variants: variants('TB-RED-9500', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 22000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 220000, billingInterval: 'annual' },
    ]),
  },

  /* ------------------------------------------ Diagnostics and Tooling */
  {
    sku: 'TB-DIAG-9600',
    name: 'Probe OPC UA Client and Test Tool',
    slug: 'probe-opc-ua-client-test-tool',
    category: 'Diagnostics & Tooling',
    description:
      'A client for proving whether the problem is the server, the network or the consumer. Browse, read, write, subscribe, and watch the actual message exchange including chunking and security handshake failures, which is where most "it will not connect" tickets are actually resolved.',
    protocols: ['OPC UA', 'OPC DA'],
    vendorCompat: ['generic OPC UA', 'generic OPC DA'],
    licenseType: 'perpetual',
    specs: { messageLevelView: true, certificateTools: true, scripting: true },
    variants: variants('TB-DIAG-9600', [
      { suffix: 'SGL', tier: 'Single seat', tagCapacity: null, listPriceCents: 49000 },
      { suffix: 'SITE', tier: 'Site licence', tagCapacity: null, listPriceCents: 249000 },
    ]),
  },
  {
    sku: 'TB-DIAG-9700',
    name: 'Probe Modbus Scanner',
    slug: 'probe-modbus-scanner',
    category: 'Diagnostics & Tooling',
    description:
      'Sweeps a Modbus network for responding unit IDs and readable register ranges, then reports what it found as a starting register map. Interprets a range four ways at once — signed, unsigned, float, swapped — so the correct word order is chosen by looking at plausible values rather than by trial and error.',
    protocols: ['Modbus TCP', 'Modbus RTU', 'Modbus ASCII'],
    vendorCompat: ['generic Modbus'],
    licenseType: 'perpetual',
    specs: { wordOrderInference: true, mapExport: 'CSV', serialAndTcp: true },
    variants: variants('TB-DIAG-9700', [
      { suffix: 'SGL', tier: 'Single seat', tagCapacity: null, listPriceCents: 29000 },
      { suffix: 'SITE', tier: 'Site licence', tagCapacity: null, listPriceCents: 149000 },
    ]),
  },
  {
    sku: 'TB-DIAG-9800',
    name: 'Probe EtherNet/IP Explorer',
    slug: 'probe-ethernet-ip-explorer',
    category: 'Diagnostics & Tooling',
    description:
      'Lists CIP devices on a subnet, walks the object model, and reads controller tags without Studio 5000 installed. Connection counts and CPU load on the target are reported alongside, which answers the question of whether one more connection is safe before it is opened.',
    protocols: ['EtherNet/IP', 'CIP'],
    vendorCompat: ['Allen-Bradley', 'Rockwell Automation', 'ControlLogix', 'CompactLogix'],
    licenseType: 'perpetual',
    specs: { connectionBudgetView: true, tagBrowse: true, objectModelWalk: true },
    variants: variants('TB-DIAG-9800', [
      { suffix: 'SGL', tier: 'Single seat', tagCapacity: null, listPriceCents: 39000 },
      { suffix: 'SITE', tier: 'Site licence', tagCapacity: null, listPriceCents: 199000 },
    ]),
  },
  {
    sku: 'TB-DIAG-9900',
    name: 'Probe Network Load Analyser',
    slug: 'probe-network-load-analyser',
    category: 'Diagnostics & Tooling',
    description:
      'Estimates and then measures the traffic a polling configuration generates, per device and per protocol. Given a proposed tag list and update rate it reports the expected packets per second before deployment, which is a cheaper way to find an unworkable scan class than commissioning week.',
    protocols: ['EtherNet/IP', 'Modbus TCP', 'S7comm', 'OPC UA'],
    vendorCompat: ['Allen-Bradley', 'Siemens', 'generic Modbus'],
    licenseType: 'perpetual',
    specs: { preDeploymentEstimate: true, liveMeasurement: true, perDeviceBreakdown: true },
    variants: seatLadder('TB-DIAG-9900', 79000, 219000),
  },
  {
    sku: 'TB-DIAG-9950',
    name: 'Probe Certificate Manager',
    slug: 'probe-certificate-manager',
    category: 'Diagnostics & Tooling',
    description:
      'Issues, trusts, renews and revokes the application certificates an OPC UA estate depends on, and warns before expiry rather than after a failed reconnect at 3am. Trust lists on remote machines are reconciled from one console, including the rejected-certificate folders that are usually the actual blocker.',
    protocols: ['OPC UA', 'X.509'],
    vendorCompat: ['generic OPC UA'],
    licenseType: 'subscription',
    specs: { expiryWarning: '60d', trustListReconciliation: true, revocation: true },
    variants: variants('TB-DIAG-9950', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 14000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 140000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-DIAG-9960',
    name: 'Probe Tag Quality Monitor',
    slug: 'probe-tag-quality-monitor',
    category: 'Diagnostics & Tooling',
    description:
      'Tracks OPC quality codes, staleness and value distribution per tag and reports the ones that are technically good but practically wrong — flatlined analogues, values pinned at a range limit, timestamps that never advance. These are the faults a connector reports as healthy.',
    protocols: ['OPC UA', 'OPC DA'],
    vendorCompat: ['generic OPC UA', 'generic OPC DA'],
    licenseType: 'subscription',
    specs: { flatlineDetection: true, stalenessDetection: true, rangePinDetection: true },
    variants: variants('TB-DIAG-9960', [
      { suffix: 'M', tier: 'Monthly', tagCapacity: null, listPriceCents: 18000, billingInterval: 'monthly' },
      { suffix: 'A', tier: 'Annual', tagCapacity: null, listPriceCents: 180000, billingInterval: 'annual' },
    ]),
  },
  {
    sku: 'TB-DIAG-9970',
    name: 'Probe Commissioning Recorder',
    slug: 'probe-commissioning-recorder',
    category: 'Diagnostics & Tooling',
    description:
      'Records every read, write and configuration change during a commissioning window and produces a signed record of what was done. Built for regulated sites where the alternative is a paper log filled in from memory at the end of a long day.',
    protocols: ['OPC UA', 'EtherNet/IP', 'Modbus TCP', 'S7comm'],
    vendorCompat: ['Allen-Bradley', 'Siemens', 'generic Modbus'],
    licenseType: 'perpetual',
    specs: { signedRecord: true, exportFormats: 'PDF, CSV', part11Oriented: true },
    variants: seatLadder('TB-DIAG-9970', 139000, 349000),
  },
];

export const SEED_PRODUCT_COUNT = SEED_PRODUCTS.length;
